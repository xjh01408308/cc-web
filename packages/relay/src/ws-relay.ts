import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import type { BrowserCommand, LocalEvent, LocalControl } from './types.js';
import { BrowserCommandType, LocalCommandType, LocalEventType, BrowserEventType, LocalControlType } from './types.js';
import { ConnStates } from './conn-state.js';
import { NodeRegistry, type NodeConn, type NodeSummary } from './node-registry.js';
import { SessionRouter } from './session-router.js';
import { RequestMatcher } from './request-matcher.js';
import { NodeStore } from './node-store.js';
import { AssignmentStore } from './assignment-store.js';
import { filterVisibleNodes, canOperateNode } from './authz.js';
import type { UserRole } from './user-store.js';
import { RELAY_PING_INTERVAL_MS, RELAY_LOCAL_IDLE_TIMEOUT_MS } from './config.js';

/** browser WS 连接携带的登录用户身份（index.ts 在 WS 握手处从 session 读出后注入）。 */
export interface BrowserSession {
  userId: string;
  username: string;
  role: UserRole;
}

/**
 * 未显式传 session 时的默认身份：synthetic admin（全访问）。
 * 生产路径 index.ts 总是传真实 session；此默认仅用于：
 *   - 旧式 RELAY_BROWSER_TOKEN 回退（非浏览器客户端，无 session）
 *   - 连接处理层单测（不关心授权、只验路由的用例）
 * 默认为 admin 与改造前行为一致（见 all nodes / 全放行）。
 */
const ANONYMOUS_ADMIN: BrowserSession = { userId: '', username: '', role: 'admin' };

/** admin 调用 filterVisibleNodes 时传入的占位空集（admin 分支不读它，省一次 DB 查询）。 */
const EMPTY_NODE_SET = new Set<string>();

// browser↔relay 心跳间隔（协议级 ws.ping()，浏览器自动回 pong）。
// Node↔Relay 心跳已改为 config 驱动（RELAY_PING_INTERVAL_MS，见 T7/#26）；browser 心跳不在此次范围。
const PING_INTERVAL_MS = 30000;
const HTTP_REQUEST_TIMEOUT_MS = 5000;
const BROWSER_REQUEST_TIMEOUT_MS = 10000;

/**
 * ConnectionHandler —— 原 724 行单文件的连接处理层，瘦身后仅负责：
 *   - WS 连接生命周期（建立 / 断开清理 / 心跳）
 *   - 浏览器←→本地消息的双向 switch 路由
 *   - 认证速率限制
 * 节点 / 会话订阅 / 请求匹配 / 连接附加状态分别下沉到 NodeRegistry / SessionRouter /
 * RequestMatcher / ConnStates 四个可独立单测的深 module，本类只做组合与传输动作。
 *
 * 导出为 class 是为了让连接处理可独立 new 出来测；模块级单例 relay + 5 个薄委托函数
 * 保持 index.ts 的对外调用面不变。
 */
export class ConnectionHandler {
  private readonly nodeStore: NodeStore;
  private readonly assignmentStore: AssignmentStore;
  private readonly states = new ConnStates();
  private readonly nodes = new NodeRegistry();
  private readonly router = new SessionRouter(
    (ws, data) => this.send(ws, data),
    (ws) => this.nodes.selectedNodeOfBrowser(ws),
  );
  private readonly matcher = new RequestMatcher();

  /**
   * nodeStore 用于 local 注册时校验预注册凭证（nodeId + nodeSecret，见 ADR-0004）；
   * assignmentStore 用于操作授权判定（Assignment，见 ADR-0005）与按用户过滤节点列表。
   * 注入而非模块内创建，便于 index.ts 作组合根、单测传临时 store。
   */
  constructor(nodeStore: NodeStore, assignmentStore: AssignmentStore) {
    this.nodeStore = nodeStore;
    this.assignmentStore = assignmentStore;
  }

  // ---- 传输原语 ----

  private send(ws: WebSocket, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  private broadcastNodesList(): void {
    // 每 browser 一份按其用户过滤后的节点列表（admin 全部；user 仅 assigned ∩ online）。
    this.router.broadcastPerBrowser((ws) => ({ type: BrowserEventType.NodesList, nodes: this.visibleNodesFor(ws) }));
  }

  /** 某 browser 可见的在线节点：解析其身份后委托 getOnlineNodesForUser（admin 全部；user assigned ∩ online）。 */
  private visibleNodesFor(ws: WebSocket): NodeSummary[] {
    const st = this.states.get(ws);
    return this.getOnlineNodesForUser(st?.userId ?? '', st?.role ?? 'admin');
  }

  private sendNodesListTo(ws: WebSocket): void {
    this.send(ws, { type: BrowserEventType.NodesList, nodes: this.visibleNodesFor(ws) });
  }

  /**
   * 操作授权判定（Assignment，见 ADR-0005）：admin → 恒 true；user → 须被分配该 node。
   */
  private canWsOperate(ws: WebSocket, nodeId: string): boolean {
    const st = this.states.get(ws);
    const role = st?.role ?? 'admin';
    if (role === 'admin') return true;
    return canOperateNode(role, nodeId, new Set(this.assignmentStore.assignedNodeIds(st?.userId ?? '')));
  }

  /**
   * 类 A（按 msg.nodeId / 自动选择）目标解析 + 授权一体收口，消除 8 处重复。
   * 文案差异来自原代码的分支不一致，用 opts 精确复刻：
   *   - noSelectionError 提供 → no-selection 回该 error（Chat「未选择节点，请先选择节点」、其余「未选择节点」）；省略则静默
   *   - offlineError=true → offline 回「节点 X 已离线」（仅 Chat/CreateSession）；省略则静默（ListSessions 等的原 quirk）
   * 命中且已授权返回 conn；否则已自行回复错误并返回 null（调用方 return）。
   */
  private resolveAuthedTarget(
    ws: WebSocket,
    explicitNodeId: string | undefined,
    opts: { noSelectionError?: string; offlineError?: boolean },
  ): NodeConn | null {
    const r = this.nodes.resolveTarget(ws, explicitNodeId);
    if (!r.ok) {
      if (r.reason === 'no-selection') {
        if (opts.noSelectionError !== undefined) this.send(ws, { type: BrowserEventType.Error, error: opts.noSelectionError });
      } else if (opts.offlineError) {
        this.send(ws, { type: BrowserEventType.Error, error: `节点 ${r.nodeId} 已离线` });
      }
      return null;
    }
    if (!this.canWsOperate(ws, r.nodeId)) {
      this.send(ws, { type: BrowserEventType.Error, error: `无权访问节点 ${r.nodeId}` });
      return null;
    }
    return r.conn;
  }

  /** 类 B（按会话找节点）目标解析：会话有绑定节点即用（离线则不执行），无绑定才 fallback 到 browser 选择 */
  private resolveForSession(ws: WebSocket, sessionId: string | undefined): NodeConn | null {
    if (!sessionId) return null;
    const bySession = this.nodes.nodeForSession(sessionId);
    let targetNodeId: string | undefined;
    if (bySession) {
      targetNodeId = bySession; // 即便离线也认 —— get 返回 undefined → 返回 null（与原 localNodes.get 离线静默一致）
    } else {
      const r = this.nodes.resolveTarget(ws);
      targetNodeId = r.ok ? r.nodeId : undefined;
    }
    return targetNodeId ? (this.nodes.get(targetNodeId) ?? null) : null;
  }

  // ---- 浏览器消息处理 ----

  private handleBrowserMessage(ws: WebSocket, msg: BrowserCommand): void {
    switch (msg.type) {
      case BrowserCommandType.SelectNode: {
        const nodeId = msg.nodeId;
        // 不在线 或 未授权（未分配）→ 同样回「不在线」，避免成为节点存在性探测口（未分配完全不可见）。
        if (!nodeId || !this.nodes.has(nodeId) || !this.canWsOperate(ws, nodeId)) {
          this.send(ws, { type: BrowserEventType.Error, error: `节点 ${nodeId} 不在线` });
          return;
        }
        this.nodes.selectNodeForBrowser(ws, nodeId);
        this.send(ws, { type: BrowserEventType.NodeSelected, nodeId });
        return;
      }

      case BrowserCommandType.ListNodes: {
        this.sendNodesListTo(ws);
        return;
      }

      case BrowserCommandType.Chat: {
        const conn = this.resolveAuthedTarget(ws, msg.nodeId, { noSelectionError: '未选择节点，请先选择节点', offlineError: true });
        if (!conn) return;
        if (msg.sessionId) {
          this.router.subscribe(msg.sessionId, ws);
          this.states.setSessionId(ws, msg.sessionId);
        }
        this.send(conn.ws, { type: LocalCommandType.Chat, sessionId: msg.sessionId, text: msg.text, permissionMode: msg.permissionMode, projectPath: msg.projectPath });
        break;
      }

      case BrowserCommandType.CreateSession: {
        const conn = this.resolveAuthedTarget(ws, msg.nodeId, { noSelectionError: '未选择节点', offlineError: true });
        if (!conn) return;
        this.send(conn.ws, { type: LocalCommandType.CreateSession, projectPath: msg.projectPath, projectId: msg.projectId, model: msg.model, permissionMode: msg.permissionMode });
        break;
      }

      case BrowserCommandType.StopSession: {
        const conn = this.resolveForSession(ws, msg.sessionId);
        if (conn) {
          if (!this.canWsOperate(ws, conn.nodeId)) {
            this.send(ws, { type: BrowserEventType.Error, error: `无权访问节点 ${conn.nodeId}` });
            return;
          }
          this.send(conn.ws, { type: LocalCommandType.StopSession, sessionId: msg.sessionId });
        }
        break;
      }

      case BrowserCommandType.DeleteSession: {
        const conn = this.resolveForSession(ws, msg.sessionId);
        if (conn) {
          if (!this.canWsOperate(ws, conn.nodeId)) {
            this.send(ws, { type: BrowserEventType.Error, error: `无权访问节点 ${conn.nodeId}` });
            return;
          }
          this.send(conn.ws, { type: LocalCommandType.DeleteSession, sessionId: msg.sessionId });
        }
        break;
      }

      case BrowserCommandType.ListSessions: {
        const conn = this.resolveAuthedTarget(ws, msg.nodeId, { noSelectionError: '未选择节点' });
        if (!conn) return;
        this.send(conn.ws, { type: LocalCommandType.ListSessions, projectId: msg.projectId, _reqId: this.matcher.registerBrowser(ws, 'list_sessions', BROWSER_REQUEST_TIMEOUT_MS) });
        break;
      }

      case BrowserCommandType.CreateProject: {
        const conn = this.resolveAuthedTarget(ws, msg.nodeId, { noSelectionError: '未选择节点' });
        if (!conn) return;
        this.send(conn.ws, { type: LocalCommandType.CreateProject, name: msg.name, path: msg.path, _reqId: this.matcher.registerBrowser(ws, 'create_project', BROWSER_REQUEST_TIMEOUT_MS) });
        break;
      }

      case BrowserCommandType.DeleteProject: {
        const conn = this.resolveAuthedTarget(ws, msg.nodeId, { noSelectionError: '未选择节点' });
        if (!conn) return;
        this.send(conn.ws, { type: LocalCommandType.DeleteProject, projectId: msg.projectId });
        break;
      }

      case BrowserCommandType.ListProjects: {
        const conn = this.resolveAuthedTarget(ws, msg.nodeId, { noSelectionError: '未选择节点' });
        if (!conn) return;
        this.send(conn.ws, { type: LocalCommandType.ListProjects, _reqId: this.matcher.registerBrowser(ws, 'list_projects', BROWSER_REQUEST_TIMEOUT_MS) });
        break;
      }

      case BrowserCommandType.ChangePermissionMode: {
        const conn = this.resolveForSession(ws, msg.sessionId);
        if (conn) {
          if (!this.canWsOperate(ws, conn.nodeId)) {
            this.send(ws, { type: BrowserEventType.Error, error: `无权访问节点 ${conn.nodeId}` });
            return;
          }
          this.send(conn.ws, { type: LocalCommandType.ChangePermissionMode, sessionId: msg.sessionId, permissionMode: msg.permissionMode });
        }
        break;
      }

      case BrowserCommandType.RetryWithPermission: {
        const conn = this.resolveForSession(ws, msg.sessionId);
        if (conn) {
          if (!this.canWsOperate(ws, conn.nodeId)) {
            this.send(ws, { type: BrowserEventType.Error, error: `无权访问节点 ${conn.nodeId}` });
            return;
          }
          this.send(conn.ws, { type: LocalCommandType.RetryWithPermission, sessionId: msg.sessionId, permissionMode: msg.permissionMode });
        }
        break;
      }

      case BrowserCommandType.GetGitStatus: {
        const conn = this.resolveAuthedTarget(ws, msg.nodeId, { noSelectionError: '未选择节点' });
        if (!conn) return;
        this.send(conn.ws, { type: LocalCommandType.GetGitStatus, projectPath: msg.projectPath, projectId: msg.projectId, _reqId: this.matcher.registerBrowser(ws, 'get_git_status', BROWSER_REQUEST_TIMEOUT_MS) });
        break;
      }

      case BrowserCommandType.GetGitDiff: {
        const conn = this.resolveAuthedTarget(ws, msg.nodeId, { noSelectionError: '未选择节点' });
        if (!conn) return;
        this.send(conn.ws, { type: LocalCommandType.GetGitDiff, projectPath: msg.projectPath, filePath: msg.filePath, staged: msg.staged, _reqId: this.matcher.registerBrowser(ws, 'get_git_diff', BROWSER_REQUEST_TIMEOUT_MS) });
        break;
      }

      case BrowserCommandType.GetFileTree: {
        const conn = this.resolveAuthedTarget(ws, msg.nodeId, { noSelectionError: '未选择节点' });
        if (!conn) return;
        this.send(conn.ws, { type: LocalCommandType.GetFileTree, projectPath: msg.projectPath, projectId: msg.projectId, _reqId: this.matcher.registerBrowser(ws, 'get_file_tree', BROWSER_REQUEST_TIMEOUT_MS) });
        break;
      }

      case BrowserCommandType.GetFileContent: {
        const conn = this.resolveAuthedTarget(ws, msg.nodeId, { noSelectionError: '未选择节点' });
        if (!conn) return;
        this.send(conn.ws, { type: LocalCommandType.GetFileContent, projectPath: msg.projectPath, filePath: msg.filePath, _reqId: this.matcher.registerBrowser(ws, 'get_file_content', BROWSER_REQUEST_TIMEOUT_MS) });
        break;
      }
    }
  }

  // ---- HTTP API：向指定/任一节点发请求 ----

  requestLocal(data: Record<string, unknown>, nodeId?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let targetWs: WebSocket | null = null;
      if (nodeId) {
        targetWs = this.nodes.get(nodeId)?.ws ?? null;
      } else if (this.nodes.size > 0) {
        targetWs = this.nodes.anyConn()!.ws;
      }

      if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
        reject(new Error(nodeId ? `节点 ${nodeId} 未连接` : '没有在线的本地节点'));
        return;
      }
      const reqId = randomUUID();
      this.matcher.register(reqId, resolve);
      this.send(targetWs, { ...data, _reqId: reqId });
      setTimeout(() => {
        if (this.matcher.has(reqId)) {
          this.matcher.take(reqId);
          reject(new Error('请求超时'));
        }
      }, HTTP_REQUEST_TIMEOUT_MS);
    });
  }

  /** HTTP /api/nodes 用：按登录用户过滤的在线节点（admin 全部；user assigned ∩ online）。 */
  getOnlineNodesForUser(userId: string, role: UserRole): NodeSummary[] {
    const assigned = role === 'admin' ? EMPTY_NODE_SET : new Set(this.assignmentStore.assignedNodeIds(userId));
    return filterVisibleNodes(this.nodes.listNodes(), role, assigned);
  }

  // ---- 本地服务消息处理 ----

  private handleLocalMessage(ws: WebSocket, msg: LocalEvent): void {
    // local 每发一条消息（含 pong）都更新活跃时间，供心跳做链路假死检测
    this.states.touch(ws);
    // HTTP API 响应匹配
    const reqId = (msg as unknown as Record<string, unknown>)._reqId as string | undefined;
    if (reqId) {
      const httpCb = this.matcher.take(reqId);
      if (httpCb) {
        httpCb(msg);
        return;
      }
      // 浏览器请求-响应匹配：去掉 _reqId，附 nodeId 后回给发起 browser
      const entry = this.matcher.takeBrowser(reqId);
      if (entry) {
        const { _reqId: _, ...response } = msg as unknown as Record<string, unknown>;
        const nodeId = this.states.getNodeId(ws);
        this.send(entry.ws, { ...response, nodeId });
        return;
      }
    }

    switch (msg.type) {
      case LocalEventType.Register: {
        const st = this.states.get(ws);
        const ip = st?.ip ?? '?';
        const nodeId = msg.nodeId || '';
        const nodeSecret = msg.nodeSecret || '';
        // 校验预注册凭证（nodeId + nodeSecret，见 ADR-0004）：未预注册或 secret 错一律拒绝，
        // 文案不区分两种情况（避免 nodeId 枚举）。relay→local 拒绝信号（local 端据其停止重连），
        // 不属于 4 向协议 union。
        if (!this.nodeStore.verifyNodeSecret(nodeId, nodeSecret)) {
          console.warn(`[relay] 节点注册认证失败: 未预注册或 nodeSecret 不正确 | IP: ${ip} | 声称 nodeId: ${nodeId || 'unknown'}`);
          this.send(ws, { type: 'error', error: '认证失败：节点未预注册或 nodeSecret 不正确' });
          ws.close();
          return;
        }
        const replaced = this.nodes.register(nodeId, { ws, nodeId, workspaceRoot: msg.workspaceRoot });
        if (replaced) {
          const oldSt = this.states.get(replaced.ws);
          const oldIp = oldSt?.ip ?? '?';
          if (oldIp !== ip) {
            console.error(`[SECURITY] 节点 ${nodeId} 从不同 IP 重连: ${oldIp} -> ${ip}，可能存在接管风险`);
          }
          const oldStart = oldSt?.connectedAt;
          const oldDuration = oldStart ? `${((Date.now() - oldStart) / 1000).toFixed(1)}s` : '?';
          console.log(`[relay] 节点 ${nodeId} 重连，替换旧连接 | IP: ${ip} | 旧连接持续: ${oldDuration}`);
          replaced.ws.close();
        }
        this.states.setNodeId(ws, nodeId);
        console.log(`[relay] 节点已注册: ${nodeId} | IP: ${ip} | 在线节点: ${this.nodes.size}`);
        this.send(ws, { type: LocalControlType.Registered });
        this.broadcastNodesList();
        break;
      }

      case LocalEventType.Pong:
        break;

      case LocalEventType.SessionInfo: {
        if (msg.sessionId) {
          const nodeId = this.states.getNodeId(ws);
          if (nodeId) {
            this.nodes.bindSession(msg.sessionId, nodeId);
            this.router.broadcastToNodeBrowsers(nodeId, { ...msg, nodeId });
          }
        }
        break;
      }

      case LocalEventType.ClaudeJson:
      case LocalEventType.Done:
      case LocalEventType.Error:
      case LocalEventType.Aborted:
      case LocalEventType.SessionEnd: {
        if (msg.sessionId) {
          const subType = msg.type === LocalEventType.ClaudeJson && msg.data && typeof msg.data === 'object'
            ? (msg.data as { type?: string }).type
            : '';
          const subCount = this.router.subscribersOf(msg.sessionId);
          console.log(`[relay] 收到 ${msg.type}${subType ? '/' + subType : ''} sessionId=${(msg.sessionId || '').substring(0, 8)}, 浏览器数=${subCount}`);
          if (subCount > 0) {
            this.router.broadcastToSession(msg.sessionId, msg);
          } else {
            const nodeId = this.states.getNodeId(ws);
            console.warn(`[relay] 丢弃无订阅者的会话消息: ${msg.type} sessionId=${msg.sessionId.substring(0, 8)} nodeId=${nodeId}`);
          }
        } else {
          const nodeId = this.states.getNodeId(ws);
          console.warn(`[relay] 缺少 sessionId，无法转发: ${msg.type} | 来源节点: ${nodeId}`);
        }
        break;
      }

      case LocalEventType.SessionsList:
      case LocalEventType.ProjectsList:
      case LocalEventType.ProjectInfo:
      case LocalEventType.GitStatus:
      case LocalEventType.GitDiff:
      case LocalEventType.FileTree:
      case LocalEventType.FileContent: {
        const nodeId = this.states.getNodeId(ws);
        if (!nodeId) break;
        const { _reqId: _, ...broadcastMsg } = msg as unknown as Record<string, unknown>;
        this.router.broadcastToNodeBrowsers(nodeId, { ...broadcastMsg, nodeId });
        break;
      }
    }
  }

  // ---- 连接管理 ----

  handleBrowserConnection(ws: WebSocket, ip: string, session: BrowserSession = ANONYMOUS_ADMIN): void {
    this.states.init(ws, ip);
    this.states.setBrowserUser(ws, session.userId, session.role);
    this.router.addBrowser(ws);
    this.nodes.forgetBrowser(ws); // 清掉可能残留的选中态（原 browserNodeMap.delete(ws)）
    console.log(`[relay] 浏览器已连接 | IP: ${ip} | user: ${session.username || '(匿名)'} | 在线: ${this.router.size}`);

    // 通知当前节点列表（按该用户过滤：admin 全部；user 仅 assigned ∩ online）
    const visible = this.visibleNodesFor(ws);
    if (visible.length > 0) {
      this.send(ws, { type: BrowserEventType.NodesList, nodes: visible });
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleBrowserMessage(ws, msg as BrowserCommand);
      } catch {
        console.warn(`[relay] 浏览器消息解析失败 | IP: ${ip}`);
      }
    });

    ws.on('close', (code) => {
      clearInterval(heartbeat);
      const st = this.states.get(ws);
      const duration = st ? `${((Date.now() - st.connectedAt) / 1000).toFixed(1)}s` : '?';
      this.router.removeBrowser(ws);
      this.nodes.forgetBrowser(ws);
      this.matcher.forgetBrowser(ws);
      console.log(`[relay] 浏览器已断开 | IP: ${ip} | 持续: ${duration} | closeCode: ${code} | 在线: ${this.router.size}`);
    });

    ws.on('error', (err) => {
      console.error(`[relay] 浏览器连接错误 | IP: ${ip} | ${err.message}`);
    });

    // 心跳保活（协议级 ping，浏览器自动响应 pong）
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clearInterval(heartbeat);
      }
    }, PING_INTERVAL_MS);
  }

  handleLocalConnection(ws: WebSocket, ip: string): void {
    this.states.init(ws, ip);
    console.log(`[relay] 本地服务连接请求 | IP: ${ip}`);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleLocalMessage(ws, msg as LocalEvent);
      } catch {
        console.warn(`[relay] 本地消息解析失败 | IP: ${ip}`);
      }
    });

    ws.on('close', (code, reason) => {
      clearInterval(heartbeat);
      const st = this.states.get(ws);
      const duration = st ? `${((Date.now() - st.connectedAt) / 1000).toFixed(1)}s` : '?';
      const reasonStr = reason ? Buffer.from(reason).toString('utf-8').substring(0, 100) : '(无)';
      const nodeId = st?.nodeId; // undefined = 尚未 register（原 'pending'）
      if (nodeId && this.nodes.get(nodeId)?.ws === ws) {
        this.nodes.unregister(nodeId);
        console.log(`[relay] 节点已断开: ${nodeId} | IP: ${ip} | 持续: ${duration} | closeCode: ${code} | reason: ${reasonStr} | 在线节点: ${this.nodes.size}`);

        // 清理该节点的会话映射，并广播断连 error
        for (const sid of this.nodes.forgetSessionsOfNode(nodeId)) {
          this.router.broadcastToSession(sid, { type: BrowserEventType.Error, error: `节点 ${nodeId} 已断开` });
        }

        this.broadcastNodesList();
      }
    });

    ws.on('error', (err) => {
      console.error(`[relay] 本地连接错误 | IP: ${ip} | ${err.message}`);
    });

    // 心跳 + 链路假死检测
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        this.send(ws, { type: LocalControlType.Ping });
        // 跨公网链路可能 TCP 假死（local 侧 ws 仍 OPEN，故 local 端无重连日志）：
        // 超过 RELAY_LOCAL_IDLE_TIMEOUT_MS（可配）没收到 local 任何消息 → 主动关闭，触发 local
        // ws-client 重连重建一条干净链路；否则 relay 会一直往死连接上发命令必然超时
        const last = this.states.lastSeenOf(ws);
        if (last && Date.now() - last >= RELAY_LOCAL_IDLE_TIMEOUT_MS) {
          const idle = Math.round((Date.now() - last) / 1000);
          console.warn(`[relay] local 链路假死（${idle}s 无消息），主动关闭重建 | IP: ${ip}`);
          clearInterval(heartbeat);
          ws.close();
          return;
        }
      } else {
        clearInterval(heartbeat);
      }
    }, RELAY_PING_INTERVAL_MS);
  }
}

// ---- 模块级单例 + 5 个对外委托函数（保持 index.ts 调用面不变）----
//
// index.ts 是组合根：创建 NodeStore 后经 initRelay 注入。initRelay 在 server.listen 前必先调用，
// 故 wrapper 函数对 relay 用 ! 断言——等价于原模块级 const relay = new ConnectionHandler() 的时序保证。

let relay: ConnectionHandler | undefined;

export function initRelay(nodeStore: NodeStore, assignmentStore: AssignmentStore): void {
  relay = new ConnectionHandler(nodeStore, assignmentStore);
}

export function handleBrowserConnection(ws: WebSocket, ip: string, session?: BrowserSession): void {
  relay!.handleBrowserConnection(ws, ip, session);
}

export function handleLocalConnection(ws: WebSocket, ip: string): void {
  relay!.handleLocalConnection(ws, ip);
}

export function requestLocal(data: Record<string, unknown>, nodeId?: string): Promise<unknown> {
  return relay!.requestLocal(data, nodeId);
}

export function getOnlineNodesForUser(userId: string, role: UserRole): NodeSummary[] {
  return relay!.getOnlineNodesForUser(userId, role);
}


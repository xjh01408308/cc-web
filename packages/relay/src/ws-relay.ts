import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { RELAY_TOKEN, isDevMode, isUsingDefaultRelayToken } from './config.js';
import type { BrowserMessage, LocalMessage } from './types.js';

// ---- 多节点数据结构 ----

interface NodeInfo {
  ws: WebSocket;
  nodeId: string;
  passwordRequired: boolean;
}

const localNodes = new Map<string, NodeInfo>();       // nodeId → NodeInfo
const sessionNodeMap = new Map<string, string>();      // sessionId → nodeId
const browserNodeMap = new Map<WebSocket, string>();   // browser ws → nodeId
const authenticatedBrowsers = new Map<WebSocket, Set<string>>();  // browser ws → authenticated nodeIds

// 浏览器路由表（sessionId → browser clients）
const browserSessions = new Map<string, Set<WebSocket>>();
const allBrowsers = new Set<WebSocket>();

// 认证速率限制
const authAttempts = new Map<WebSocket, { failures: number; lastAttempt: number }>();
const MAX_AUTH_FAILURES = 5;
const AUTH_COOLDOWN_MS = 60000;

// HTTP API 请求-响应匹配
const pendingRequests = new Map<string, (data: unknown) => void>();

// 浏览器请求-响应匹配（防止响应广播到所有浏览器）
interface BrowserRequestEntry {
  ws: WebSocket;
  timeout: ReturnType<typeof setTimeout>;
  type: string;
}
const browserRequests = new Map<string, BrowserRequestEntry>();

// ---- 工具函数 ----

function send(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastToSession(sessionId: string, data: unknown): void {
  const clients = browserSessions.get(sessionId);
  if (clients) {
    for (const ws of clients) {
      send(ws, data);
    }
  }
}

function broadcastToAllBrowsers(data: unknown): void {
  for (const ws of allBrowsers) {
    send(ws, data);
  }
}

function broadcastToNodeBrowsers(nodeId: string, data: unknown): void {
  for (const ws of allBrowsers) {
    const selectedNode = browserNodeMap.get(ws);
    if (!selectedNode || selectedNode === nodeId) {
      send(ws, data);
    }
  }
}

function registerBrowserRequest(ws: WebSocket, msgType: string): string {
  const reqId = randomUUID();
  const timeout = setTimeout(() => {
    if (browserRequests.has(reqId)) {
      browserRequests.delete(reqId);
    }
  }, 10000);
  browserRequests.set(reqId, { ws, timeout, type: msgType });
  return reqId;
}

function broadcastNodesList(): void {
  const nodes: Array<{ nodeId: string; sessionCount: number; passwordRequired: boolean }> = [];
  for (const [nodeId, info] of localNodes) {
    let count = 0;
    for (const [, nid] of sessionNodeMap) {
      if (nid === nodeId) count++;
    }
    nodes.push({ nodeId, sessionCount: count, passwordRequired: info.passwordRequired });
  }
  broadcastToAllBrowsers({ type: 'nodes_list', nodes });
}

// 获取浏览器关联的节点 ID
function getNodeIdForBrowser(ws: WebSocket): string | null {
  const explicit = browserNodeMap.get(ws);
  if (explicit && localNodes.has(explicit)) return explicit;
  // 自动选择：只有一个节点时直接用
  if (localNodes.size === 1) {
    return localNodes.keys().next().value!;
  }
  return null;
}

function isAuthenticated(ws: WebSocket, nodeId: string): boolean {
  const node = localNodes.get(nodeId);
  if (!node || !node.passwordRequired) return true;
  const authedNodes = authenticatedBrowsers.get(ws);
  return authedNodes ? authedNodes.has(nodeId) : false;
}

// ---- 浏览器消息处理 ----

function handleBrowserMessage(ws: WebSocket, msg: BrowserMessage): void {
  switch (msg.type) {
    case 'select_node': {
      const nodeId = msg.nodeId as string;
      if (!nodeId || !localNodes.has(nodeId)) {
        send(ws, { type: 'error', error: `节点 ${nodeId} 不在线` });
        return;
      }
      browserNodeMap.set(ws, nodeId);
      send(ws, { type: 'node_selected', nodeId });
      return;
    }

    case 'list_nodes': {
      const nodes: Array<{ nodeId: string; sessionCount: number; passwordRequired: boolean }> = [];
      for (const [nid, info] of localNodes) {
        let count = 0;
        for (const [, nid2] of sessionNodeMap) {
          if (nid2 === nid) count++;
        }
        nodes.push({ nodeId: nid, sessionCount: count, passwordRequired: info.passwordRequired });
      }
      send(ws, { type: 'nodes_list', nodes });
      return;
    }

    case 'chat': {
      const targetNode = msg.nodeId || getNodeIdForBrowser(ws);
      if (!targetNode) {
        send(ws, { type: 'error', error: '未选择节点，请先选择节点' });
        return;
      }
      const node = localNodes.get(targetNode);
      if (!node) {
        send(ws, { type: 'error', error: `节点 ${targetNode} 已离线` });
        return;
      }
      if (!isAuthenticated(ws, targetNode)) {
        send(ws, { type: 'error', error: `节点 ${targetNode} 需要密码认证` });
        return;
      }
      // 订阅该会话
      if (msg.sessionId) {
        if (!browserSessions.has(msg.sessionId)) {
          browserSessions.set(msg.sessionId, new Set());
        }
        browserSessions.get(msg.sessionId)!.add(ws);
        (ws as unknown as Record<string, unknown>)._sessionId = msg.sessionId;
      }
      send(node.ws, { type: 'chat', sessionId: msg.sessionId, text: msg.text, permissionMode: msg.permissionMode, projectPath: msg.projectPath });
      break;
    }

    case 'create_session': {
      const targetNode = msg.nodeId || getNodeIdForBrowser(ws);
      if (!targetNode) {
        send(ws, { type: 'error', error: '未选择节点' });
        return;
      }
      const node = localNodes.get(targetNode);
      if (!node) {
        send(ws, { type: 'error', error: `节点 ${targetNode} 已离线` });
        return;
      }
      if (!isAuthenticated(ws, targetNode)) {
        send(ws, { type: 'error', error: `节点 ${targetNode} 需要密码认证` });
        return;
      }
      send(node.ws, { type: 'create_session', projectPath: msg.projectPath, projectId: msg.projectId, model: msg.model, permissionMode: msg.permissionMode });
      break;
    }

    case 'stop_session': {
      const nodeId = msg.sessionId ? sessionNodeMap.get(msg.sessionId) : null;
      const targetNode = nodeId || getNodeIdForBrowser(ws);
      if (targetNode && msg.sessionId) {
        const node = localNodes.get(targetNode);
        if (node) {
          if (!isAuthenticated(ws, targetNode)) {
            send(ws, { type: 'error', error: `节点 ${targetNode} 需要密码认证` });
            return;
          }
          send(node.ws, { type: 'stop_session', sessionId: msg.sessionId });
        }
      }
      break;
    }

    case 'delete_session': {
      const nodeId = msg.sessionId ? sessionNodeMap.get(msg.sessionId) : null;
      const targetNode = nodeId || getNodeIdForBrowser(ws);
      if (targetNode && msg.sessionId) {
        const node = localNodes.get(targetNode);
        if (node) {
          if (!isAuthenticated(ws, targetNode)) {
            send(ws, { type: 'error', error: `节点 ${targetNode} 需要密码认证` });
            return;
          }
          send(node.ws, { type: 'delete_session', sessionId: msg.sessionId });
        }
      }
      break;
    }

    case 'list_sessions': {
      const targetNode = msg.nodeId || getNodeIdForBrowser(ws);
      if (!targetNode) {
        send(ws, { type: 'error', error: '未选择节点' });
        return;
      }
      const node = localNodes.get(targetNode);
      if (!node) return;
      if (!isAuthenticated(ws, targetNode)) {
        send(ws, { type: 'error', error: `节点 ${targetNode} 需要密码认证` });
        return;
      }
      const reqId = registerBrowserRequest(ws, 'list_sessions');
      send(node.ws, { type: 'list_sessions', projectId: msg.projectId, _reqId: reqId });
      break;
    }

    case 'create_project': {
      const targetNode = msg.nodeId || getNodeIdForBrowser(ws);
      if (!targetNode) {
        send(ws, { type: 'error', error: '未选择节点' });
        return;
      }
      const node = localNodes.get(targetNode);
      if (!node) return;
      if (!isAuthenticated(ws, targetNode)) {
        send(ws, { type: 'error', error: `节点 ${targetNode} 需要密码认证` });
        return;
      }
      const reqId = registerBrowserRequest(ws, 'create_project');
      send(node.ws, { type: 'create_project', name: msg.name, path: msg.path, _reqId: reqId });
      break;
    }

    case 'delete_project': {
      const targetNode = msg.nodeId || getNodeIdForBrowser(ws);
      if (!targetNode) {
        send(ws, { type: 'error', error: '未选择节点' });
        return;
      }
      const node = localNodes.get(targetNode);
      if (!node) return;
      if (!isAuthenticated(ws, targetNode)) {
        send(ws, { type: 'error', error: `节点 ${targetNode} 需要密码认证` });
        return;
      }
      send(node.ws, { type: 'delete_project', projectId: msg.projectId });
      break;
    }

    case 'list_projects': {
      const targetNode = msg.nodeId || getNodeIdForBrowser(ws);
      if (!targetNode) {
        send(ws, { type: 'error', error: '未选择节点' });
        return;
      }
      const node = localNodes.get(targetNode);
      if (!node) return;
      if (!isAuthenticated(ws, targetNode)) {
        send(ws, { type: 'error', error: `节点 ${targetNode} 需要密码认证` });
        return;
      }
      const reqId = registerBrowserRequest(ws, 'list_projects');
      send(node.ws, { type: 'list_projects', _reqId: reqId });
      break;
    }

    case 'auth_node': {
      const authNodeId = msg.nodeId as string;
      const password = msg.password as string;

      // 速率限制检查
      const attempts = authAttempts.get(ws);
      if (attempts && attempts.failures >= MAX_AUTH_FAILURES) {
        const elapsed = Date.now() - attempts.lastAttempt;
        if (elapsed < AUTH_COOLDOWN_MS) {
          send(ws, { type: 'auth_result', nodeId: authNodeId, success: false, error: `认证失败过多，${Math.ceil((AUTH_COOLDOWN_MS - elapsed) / 1000)}秒后重试` });
          return;
        }
        attempts.failures = 0;
      }

      if (!authNodeId || !localNodes.has(authNodeId)) {
        send(ws, { type: 'error', error: `节点 ${authNodeId} 不在线` });
        return;
      }
      const authNode = localNodes.get(authNodeId)!;
      const reqId = randomUUID();
      pendingRequests.set(reqId, (resultMsg) => {
        clearTimeout(timeout);
        const result = resultMsg as LocalMessage;
        if (result.success) {
          authAttempts.delete(ws);
          if (!authenticatedBrowsers.has(ws)) {
            authenticatedBrowsers.set(ws, new Set());
          }
          authenticatedBrowsers.get(ws)!.add(authNodeId);
        } else {
          if (!authAttempts.has(ws)) authAttempts.set(ws, { failures: 0, lastAttempt: 0 });
          const att = authAttempts.get(ws)!;
          att.failures++;
          att.lastAttempt = Date.now();
        }
        send(ws, { type: 'auth_result', nodeId: authNodeId, success: result.success, error: result.error });
      });
      const timeout = setTimeout(() => {
        if (pendingRequests.has(reqId)) {
          pendingRequests.delete(reqId);
          send(ws, { type: 'auth_result', nodeId: authNodeId, success: false, error: '认证超时' });
        }
      }, 5000);
      send(authNode.ws, { type: 'auth_node', password, _reqId: reqId });
      return;
    }

    case 'change_permission_mode': {
      const nid = msg.sessionId ? sessionNodeMap.get(msg.sessionId) : null;
      const targetNode = nid || getNodeIdForBrowser(ws);
      if (targetNode && msg.sessionId) {
        const node = localNodes.get(targetNode);
        if (node) {
          if (!isAuthenticated(ws, targetNode)) {
            send(ws, { type: 'error', error: `节点 ${targetNode} 需要密码认证` });
            return;
          }
          send(node.ws, { type: 'change_permission_mode', sessionId: msg.sessionId, permissionMode: msg.permissionMode });
        }
      }
      break;
    }

    case 'retry_with_permission': {
      const nid = msg.sessionId ? sessionNodeMap.get(msg.sessionId) : null;
      const targetNode = nid || getNodeIdForBrowser(ws);
      if (targetNode && msg.sessionId) {
        const node = localNodes.get(targetNode);
        if (node) {
          if (!isAuthenticated(ws, targetNode)) {
            send(ws, { type: 'error', error: `节点 ${targetNode} 需要密码认证` });
            return;
          }
          send(node.ws, { type: 'retry_with_permission', sessionId: msg.sessionId, permissionMode: msg.permissionMode });
        }
      }
      break;
    }

    case 'get_git_status': {
      const targetNode = msg.nodeId || getNodeIdForBrowser(ws);
      if (!targetNode) {
        send(ws, { type: 'error', error: '未选择节点' });
        return;
      }
      const node = localNodes.get(targetNode);
      if (!node) return;
      if (!isAuthenticated(ws, targetNode)) {
        send(ws, { type: 'error', error: `节点 ${targetNode} 需要密码认证` });
        return;
      }
      const reqId = registerBrowserRequest(ws, 'get_git_status');
      send(node.ws, { type: 'get_git_status', projectPath: msg.projectPath, projectId: msg.projectId, _reqId: reqId });
      break;
    }

    case 'get_git_diff': {
      const targetNode = msg.nodeId || getNodeIdForBrowser(ws);
      if (!targetNode) {
        send(ws, { type: 'error', error: '未选择节点' });
        return;
      }
      const node = localNodes.get(targetNode);
      if (!node) return;
      if (!isAuthenticated(ws, targetNode)) {
        send(ws, { type: 'error', error: `节点 ${targetNode} 需要密码认证` });
        return;
      }
      const reqId = registerBrowserRequest(ws, 'get_git_diff');
      send(node.ws, { type: 'get_git_diff', projectPath: msg.projectPath, filePath: msg.filePath, staged: msg.staged, _reqId: reqId });
      break;
    }

    case 'get_file_tree': {
      const targetNode = msg.nodeId || getNodeIdForBrowser(ws);
      if (!targetNode) {
        send(ws, { type: 'error', error: '未选择节点' });
        return;
      }
      const node = localNodes.get(targetNode);
      if (!node) return;
      if (!isAuthenticated(ws, targetNode)) {
        send(ws, { type: 'error', error: `节点 ${targetNode} 需要密码认证` });
        return;
      }
      const reqId = registerBrowserRequest(ws, 'get_file_tree');
      send(node.ws, { type: 'get_file_tree', projectPath: msg.projectPath, projectId: msg.projectId, _reqId: reqId });
      break;
    }

    case 'get_file_content': {
      const targetNode = msg.nodeId || getNodeIdForBrowser(ws);
      if (!targetNode) {
        send(ws, { type: 'error', error: '未选择节点' });
        return;
      }
      const node = localNodes.get(targetNode);
      if (!node) return;
      if (!isAuthenticated(ws, targetNode)) {
        send(ws, { type: 'error', error: `节点 ${targetNode} 需要密码认证` });
        return;
      }
      const reqId = registerBrowserRequest(ws, 'get_file_content');
      send(node.ws, { type: 'get_file_content', projectPath: msg.projectPath, filePath: msg.filePath, _reqId: reqId });
      break;
    }
  }
}

// ---- HTTP API：向指定/任一节点发请求 ----

export function requestLocal(data: Record<string, unknown>, nodeId?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // 如果指定了 nodeId，用指定的；否则用第一个在线的
    let targetWs: WebSocket | null = null;
    if (nodeId) {
      const node = localNodes.get(nodeId);
      targetWs = node?.ws ?? null;
    } else if (localNodes.size > 0) {
      targetWs = localNodes.values().next().value!.ws;
    }

    if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
      reject(new Error(nodeId ? `节点 ${nodeId} 未连接` : '没有在线的本地节点'));
      return;
    }
    const reqId = randomUUID();
    pendingRequests.set(reqId, resolve);
    send(targetWs, { ...data, _reqId: reqId });
    setTimeout(() => {
      if (pendingRequests.has(reqId)) {
        pendingRequests.delete(reqId);
        reject(new Error('请求超时'));
      }
    }, 5000);
  });
}

// 列出所有在线节点（供 HTTP API 使用）
export function getOnlineNodes(): Array<{ nodeId: string; sessionCount: number; passwordRequired: boolean }> {
  const nodes: Array<{ nodeId: string; sessionCount: number; passwordRequired: boolean }> = [];
  for (const [nid, info] of localNodes) {
    let count = 0;
    for (const [, nid2] of sessionNodeMap) {
      if (nid2 === nid) count++;
    }
    nodes.push({ nodeId: nid, sessionCount: count, passwordRequired: info.passwordRequired });
  }
  return nodes;
}

export function isNodePasswordRequired(nodeId: string): boolean {
  const node = localNodes.get(nodeId);
  return node ? node.passwordRequired : false;
}

// ---- 本地服务消息处理 ----

function handleLocalMessage(ws: WebSocket, msg: LocalMessage): void {
  // HTTP API 响应
  const reqId = (msg as unknown as Record<string, unknown>)._reqId as string | undefined;
  if (reqId && pendingRequests.has(reqId)) {
    pendingRequests.get(reqId)!(msg);
    pendingRequests.delete(reqId);
    return;
  }

  // 浏览器请求-响应匹配
  if (reqId && browserRequests.has(reqId)) {
    const entry = browserRequests.get(reqId)!;
    clearTimeout(entry.timeout);
    browserRequests.delete(reqId);
    const { _reqId: _, ...response } = msg as LocalMessage & Record<string, unknown>;
    const nodeId = (ws as unknown as Record<string, unknown>)._nodeId as string;
    send(entry.ws, { ...response, nodeId });
    return;
  }

  switch (msg.type) {
    case 'register': {
      const ip = (ws as unknown as Record<string, unknown>)._ip as string || '?';
      if (!isDevMode() && isUsingDefaultRelayToken()) {
        console.error(`[relay] 生产模式拒绝默认 token 注册 | IP: ${ip} | nodeId: ${msg.nodeId || 'unknown'}`);
        send(ws, { type: 'error', error: '认证失败：生产环境下不允许使用默认 token，请设置 RELAY_TOKEN' });
        ws.close();
        return;
      }
      if (msg.token !== RELAY_TOKEN) {
        console.warn(`[relay] 节点注册认证失败: token 不匹配 | IP: ${ip} | 声称 nodeId: ${msg.nodeId || 'unknown'}`);
        send(ws, { type: 'error', error: '认证失败：token 不匹配' });
        ws.close();
        return;
      }
      const nodeId = msg.nodeId || 'unknown';
      // 同 nodeId 重连：替换旧连接
      if (localNodes.has(nodeId)) {
        const oldNode = localNodes.get(nodeId)!;
        const oldIp = (oldNode.ws as unknown as Record<string, unknown>)._ip as string || '?';
        if (oldIp !== ip) {
          console.error(`[SECURITY] 节点 ${nodeId} 从不同 IP 重连: ${oldIp} -> ${ip}，可能存在接管风险`);
        }
        const oldStart = (oldNode.ws as unknown as Record<string, unknown>)._connectedAt as number;
        const oldDuration = oldStart ? `${((Date.now() - oldStart) / 1000).toFixed(1)}s` : '?';
        console.log(`[relay] 节点 ${nodeId} 重连，替换旧连接 | IP: ${ip} | 旧连接持续: ${oldDuration}`);
        localNodes.get(nodeId)!.ws.close();
      }
      localNodes.set(nodeId, { ws, nodeId, passwordRequired: msg.passwordRequired === true });
      // 存储 nodeId 到 ws 上供 disconnect 时查找
      (ws as unknown as Record<string, unknown>)._nodeId = nodeId;
      console.log(`[relay] 节点已注册: ${nodeId} | IP: ${ip} | 需密码: ${msg.passwordRequired === true} | 在线节点: ${localNodes.size}`);
      send(ws, { type: 'registered' });
      broadcastNodesList();
      break;
    }

    case 'pong':
      break;

    case 'session_info': {
      if (msg.sessionId) {
        const nodeId = (ws as unknown as Record<string, unknown>)._nodeId as string;
        if (nodeId) {
          sessionNodeMap.set(msg.sessionId, nodeId);
          broadcastToNodeBrowsers(nodeId, { ...msg, nodeId });
        }
      }
      break;
    }

    case 'claude_json':
    case 'done':
    case 'error':
    case 'aborted':
    case 'session_end': {
      if (msg.sessionId) {
        const subType = msg.type === 'claude_json' && msg.data && typeof msg.data === 'object'
          ? (msg.data as { type?: string }).type
          : '';
        console.log(`[relay] 收到 ${msg.type}${subType ? '/' + subType : ''} sessionId=${(msg.sessionId || '').substring(0, 8)}, 浏览器数=${msg.sessionId ? (browserSessions.get(msg.sessionId)?.size ?? 0) : 'N/A'}`);
        const clients = browserSessions.get(msg.sessionId);
        if (clients && clients.size > 0) {
          broadcastToSession(msg.sessionId, msg);
        } else {
          const nodeId = (ws as unknown as Record<string, unknown>)._nodeId as string;
          console.warn(`[relay] 丢弃无订阅者的会话消息: ${msg.type} sessionId=${msg.sessionId.substring(0, 8)} nodeId=${nodeId}`);
        }
      } else {
        const nodeId = (ws as unknown as Record<string, unknown>)._nodeId as string;
        console.warn(`[relay] 缺少 sessionId，无法转发: ${msg.type} | 来源节点: ${nodeId}`);
      }
      break;
    }

    case 'sessions_list':
    case 'projects_list':
    case 'project_info':
    case 'git_status':
    case 'git_diff':
    case 'file_tree':
    case 'file_content': {
      const nodeId = (ws as unknown as Record<string, unknown>)._nodeId as string;
      if (!nodeId) break;
      const { _reqId: _, ...broadcastMsg } = msg as LocalMessage & Record<string, unknown>;
      broadcastToNodeBrowsers(nodeId, { ...broadcastMsg, nodeId });
      break;
    }
  }
}

// ---- 连接管理 ----

export function handleBrowserConnection(ws: WebSocket, ip: string): void {
  (ws as unknown as Record<string, unknown>)._connectedAt = Date.now();
  (ws as unknown as Record<string, unknown>)._ip = ip;
  allBrowsers.add(ws);
  browserNodeMap.delete(ws);
  console.log(`[relay] 浏览器已连接 | IP: ${ip} | 在线: ${allBrowsers.size}`);

  // 通知当前节点列表
  const nodes = getOnlineNodes();
  if (nodes.length > 0) {
    send(ws, { type: 'nodes_list', nodes });
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleBrowserMessage(ws, msg as BrowserMessage);
    } catch {
      console.warn(`[relay] 浏览器消息解析失败 | IP: ${ip}`);
    }
  });

  ws.on('close', (code) => {
    clearInterval(heartbeat);
    const start = (ws as unknown as Record<string, unknown>)._connectedAt as number;
    const duration = start ? `${((Date.now() - start) / 1000).toFixed(1)}s` : '?';
    allBrowsers.delete(ws);
    browserNodeMap.delete(ws);
    authenticatedBrowsers.delete(ws);
    authAttempts.delete(ws);
    for (const [, clients] of browserSessions) {
      clients.delete(ws);
    }
    for (const [reqId, entry] of browserRequests) {
      if (entry.ws === ws) {
        clearTimeout(entry.timeout);
        browserRequests.delete(reqId);
      }
    }
    console.log(`[relay] 浏览器已断开 | IP: ${ip} | 持续: ${duration} | closeCode: ${code} | 在线: ${allBrowsers.size}`);
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
  }, 30000);
}

export function handleLocalConnection(ws: WebSocket, ip: string): void {
  (ws as unknown as Record<string, unknown>)._connectedAt = Date.now();
  (ws as unknown as Record<string, unknown>)._ip = ip;
  console.log(`[relay] 本地服务连接请求 | IP: ${ip}`);

  // 暂时存储连接，等 register 消息到达后才知道 nodeId
  // 先设置一个临时 nodeId，register 时会设置正确的
  (ws as unknown as Record<string, unknown>)._nodeId = 'pending';

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleLocalMessage(ws, msg as LocalMessage);
    } catch {
      console.warn(`[relay] 本地消息解析失败 | IP: ${ip}`);
    }
  });

  ws.on('close', (code, reason) => {
    clearInterval(heartbeat);
    const start = (ws as unknown as Record<string, unknown>)._connectedAt as number;
    const duration = start ? `${((Date.now() - start) / 1000).toFixed(1)}s` : '?';
    const reasonStr = reason ? Buffer.from(reason).toString('utf-8').substring(0, 100) : '(无)';
    const nodeId = (ws as unknown as Record<string, unknown>)._nodeId as string | undefined;
    if (nodeId && nodeId !== 'pending' && localNodes.get(nodeId)?.ws === ws) {
      localNodes.delete(nodeId);
      console.log(`[relay] 节点已断开: ${nodeId} | IP: ${ip} | 持续: ${duration} | closeCode: ${code} | reason: ${reasonStr} | 在线节点: ${localNodes.size}`);

      // 清理该节点的会话映射
      for (const [sid, nid] of sessionNodeMap) {
        if (nid === nodeId) {
          sessionNodeMap.delete(sid);
          broadcastToSession(sid, { type: 'error', error: `节点 ${nodeId} 已断开` });
        }
      }

      broadcastNodesList();
    }
  });

  ws.on('error', (err) => {
    console.error(`[relay] 本地连接错误 | IP: ${ip} | ${err.message}`);
  });

  // 心跳
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      send(ws, { type: 'ping' });
    } else {
      clearInterval(heartbeat);
    }
  }, 30000);
}

// 扩展 ws 以存储内部状态
declare module 'ws' {
  interface WebSocket {
    _sessionId?: string;
  }
}

import type { WebSocket } from 'ws';

// relay 内部的节点连接记录（含 ws 句柄）；与 @cc-web/shared 的 NodeInfo DTO（无 ws）区分。
export interface NodeConn {
  ws: WebSocket;
  nodeId: string;
  workspaceRoot?: string;
}

export type ResolveResult =
  | { ok: true; nodeId: string; conn: NodeConn }
  | { ok: false; reason: 'no-selection' }                  // 既无显式选中、又无法自动选择
  | { ok: false; reason: 'offline'; nodeId: string };      // 显式指定了 nodeId 但节点不在 registry

export interface NodeSummary {
  nodeId: string;
  sessionCount: number;
  workspaceRoot?: string;
}

// 收拢原 ws-relay.ts 里 3 个节点相关的模块级 Map 单例：
//   localNodes / sessionNodeMap / browserNodeMap
// 全部节点生命周期、会话↔节点绑定、浏览器选中节点操作集中于此，
// 不触碰 ws.send —— 纯数据操作，可独立单测。传输动作由 ConnectionHandler 调用方决定。
export class NodeRegistry {
  private nodes = new Map<string, NodeConn>();                       // nodeId → conn
  private sessionNode = new Map<string, string>();                   // sessionId → nodeId
  private browserNode = new Map<WebSocket, string>();                // browser ws → 选中 nodeId

  // --- 节点 ---

  /** 注册 / 重连同 nodeId：返回被替换的旧 conn（调用方负责 close 旧 ws 与安全日志），无则 undefined */
  register(nodeId: string, conn: NodeConn): NodeConn | undefined {
    const old = this.nodes.get(nodeId);
    this.nodes.set(nodeId, conn);
    return old;
  }

  /** 注销节点：返回被删的 conn；不删其会话映射（调用方按需 forgetSessionsOfNode） */
  unregister(nodeId: string): NodeConn | undefined {
    const c = this.nodes.get(nodeId);
    this.nodes.delete(nodeId);
    return c;
  }

  get(nodeId: string): NodeConn | undefined {
    return this.nodes.get(nodeId);
  }

  has(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  get size(): number {
    return this.nodes.size;
  }

  /** 注册顺序首个 conn（HTTP API 未指定 nodeId 时用）；空 registry 返回 undefined */
  anyConn(): NodeConn | undefined {
    return this.nodes.values().next().value;
  }

  // --- 会话 ↔ 节点 ---

  bindSession(sessionId: string, nodeId: string): void {
    this.sessionNode.set(sessionId, nodeId);
  }

  nodeForSession(sessionId: string): string | undefined {
    return this.sessionNode.get(sessionId);
  }

  /** 删除一个会话映射，返回它此前绑定的 nodeId（无则 undefined） */
  forgetSession(sessionId: string): string | undefined {
    const nid = this.sessionNode.get(sessionId);
    this.sessionNode.delete(sessionId);
    return nid;
  }

  /** 删除某节点的全部会话映射，返回被删 sessionId 列表（调用方据此广播断连 error） */
  forgetSessionsOfNode(nodeId: string): string[] {
    const dropped: string[] = [];
    for (const [sid, nid] of this.sessionNode) {
      if (nid === nodeId) {
        dropped.push(sid);
        this.sessionNode.delete(sid);
      }
    }
    return dropped;
  }

  sessionCountOfNode(nodeId: string): number {
    let n = 0;
    for (const nid of this.sessionNode.values()) {
      if (nid === nodeId) n++;
    }
    return n;
  }

  // --- 浏览器选中节点 ---

  selectNodeForBrowser(ws: WebSocket, nodeId: string): void {
    this.browserNode.set(ws, nodeId);
  }

  selectedNodeOfBrowser(ws: WebSocket): string | undefined {
    return this.browserNode.get(ws);
  }

  /** 浏览器断开：清选中节点 */
  forgetBrowser(ws: WebSocket): void {
    this.browserNode.delete(ws);
  }

  // --- 目标解析（browser 消息：msg.nodeId || 自动选择）---

  /**
   * 重现原 getNodeIdForBrowser + localNodes.get 两步逻辑：
   *   - 显式 nodeId：在线即用，离线报 offline（不 fallback）；
   *   - 否则用 browser 选中节点（在线才用），再退化到「唯一节点自动选」；
   *   - 都不成立 → no-selection。
   */
  resolveTarget(ws: WebSocket, explicitNodeId?: string): ResolveResult {
    if (explicitNodeId) {
      const c = this.nodes.get(explicitNodeId);
      if (c) return { ok: true, nodeId: explicitNodeId, conn: c };
      return { ok: false, reason: 'offline', nodeId: explicitNodeId };
    }
    const selected = this.browserNode.get(ws);
    if (selected && this.nodes.has(selected)) {
      return { ok: true, nodeId: selected, conn: this.nodes.get(selected)! };
    }
    if (this.nodes.size === 1) {
      const c = this.anyConn()!;
      return { ok: true, nodeId: c.nodeId, conn: c };
    }
    return { ok: false, reason: 'no-selection' };
  }

  // --- 列表 / 查询 ---

  listNodes(): NodeSummary[] {
    const out: NodeSummary[] = [];
    for (const [nodeId, info] of this.nodes) {
      out.push({
        nodeId,
        sessionCount: this.sessionCountOfNode(nodeId),
        workspaceRoot: info.workspaceRoot,
      });
    }
    return out;
  }
}

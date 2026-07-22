import type { WebSocket } from 'ws';
import type { UserRole } from './user-store.js';

// relay 给每条 ws 连接附加的内部状态。
// 原实现把这些字段以 (ws as unknown)._xxx 形式散挂 15+ 处，这里收拢为 typed WeakMap：
// 不污染 ws 对象、随 ws GC 自动回收、且字段类型可见。
export interface ConnState {
  ip: string;
  connectedAt: number;
  lastSeen: number;     // 最近一次收到该 ws 消息的时间（local 链路假死检测用）
  nodeId?: string;       // local 连接 register 后写；undefined 表示尚未注册
  sessionId?: string;    // browser 订阅会话后写
  /** browser 连接的登录用户身份（WS 握手从 session 带入；节点列表过滤 / 操作授权用）。local 连接不设。 */
  userId?: string;
  role?: UserRole;
}

export class ConnStates {
  private m = new WeakMap<WebSocket, ConnState>();

  init(ws: WebSocket, ip: string, now: number = Date.now()): ConnState {
    const s: ConnState = { ip, connectedAt: now, lastSeen: now };
    this.m.set(ws, s);
    return s;
  }

  get(ws: WebSocket): ConnState | undefined {
    return this.m.get(ws);
  }

  setNodeId(ws: WebSocket, nodeId: string): void {
    const s = this.m.get(ws);
    if (s) s.nodeId = nodeId;
  }

  getNodeId(ws: WebSocket): string | undefined {
    return this.m.get(ws)?.nodeId;
  }

  setSessionId(ws: WebSocket, sessionId: string): void {
    const s = this.m.get(ws);
    if (s) s.sessionId = sessionId;
  }

  /** browser 连接握手后写入登录用户身份（节点列表过滤 / 操作授权据此判定）。 */
  setBrowserUser(ws: WebSocket, userId: string, role: UserRole): void {
    const s = this.m.get(ws);
    if (s) { s.userId = userId; s.role = role; }
  }

  getSessionId(ws: WebSocket): string | undefined {
    return this.m.get(ws)?.sessionId;
  }

  /** 更新链路活跃时间（local 每收一条消息调一次，含 pong，用于假死检测） */
  touch(ws: WebSocket, now: number = Date.now()): void {
    const s = this.m.get(ws);
    if (s) s.lastSeen = now;
  }

  lastSeenOf(ws: WebSocket): number | undefined {
    return this.m.get(ws)?.lastSeen;
  }
}

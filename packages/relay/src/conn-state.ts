import type { WebSocket } from 'ws';

// relay 给每条 ws 连接附加的内部状态。
// 原实现把这些字段以 (ws as unknown)._xxx 形式散挂 15+ 处，这里收拢为 typed WeakMap：
// 不污染 ws 对象、随 ws GC 自动回收、且字段类型可见。
export interface ConnState {
  ip: string;
  connectedAt: number;
  nodeId?: string;       // local 连接 register 后写；undefined 表示尚未注册
  sessionId?: string;    // browser 订阅会话后写
}

export class ConnStates {
  private m = new WeakMap<WebSocket, ConnState>();

  init(ws: WebSocket, ip: string, now: number = Date.now()): ConnState {
    const s: ConnState = { ip, connectedAt: now };
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

  getSessionId(ws: WebSocket): string | undefined {
    return this.m.get(ws)?.sessionId;
  }
}

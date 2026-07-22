import type { WebSocket } from 'ws';

export type SendFn = (ws: WebSocket, data: unknown) => void;

// 收拢原 browserSessions / allBrowsers 两个模块级单例 + 三档广播
// （session 内 / 全部 browser / 某节点的 browser）。
// send 与「browser 选中了哪个节点」由外部注入，使本 module 不碰 ws.send、
// 不直接依赖 NodeRegistry —— 可注入 mock 独立单测。
export class SessionRouter {
  private subscribers = new Map<string, Set<WebSocket>>(); // sessionId → browser ws 集
  private browsers = new Set<WebSocket>();

  constructor(
    private readonly send: SendFn,
    private readonly selectedNodeOf: (ws: WebSocket) => string | undefined,
  ) {}

  addBrowser(ws: WebSocket): void {
    this.browsers.add(ws);
  }

  get size(): number {
    return this.browsers.size;
  }

  /** 浏览器断开：从全部浏览器集合 + 所有会话订阅中移除 */
  removeBrowser(ws: WebSocket): void {
    this.browsers.delete(ws);
    for (const clients of this.subscribers.values()) {
      clients.delete(ws);
    }
  }

  subscribe(sessionId: string, ws: WebSocket): void {
    let clients = this.subscribers.get(sessionId);
    if (!clients) {
      clients = new Set();
      this.subscribers.set(sessionId, clients);
    }
    clients.add(ws);
  }

  subscribersOf(sessionId: string): number {
    return this.subscribers.get(sessionId)?.size ?? 0;
  }

  broadcastToSession(sessionId: string, data: unknown): void {
    const clients = this.subscribers.get(sessionId);
    if (!clients) return;
    for (const ws of clients) this.send(ws, data);
  }

  broadcastToAll(data: unknown): void {
    for (const ws of this.browsers) this.send(ws, data);
  }

  /** 逐 browser 发送由 build(ws) 计算的载荷（节点列表按用户过滤时用：每 browser 一份）。 */
  broadcastPerBrowser(build: (ws: WebSocket) => unknown): void {
    for (const ws of this.browsers) this.send(ws, build(ws));
  }

  // 原逻辑：未选中节点（!selectedNode）或选中了本节点（=== nodeId）的 browser 都收到
  broadcastToNodeBrowsers(nodeId: string, data: unknown): void {
    for (const ws of this.browsers) {
      const sel = this.selectedNodeOf(ws);
      if (!sel || sel === nodeId) this.send(ws, data);
    }
  }
}

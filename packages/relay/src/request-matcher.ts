import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';

// 收拢原 ws-relay.ts 里两套请求-响应匹配：
//   pendingRequests (HTTP API + AuthNode)   reqId → (msg) => void
//   browserRequests                          reqId → { ws, type, timeout }
//
// 两套超时语义不同，故 HTTP/AuthNode 的超时由调用方管理（requestLocal reject Promise、
// AuthNode 发「认证超时」消息），matcher 只管 reqId → cb 映射；
// 浏览器请求是 fire-and-forget 投给 local，超时仅作 GC 清理，故内置 timeout。
export class RequestMatcher {
  private httpPending = new Map<string, (data: unknown) => void>();
  private browserPending = new Map<string, BrowserPendingEntry>();

  constructor(private readonly newId: () => string = randomUUID) {}

  // --- HTTP / AuthNode 请求-响应 ---

  register(reqId: string, cb: (data: unknown) => void): void {
    this.httpPending.set(reqId, cb);
  }

  has(reqId: string): boolean {
    return this.httpPending.has(reqId);
  }

  /** 取出并删除回调；未命中返回 undefined（调用方据此判断响应是否仍被等待） */
  take(reqId: string): ((data: unknown) => void) | undefined {
    const cb = this.httpPending.get(reqId);
    if (cb) this.httpPending.delete(reqId);
    return cb;
  }

  // --- 浏览器请求-响应（含超时清理）---

  /** 注册一条浏览器请求，返回 reqId；timeoutMs 后自动 GC（不通知调用方） */
  registerBrowser(ws: WebSocket, type: string, timeoutMs = 10000): string {
    const reqId = this.newId();
    const timeout = setTimeout(() => {
      this.browserPending.delete(reqId);
    }, timeoutMs);
    this.browserPending.set(reqId, { ws, type, timeout });
    return reqId;
  }

  /** 取出浏览器 pending（内部 clearTimeout + 删映射）；未命中返回 undefined */
  takeBrowser(reqId: string): BrowserPending | undefined {
    const e = this.browserPending.get(reqId);
    if (!e) return undefined;
    clearTimeout(e.timeout);
    this.browserPending.delete(reqId);
    return { ws: e.ws, type: e.type };
  }

  /** 浏览器断开：清掉该 ws 的全部 pending（含 timeout） */
  forgetBrowser(ws: WebSocket): void {
    for (const [reqId, e] of this.browserPending) {
      if (e.ws === ws) {
        clearTimeout(e.timeout);
        this.browserPending.delete(reqId);
      }
    }
  }
}

interface BrowserPendingEntry {
  ws: WebSocket;
  type: string;
  timeout: ReturnType<typeof setTimeout>;
}

export interface BrowserPending {
  ws: WebSocket;
  type: string;
}

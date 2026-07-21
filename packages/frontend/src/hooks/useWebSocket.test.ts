// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useWebSocket } from "./useWebSocket";

// 可控的假 WebSocket：实例化后挂到 .last，测试手动触发 onclose 模拟被动断开。
// 必须定义静态 readyState 常量 —— 源码用 `ws.readyState === WebSocket.OPEN` 判断，
// 缺了它们会让 undefined === undefined 误判为已连接，connect 提前 return。
// 不用 vi.useFakeTimers —— 会冻结 React 19 的 effect 调度。
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: FakeWebSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.last = this;
  }
  send = vi.fn();
  close = vi.fn();
}

function resp(ok: boolean): Response {
  return { ok, status: ok ? 200 : 401 } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.last = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useWebSocket — WS 断开后 session 失效探测", () => {
  it("onclose + /api/session 401 → 调 onAuthLost（relay 重启丢内存 session）", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(resp(false))));
    const onAuthLost = vi.fn();
    const { unmount } = renderHook(() => useWebSocket(true, onAuthLost));

    await waitFor(() => expect(FakeWebSocket.last).not.toBeNull());
    await act(async () => { FakeWebSocket.last!.onclose!(); });

    expect(onAuthLost).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("onclose + /api/session 200（session 仍有效）→ 不调 onAuthLost", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(resp(true))));
    const onAuthLost = vi.fn();
    const { unmount } = renderHook(() => useWebSocket(true, onAuthLost));

    await waitFor(() => expect(FakeWebSocket.last).not.toBeNull());
    await act(async () => { FakeWebSocket.last!.onclose!(); });

    expect(onAuthLost).not.toHaveBeenCalled();
    unmount();
  });

  it("onclose + fetch reject（relay 不可达/重启中）→ 不调 onAuthLost，留待重连", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("net"))));
    const onAuthLost = vi.fn();
    const { unmount } = renderHook(() => useWebSocket(true, onAuthLost));

    await waitFor(() => expect(FakeWebSocket.last).not.toBeNull());
    await act(async () => { FakeWebSocket.last!.onclose!(); });

    expect(onAuthLost).not.toHaveBeenCalled();
    unmount();
  });
});

describe("useWebSocket — 未登录不建连", () => {
  it("authed=false → 不实例化 WebSocket", () => {
    const { unmount } = renderHook(() => useWebSocket(false, () => {}));
    expect(FakeWebSocket.last).toBeNull();
    unmount();
  });
});

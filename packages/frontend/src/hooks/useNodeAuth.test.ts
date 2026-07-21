// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { BrowserCommandType } from "../types";
import type { BrowserCommand } from "../types";

// mock localStorage utils —— 隔离测试，精确控制 loadNodePassword 返回值
vi.mock("../utils/localStorage", () => ({
  loadNodePassword: vi.fn(),
  saveNodePassword: vi.fn(),
}));

import { loadNodePassword, saveNodePassword } from "../utils/localStorage";
import { useNodeAuth } from "./useNodeAuth";

const mockLoadNodePassword = vi.mocked(loadNodePassword);
const mockSaveNodePassword = vi.mocked(saveNodePassword);

beforeEach(() => {
  vi.useFakeTimers();
  mockLoadNodePassword.mockReturnValue(null);
  mockSaveNodePassword.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// 渲染并允许 rerender 改 connected（send 默认稳定 vi.fn，避免 Effect 1 因 send 重跑）
function renderAuth(initial: { connected?: boolean; send?: ReturnType<typeof vi.fn> } = {}) {
  const send = initial.send ?? vi.fn();
  return renderHook(
    ({ connected, send }) => useNodeAuth({ send, connected }),
    { initialProps: { connected: initial.connected ?? true, send } },
  );
}

describe("useNodeAuth — 自动认证 effect（Effect 1）", () => {
  it("pendingAuthNodeId + connected + 有保存密码 → send AuthNode（一次）+ autoAuthInProgress=true", () => {
    const send = vi.fn();
    mockLoadNodePassword.mockReturnValue("saved-pw");
    const { result } = renderAuth({ send });

    expect(send).not.toHaveBeenCalled();
    act(() => result.current.setPendingAuthNodeId("node-1"));

    expect(mockLoadNodePassword).toHaveBeenCalledWith("node-1");
    // send 只调一次：setAutoAuthInProgress(true) 触发 effect 重跑，但
    // autoAuthInProgress=true 使条件 !autoAuthInProgress=false，不重入（防重复发认证）。
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: BrowserCommandType.AuthNode,
      nodeId: "node-1",
      password: "saved-pw",
    } satisfies BrowserCommand);
    expect(result.current.autoAuthInProgress).toBe(true);
    expect(result.current.authError).toBeNull();
  });

  it("无保存密码 → 不 send + autoAuthInProgress 保持 false", () => {
    const send = vi.fn();
    mockLoadNodePassword.mockReturnValue(null);
    const { result } = renderAuth({ send });

    act(() => result.current.setPendingAuthNodeId("node-1"));

    expect(send).not.toHaveBeenCalled();
    expect(result.current.autoAuthInProgress).toBe(false);
  });

  it("节点已认证 → 不 send", () => {
    const send = vi.fn();
    mockLoadNodePassword.mockReturnValue("pw");
    const { result } = renderAuth({ send });

    act(() => result.current.setAuthenticatedNodes(new Set(["node-1"])));
    act(() => result.current.setPendingAuthNodeId("node-1"));

    expect(send).not.toHaveBeenCalled();
    expect(result.current.autoAuthInProgress).toBe(false);
  });

  it("autoAuthInProgress=true → 不 send（防重入）", () => {
    const send = vi.fn();
    mockLoadNodePassword.mockReturnValue("pw");
    const { result } = renderAuth({ send });

    act(() => result.current.setAutoAuthInProgress(true));
    act(() => result.current.setPendingAuthNodeId("node-1"));

    expect(send).not.toHaveBeenCalled();
  });

  it("未 connected → 不 send", () => {
    const send = vi.fn();
    mockLoadNodePassword.mockReturnValue("pw");
    const { result } = renderAuth({ send, connected: false });

    act(() => result.current.setPendingAuthNodeId("node-1"));

    expect(send).not.toHaveBeenCalled();
  });

  it("5s 超时回退不生效（autoAuthInProgress 保持 true）—— 锁定既有行为", () => {
    // setAutoAuthInProgress(true) 让 Effect 1 重跑（autoAuthInProgress 在依赖里），
    // cleanup 清掉刚设的 5s timeout —— 回退实际靠 dispatcher 的 AuthResult 事件。
    // 此测锁定该反直觉的既有行为，防止未来重构时误以为 timeout 会触发回退。
    const send = vi.fn();
    mockLoadNodePassword.mockReturnValue("pw");
    const { result } = renderAuth({ send });

    act(() => result.current.setPendingAuthNodeId("node-1"));
    expect(result.current.autoAuthInProgress).toBe(true);

    act(() => { vi.advanceTimersByTime(5000); });

    expect(result.current.autoAuthInProgress).toBe(true);
  });

  it("unmount → cleanup 安全（不抛）", () => {
    const send = vi.fn();
    mockLoadNodePassword.mockReturnValue("pw");
    const { result, unmount } = renderAuth({ send });

    act(() => result.current.setPendingAuthNodeId("node-1"));
    // 注意：setAutoAuthInProgress(true) 触发 effect 重跑，cleanup 把刚设的
    // autoAuthTimeoutRef 清成 null —— 5s 超时回调实际不会触发，认证 inProgress
    // 的回退靠 dispatcher 的 AuthResult 事件。此测验证卸载不泄漏、不抛错。
    expect(() => unmount()).not.toThrow();
  });
});

describe("useNodeAuth — tryAutoAuth", () => {
  it("有保存密码 + connected → send AuthNode + setPendingAuthNodeId + 返回 true", () => {
    const send = vi.fn();
    mockLoadNodePassword.mockReturnValue("pw");
    const { result } = renderAuth({ send });

    let ok: boolean | undefined;
    act(() => { ok = result.current.tryAutoAuth("node-1"); });

    expect(ok).toBe(true);
    expect(result.current.pendingAuthNodeId).toBe("node-1");
    expect(result.current.autoAuthInProgress).toBe(true);
    expect(result.current.authError).toBeNull();
    expect(send).toHaveBeenCalledWith({
      type: BrowserCommandType.AuthNode,
      nodeId: "node-1",
      password: "pw",
    } satisfies BrowserCommand);
  });

  it("无保存密码 → 返回 false + 不 send", () => {
    const send = vi.fn();
    mockLoadNodePassword.mockReturnValue(null);
    const { result } = renderAuth({ send });

    let ok: boolean | undefined;
    act(() => { ok = result.current.tryAutoAuth("node-1"); });

    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(result.current.autoAuthInProgress).toBe(false);
  });

  it("未 connected → 返回 false + 不 send", () => {
    const send = vi.fn();
    mockLoadNodePassword.mockReturnValue("pw");
    const { result } = renderAuth({ send, connected: false });

    let ok: boolean | undefined;
    act(() => { ok = result.current.tryAutoAuth("node-1"); });

    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("useNodeAuth — handleAuthNode", () => {
  it("saveNodePassword + send AuthNode + 清 authError", () => {
    const send = vi.fn();
    const { result } = renderAuth({ send });

    act(() => result.current.setAuthError("旧错误"));
    act(() => result.current.handleAuthNode("node-1", "user-pw"));

    expect(mockSaveNodePassword).toHaveBeenCalledWith("node-1", "user-pw");
    expect(send).toHaveBeenCalledWith({
      type: BrowserCommandType.AuthNode,
      nodeId: "node-1",
      password: "user-pw",
    } satisfies BrowserCommand);
    expect(result.current.authError).toBeNull();
  });
});

describe("useNodeAuth — 超时自动重试（限次）", () => {
  it("Effect 路径：setAutoAuthInProgress(false)（模拟 dispatcher 收到超时）触发重发，达 MAX(2) 次后停止", () => {
    const send = vi.fn();
    mockLoadNodePassword.mockReturnValue("pw");
    const { result } = renderAuth({ send });

    act(() => result.current.setPendingAuthNodeId("node-1"));
    // Effect 首次发送（计数 0→1）
    expect(send).toHaveBeenCalledTimes(1);

    // 模拟 dispatcher 收到"认证超时"：autoAuthInProgress 回 false 触发 Effect 重跑
    act(() => result.current.setAutoAuthInProgress(false));
    // 计数 1<2，重发（1→2）
    expect(send).toHaveBeenCalledTimes(2);

    act(() => result.current.setAutoAuthInProgress(false));
    // 计数 2>=2，停止重发
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("tryAutoAuth 路径：首轮发送已计入计数，Effect 仅再重试到 MAX", () => {
    const send = vi.fn();
    mockLoadNodePassword.mockReturnValue("pw");
    const { result } = renderAuth({ send });

    act(() => { result.current.tryAutoAuth("node-1"); });
    // tryAutoAuth 首次发送（计数设为 1）
    expect(send).toHaveBeenCalledTimes(1);

    act(() => result.current.setAutoAuthInProgress(false));
    // 计数 1<2，Effect 重发（1→2）
    expect(send).toHaveBeenCalledTimes(2);

    act(() => result.current.setAutoAuthInProgress(false));
    // 计数 2>=2，停
    expect(send).toHaveBeenCalledTimes(2);
  });
});

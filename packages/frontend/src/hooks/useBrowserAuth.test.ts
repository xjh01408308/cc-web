// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useBrowserAuth } from "./useBrowserAuth";

// 构造极简 Response 形状（useBrowserAuth 只用 ok/status/json/clone）。
function mockResponse(ok: boolean, body: unknown = {}): Response {
  const resp = {
    ok,
    status: ok ? 200 : 401,
    json: async () => body,
    clone() { return resp; },
  };
  return resp as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useBrowserAuth — session 探测（mount effect）", () => {
  it("已有 session → authed=true 且不调用 /api/login", async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(mockResponse(url.includes("/api/session")))
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(result.current.authed).toBe(true));

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("/api/session"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/login"))).toBe(false);
  });

  it("session 带 user → currentUser 捕获 username/role（admin 入口/守卫据此判断）", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/session")) {
        return Promise.resolve(mockResponse(true, { user: { username: "admin", role: "admin" } }));
      }
      return Promise.resolve(mockResponse(false));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(result.current.authed).toBe(true));

    expect(result.current.currentUser).toEqual({ username: "admin", role: "admin" });
  });

  it("session 探测落定后 sessionChecked=true（无论是否登录）", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(mockResponse(false))));
    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(result.current.sessionChecked).toBe(true));
    expect(result.current.authed).toBe(false);
  });

  it("无 session → 保持未登录，仅探测一次 /api/login 不被调用", async () => {
    const fetchMock = vi.fn((_url: string) => Promise.resolve(mockResponse(false)));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(result.current.authed).toBe(false);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("/api/login"))).toBe(false);
  });

  it("网络异常（session fetch reject）→ 保持未登录", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("net")));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(result.current.authed).toBe(false);
  });
});

describe("useBrowserAuth — handleLogin（用户名 + 密码）", () => {
  it("正确用户名 + 密码 → authed=true + loginLoading 回落", async () => {
    // mount 探测失败，authed 保持 false；handleLogin 用 admin/secret 成功
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/session")) return mockResponse(false);
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return mockResponse(body.username === "admin" && body.password === "secret");
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(result.current.authed).toBe(false);

    act(() => {
      result.current.setLoginUsername("admin");
      result.current.setLoginPassword("secret");
    });
    await act(async () => { await result.current.handleLogin(); });

    expect(result.current.authed).toBe(true);
    expect(result.current.loginLoading).toBe(false);
    expect(result.current.loginError).toBeNull();

    // 确认请求体携带 username + password
    const loginCall = fetchMock.mock.calls.find((c) => (c[0] as string).includes("/api/login"));
    const body = JSON.parse((loginCall![1] as RequestInit).body as string);
    expect(body).toEqual({ username: "admin", password: "secret" });
  });

  it("登录成功且响应含 user → currentUser 捕获（无需二次请求 /api/session）", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/session")) return mockResponse(false);
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.username === "admin" && body.password === "secret") {
        return mockResponse(true, { ok: true, user: { username: "admin", role: "admin" } });
      }
      return mockResponse(false);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.setLoginUsername("admin");
      result.current.setLoginPassword("secret");
    });
    await act(async () => { await result.current.handleLogin(); });

    expect(result.current.authed).toBe(true);
    expect(result.current.currentUser).toEqual({ username: "admin", role: "admin" });
    // 登录后不应再额外请求 /api/session（user 已由登录响应回传）
    const sessionCalls = fetchMock.mock.calls.filter((c) => (c[0] as string).includes("/api/session"));
    expect(sessionCalls).toHaveLength(1);
  });

  it("错误凭据 → loginError 设置 + authed 保持 false", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/session")) return mockResponse(false);
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.username === "admin" && body.password === "wrong") {
        return mockResponse(false, { error: "用户名或密码错误" });
      }
      return mockResponse(false);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.setLoginUsername("admin");
      result.current.setLoginPassword("wrong");
    });
    await act(async () => { await result.current.handleLogin(); });

    expect(result.current.authed).toBe(false);
    expect(result.current.loginError).toBe("用户名或密码错误");
    expect(result.current.loginLoading).toBe(false);
  });

  it("网络错误 → loginError='网络错误'", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/session")) return Promise.resolve(mockResponse(false));
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.username === "admin" && body.password === "secret") return Promise.reject(new Error("net"));
      return Promise.resolve(mockResponse(false));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.setLoginUsername("admin");
      result.current.setLoginPassword("secret");
    });
    await act(async () => { await result.current.handleLogin(); });

    expect(result.current.authed).toBe(false);
    expect(result.current.loginError).toBe("网络错误");
  });
});

describe("useBrowserAuth — authFetch（401 session 失效）", () => {
  it("401 → 抛 SESSION_EXPIRED 并 clearSession", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/protected") {
        return Promise.resolve(mockResponse(false, {}));
      }
      // mount effect 让 authed=true
      return Promise.resolve(mockResponse(true));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(result.current.authed).toBe(true));

    let caught: unknown;
    await act(async () => {
      try { await result.current.authFetch("/api/protected"); }
      catch (e) { caught = e; }
    });

    expect((caught as Error).message).toBe("SESSION_EXPIRED");
    expect(result.current.authed).toBe(false); // clearSession 重置
    expect(result.current.initialLoadDone.current).toBe(false); // 加载守卫重置
  });

  it("200 → 正常返回 Response", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(mockResponse(true)));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(result.current.authed).toBe(true));

    let resp: Response | undefined;
    await act(async () => { resp = await result.current.authFetch("/api/protected"); });
    expect(resp?.ok).toBe(true);
  });
});

describe("useBrowserAuth — clearSession / handleLogout", () => {
  it("clearSession 重置 authed 与 initialLoadDone 守卫", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(mockResponse(true))));
    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(result.current.authed).toBe(true));

    act(() => { result.current.initialLoadDone.current = true; });
    act(() => result.current.clearSession());

    expect(result.current.authed).toBe(false);
    expect(result.current.initialLoadDone.current).toBe(false);
  });

  it("handleLogout → POST /api/logout 并 clearSession", async () => {
    const fetchMock = vi.fn((_url: string) => Promise.resolve(mockResponse(true)));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(result.current.authed).toBe(true));

    act(() => result.current.handleLogout());

    expect(result.current.authed).toBe(false);
    expect(
      fetchMock.mock.calls.some((c) => (c[0] as string).includes("/api/logout")),
    ).toBe(true);
  });
});

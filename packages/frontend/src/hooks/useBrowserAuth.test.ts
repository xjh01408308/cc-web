// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useBrowserAuth } from "./useBrowserAuth";
import { isDevelopment } from "../utils/environment";

// 默认 DEV=true 以保留 mount effect 的 dev 自动登录行为；prod 用例单独覆盖
vi.mock("../utils/environment", () => ({
  isDevelopment: vi.fn(() => true),
  isProduction: vi.fn(() => false),
}));
const mockedIsDevelopment = vi.mocked(isDevelopment);

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
  mockedIsDevelopment.mockReturnValue(true);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useBrowserAuth — 自动登录探测（mount effect）", () => {
  it("已有 session → authed=true 且不尝试 dev 登录", async () => {
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

  it("无 session + dev 自动登录成功 → authed=true", async () => {
    // session 失败、login 成功
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(mockResponse(!url.includes("/api/session")))
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(result.current.authed).toBe(true));
  });

  it("session 与 dev 登录都失败 → 保持未登录", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(mockResponse(false)));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.authed).toBe(false);
  });

  it("网络异常（session fetch reject）→ 回退到 dev 登录", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/session")) return Promise.reject(new Error("net"));
      return Promise.resolve(mockResponse(true)); // dev 登录成功
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(result.current.authed).toBe(true));
  });

  it("prod 下无 session → 不尝试空密码 login（无 /api/login 调用）", async () => {
    mockedIsDevelopment.mockReturnValue(false);
    const fetchMock = vi.fn((_url: string) => Promise.resolve(mockResponse(false)));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("/api/session"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/login"))).toBe(false);
    expect(result.current.authed).toBe(false);
  });
});

describe("useBrowserAuth — handleLogin", () => {
  it("密码正确 → authed=true + loginLoading 回落", async () => {
    // mount effect 探测失败，authed 保持 false；handleLogin 用 password=secret 成功
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/session")) return mockResponse(false);
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return mockResponse(body.password === "secret");
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.authed).toBe(false);

    act(() => result.current.setLoginPassword("secret"));
    await act(async () => { await result.current.handleLogin(); });

    expect(result.current.authed).toBe(true);
    expect(result.current.loginLoading).toBe(false);
    expect(result.current.loginError).toBeNull();
  });

  it("密码错误 → loginError 设置 + authed 保持 false", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/session")) return mockResponse(false);
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.password === "wrong") return mockResponse(false, { error: "密码错误" });
      return mockResponse(false); // mount effect 的 dev 登录 password=""
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    act(() => result.current.setLoginPassword("wrong"));
    await act(async () => { await result.current.handleLogin(); });

    expect(result.current.authed).toBe(false);
    expect(result.current.loginError).toBe("密码错误");
    expect(result.current.loginLoading).toBe(false);
  });

  it("网络错误 → loginError='网络错误'", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/api/session")) return Promise.resolve(mockResponse(false));
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.password === "secret") return Promise.reject(new Error("net"));
      return Promise.resolve(mockResponse(false));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    act(() => result.current.setLoginPassword("secret"));
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

  it("401 auth_required（节点密码拦截）→ 透传 response，不清登录态", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/projects") {
        return Promise.resolve(mockResponse(false, { error: 'auth_required', message: '此节点需要密码认证' }));
      }
      return Promise.resolve(mockResponse(true));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBrowserAuth());
    await waitFor(() => expect(result.current.authed).toBe(true));

    let resp: Response | undefined;
    await act(async () => { resp = await result.current.authFetch("/api/projects"); });

    expect(resp?.status).toBe(401);
    expect((await resp!.json()).error).toBe('auth_required');
    expect(result.current.authed).toBe(true); // 未被 clearSession 踢回登录页
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

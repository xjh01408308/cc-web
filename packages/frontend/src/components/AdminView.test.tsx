// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { AdminView } from "./AdminView";

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
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AdminView — 守卫", () => {
  it("非 admin → 显示无权限提示，不加载用户列表", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/session")) return mockResponse(true, { user: { username: "alice", role: "user" } });
      return mockResponse(false);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminView />);
    await waitFor(() => expect(screen.getByText("需要管理员权限才能访问此页面。")).toBeTruthy());

    // 非 admin 不应请求管理 API
    expect(fetchMock.mock.calls.some((c) => (c[0] as string).includes("/api/admin/users"))).toBe(false);
  });
});

describe("AdminView — admin 用户管理", () => {
  function adminFetchMock(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/session")) return mockResponse(true, { user: { username: "admin", role: "admin" } });
      if (url.includes("/api/admin/users")) {
        const custom = extra?.(url, init);
        if (custom) return custom;
        return mockResponse(true, [
          { id: "u1", username: "alice", role: "user", createdAt: 1700000000000 },
          { id: "a1", username: "admin", role: "admin", createdAt: 1700000000000 },
        ]);
      }
      return mockResponse(false);
    });
  }

  it("admin → 加载并展示用户列表；admin 角色行无操作按钮，user 角色行有重置/删除", async () => {
    vi.stubGlobal("fetch", adminFetchMock());
    render(<AdminView />);

    await waitFor(() => expect(screen.getByText("alice")).toBeTruthy());
    // admin 行的用户名与角色徽章文本均为 "admin"，故用 getAllByText
    expect(screen.getAllByText("admin").length).toBeGreaterThan(0);

    // alice（user）有"重置密码"与"删除"；admin 行操作列为"—"
    const resetButtons = screen.getAllByRole("button", { name: "重置密码" });
    expect(resetButtons).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(1);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("创建用户 → POST /api/admin/users 携带 username/password", async () => {
    const fetchMock = adminFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminView />);
    await waitFor(() => expect(screen.getByText("alice")).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText("用户名"), { target: { value: "bob" } });
    fireEvent.change(screen.getByPlaceholderText("初始密码"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find((c) => (c[0] as string).includes("/api/admin/users") && (c[1] as RequestInit | undefined)?.method === "POST");
      expect(createCall).toBeTruthy();
      const body = JSON.parse((createCall![1] as RequestInit).body as string);
      expect(body).toEqual({ username: "bob", password: "pw" });
    });
  });

  it("删除用户 → 确认后 DELETE /api/admin/users/:id", async () => {
    vi.stubGlobal("confirm", () => true);
    const fetchMock = adminFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminView />);
    await waitFor(() => expect(screen.getByText("alice")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => {
      const delCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "DELETE");
      expect(delCall).toBeTruthy();
      expect((delCall![0] as string)).toContain("/api/admin/users/u1");
    });
  });
});

// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { UserMenu } from "./UserMenu";
import type { CurrentUser } from "../hooks/useBrowserAuth";

function mockResponse(ok: boolean, body: unknown = {}, status?: number): Response {
  const resp = {
    ok,
    status: status ?? (ok ? 200 : 400),
    json: async () => body,
    clone() { return resp; },
  };
  return resp as unknown as Response;
}

const noopAuthFetch = vi.fn(async () => mockResponse(true, { ok: true }));

beforeEach(() => {
  noopAuthFetch.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("UserMenu — 对所有角色可见（issue #38）", () => {
  it("admin 角色 → 显示用户名按钮，菜单含「修改密码」「登出」", async () => {
    const onLogout = vi.fn();
    render(
      <UserMenu
        currentUser={{ username: "admin", role: "admin" } as CurrentUser}
        onLogout={onLogout}
        authFetch={noopAuthFetch}
      />,
    );

    // 用户名按钮对 admin 可见
    expect(screen.getByText("admin")).toBeTruthy();
    fireEvent.click(screen.getByTitle("用户菜单"));

    expect(screen.getByRole("button", { name: "修改密码" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "登出" })).toBeTruthy();
  });

  it("普通 user 角色 → 同样可见用户名与两项菜单", async () => {
    const onLogout = vi.fn();
    render(
      <UserMenu
        currentUser={{ username: "alice", role: "user" } as CurrentUser}
        onLogout={onLogout}
        authFetch={noopAuthFetch}
      />,
    );

    expect(screen.getByText("alice")).toBeTruthy();
    fireEvent.click(screen.getByTitle("用户菜单"));
    expect(screen.getByRole("button", { name: "修改密码" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "登出" })).toBeTruthy();
  });
});

describe("UserMenu — 行为", () => {
  it("「修改密码」→ 打开 ChangePasswordDialog（含三字段）", async () => {
    const onLogout = vi.fn();
    render(
      <UserMenu
        currentUser={{ username: "alice", role: "user" } as CurrentUser}
        onLogout={onLogout}
        authFetch={noopAuthFetch}
      />,
    );

    fireEvent.click(screen.getByTitle("用户菜单"));
    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));

    await waitFor(() => expect(screen.getByPlaceholderText("当前密码")).toBeTruthy());
    expect(screen.getByPlaceholderText("新密码")).toBeTruthy();
    expect(screen.getByPlaceholderText("确认新密码")).toBeTruthy();
  });

  it("「登出」→ 调用 onLogout（ChatView 传 handleLogout：POST /api/logout + 清登录态）", () => {
    const onLogout = vi.fn();
    render(
      <UserMenu
        currentUser={{ username: "alice", role: "user" } as CurrentUser}
        onLogout={onLogout}
        authFetch={noopAuthFetch}
      />,
    );

    fireEvent.click(screen.getByTitle("用户菜单"));
    fireEvent.click(screen.getByRole("button", { name: "登出" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("菜单打开后点击外部 → 关闭菜单（不调 onLogout、不打开弹窗）", () => {
    const onLogout = vi.fn();
    render(
      <UserMenu
        currentUser={{ username: "alice", role: "user" } as CurrentUser}
        onLogout={onLogout}
        authFetch={noopAuthFetch}
      />,
    );

    fireEvent.click(screen.getByTitle("用户菜单"));
    expect(screen.getByRole("button", { name: "登出" })).toBeTruthy();

    // 透明 click-catcher（fixed inset-0）接住外部点击
    const catcher = document.querySelector("div.fixed.inset-0") as HTMLElement;
    expect(catcher).toBeTruthy();
    fireEvent.click(catcher);

    expect(screen.queryByRole("button", { name: "登出" })).toBeNull();
    expect(onLogout).not.toHaveBeenCalled();
  });
});

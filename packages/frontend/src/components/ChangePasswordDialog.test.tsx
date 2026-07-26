// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import type { CurrentUser } from "../hooks/useBrowserAuth";

// 复用 AdminView.test.tsx 的 mockResponse 形状：useBrowserAuth.authFetch 仅读 ok/status/json。
function mockResponse(ok: boolean, body: unknown = {}, status?: number): Response {
  const resp = {
    ok,
    status: status ?? (ok ? 200 : 400),
    json: async () => body,
    clone() { return resp; },
  };
  return resp as unknown as Response;
}

const user: CurrentUser = { username: "alice", role: "user" };

// authFetch 的最小 mock：仅关心 url + body，返回 mockResponse；status=400 时透传给组件逻辑。
function makeAuthFetch(respFn: (url: string, init?: RequestInit) => { ok: boolean; body?: unknown; status?: number }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const { ok, body, status } = respFn(url, init);
    return mockResponse(ok, body ?? {}, status);
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChangePasswordDialog — 确认一致性校验（纯前端）", () => {
  it("新密码与确认不一致 → 提示且禁用提交，不发请求", async () => {
    const authFetch = makeAuthFetch(() => ({ ok: true, body: { ok: true } }));
    render(<ChangePasswordDialog currentUser={user} authFetch={authFetch} onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("当前密码"), { target: { value: "old" } });
    fireEvent.change(screen.getByPlaceholderText("新密码"), { target: { value: "new1" } });
    fireEvent.change(screen.getByPlaceholderText("确认新密码"), { target: { value: "new2" } });

    expect(screen.getByText("两次输入的新密码不一致")).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认修改" })).toHaveProperty("disabled", true);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("三字段空时 → 禁用提交，不发请求", () => {
    const authFetch = makeAuthFetch(() => ({ ok: true, body: { ok: true } }));
    render(<ChangePasswordDialog currentUser={user} authFetch={authFetch} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "确认修改" })).toHaveProperty("disabled", true);
    expect(authFetch).not.toHaveBeenCalled();
  });
});

describe("ChangePasswordDialog — 提交体形状", () => {
  it("三字段一致且非空 → 提交体只含 currentPassword / newPassword，不含确认字段", async () => {
    const authFetch = makeAuthFetch(() => ({ ok: true, body: { ok: true } }));
    const onClose = vi.fn();
    render(<ChangePasswordDialog currentUser={user} authFetch={authFetch} onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText("当前密码"), { target: { value: "old-pw" } });
    fireEvent.change(screen.getByPlaceholderText("新密码"), { target: { value: "new-pw" } });
    fireEvent.change(screen.getByPlaceholderText("确认新密码"), { target: { value: "new-pw" } });
    fireEvent.click(screen.getByRole("button", { name: "确认修改" }));

    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toContain("/api/me/password");
    expect(init?.method).toBe("POST");
    const body = JSON.parse((init!.body as string));
    expect(body).toEqual({ currentPassword: "old-pw", newPassword: "new-pw" });
    expect("confirmPassword" in body).toBe(false);

    // 成功后关闭弹窗
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe("ChangePasswordDialog — 错误响应（不被 401 拦截器误判）", () => {
  it("relay 返回 400「当前密码错误」→ 弹窗内显示文案，不关闭弹窗，不抛 SESSION_EXPIRED", async () => {
    const authFetch = makeAuthFetch(() => ({
      ok: false,
      status: 400,
      body: { error: "当前密码错误" },
    }));
    const onClose = vi.fn();
    render(<ChangePasswordDialog currentUser={user} authFetch={authFetch} onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText("当前密码"), { target: { value: "wrong-old" } });
    fireEvent.change(screen.getByPlaceholderText("新密码"), { target: { value: "new-pw" } });
    fireEvent.change(screen.getByPlaceholderText("确认新密码"), { target: { value: "new-pw" } });
    fireEvent.click(screen.getByRole("button", { name: "确认修改" }));

    await waitFor(() => expect(screen.getByText("当前密码错误")).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("relay 返回 400「新密码不能为空」→ 展示 relay 文案", async () => {
    const authFetch = makeAuthFetch(() => ({
      ok: false,
      status: 400,
      body: { error: "新密码不能为空" },
    }));
    render(<ChangePasswordDialog currentUser={user} authFetch={authFetch} onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("当前密码"), { target: { value: "old" } });
    fireEvent.change(screen.getByPlaceholderText("新密码"), { target: { value: "n" } });
    fireEvent.change(screen.getByPlaceholderText("确认新密码"), { target: { value: "n" } });
    fireEvent.click(screen.getByRole("button", { name: "确认修改" }));

    await waitFor(() => expect(screen.getByText("新密码不能为空")).toBeTruthy());
  });
});

import { useState, useCallback } from "react";
import { createPortal } from "react-dom";
import type { CurrentUser } from "../hooks/useBrowserAuth";

// 修改密码弹窗（issue #38）。
//
// 与 AdminView 的 reset 弹窗形成术语二分（见 CONTEXT.md）：
//   - changePassword（这里）：用户改自己、必须验旧密码、对所有角色一致
//   - resetPassword（AdminView）：admin 改别人、不验旧、目标只能是普通 user
//
// 样式刻意复用 AdminView reset 弹窗（同样的 modal 外壳 / input / 按钮类）——视觉一致 + 减少设计面。
//
// 旧密码错时 relay 返回 400（非 401，见 relay me-routes 注释），authFetch 拦截器仅对 401 清登录态，
// 故此处收到 400 后直接显示「当前密码错误」，用户不会被踢下线。

interface ChangePasswordDialogProps {
  currentUser: CurrentUser;
  /** 走 httpOnly cookie 的认证 fetch（401 时由拦截器清登录态；400 不动）。 */
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onClose: () => void;
  /** 改密成功后可选回调（如显示全局 notice）。 */
  onSuccess?: () => void;
}

const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500";

export function ChangePasswordDialog({ currentUser, authFetch, onClose, onSuccess }: ChangePasswordDialogProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const mismatch = newPassword !== "" && confirmPassword !== "" && newPassword !== confirmPassword;
  const canSubmit = currentPassword !== "" && newPassword !== "" && confirmPassword !== "" && !mismatch && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      // 提交体严格只含 currentPassword / newPassword —— 不发确认字段。
      const r = await authFetch("/api/me/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await r.json() as { ok?: boolean; error?: string };
      if (!r.ok) {
        // 旧密码错 / 新密码空 都走 400；relay 已规范文案，直接展示。
        setError(data.error || "修改失败");
        return;
      }
      onSuccess?.();
      onClose();
    } catch {
      // authFetch 在 401 时抛 SESSION_EXPIRED —— 此时已被拦截器清登录态回登录页，
      // 此弹窗会随 ChatView 切到登录表单而卸载；其它网络异常落到通用错误。
      setError("网络错误");
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, currentPassword, newPassword, authFetch, onSuccess, onClose]);

  // 用 Portal 渲染到 document.body：本弹窗由 UserMenu 挂载在 ChatView 顶栏 header 内，而 header 带
  // backdrop-blur-sm（backdrop-filter）——它会成为后代 position:fixed 的包含块，导致 inset-0 相对
  // header（一条矮横条）而非视口，弹窗被锚到顶栏、顶部（含「当前密码」框）溢出视口上方而不可见。
  // Portal 脱离该祖先，fixed 重新相对视口，弹窗正常全屏居中。
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm bg-white dark:bg-slate-800 rounded-lg shadow-xl p-5">
        <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200 mb-1">修改密码</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          为用户 {currentUser.username} 设置新密码
        </p>
        <div className="space-y-3 mb-3">
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="当前密码"
            autoFocus
            autoComplete="current-password"
            className={INPUT_CLS}
          />
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="新密码"
            autoComplete="new-password"
            className={INPUT_CLS}
          />
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="确认新密码"
            autoComplete="new-password"
            className={INPUT_CLS}
          />
          {mismatch && (
            <p className="text-xs text-red-500">两次输入的新密码不一致</p>
          )}
          {error && (
            <p className="text-xs text-red-500">{error}</p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
          >
            {submitting ? "修改中…" : "确认修改"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

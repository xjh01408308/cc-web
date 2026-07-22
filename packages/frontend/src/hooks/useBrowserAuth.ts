import { useState, useCallback, useEffect, useRef } from "react";

// 浏览器层认证（用户名 + 密码登录，httpOnly cookie session）。
// "auth" 是 overloaded 词，见 CONTEXT.md（Node 操作授权另见 Assignment）。

/** 当前登录用户身份（来自 /api/session 或 /api/login 回传）。admin 入口、/admin 守卫据此判断角色。 */
export interface CurrentUser {
  username: string;
  role: string;
}

export function useBrowserAuth() {
  const [authed, setAuthed] = useState(false);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  // session 探测是否完成（mount effect 落定后置 true）。AdminView 守卫据此区分"探测中"与"未登录"，
  // 避免探测窗口期误判 role 而过早跳转。
  const [sessionChecked, setSessionChecked] = useState(false);
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);

  // 初始加载守卫：clearSession 重置它，以便重新登录后能重新加载数据。
  // 暴露给 ChatView 的初始加载 god effect 读取（该 effect 是协调层，不抽 hook）。
  const initialLoadDone = useRef(false);

  // 清除登录态：session 失效或主动登出时调用，重置加载守卫以便重新登录后能正常加载数据
  const clearSession = useCallback(() => {
    initialLoadDone.current = false;
    setAuthed(false);
    setCurrentUser(null);
  }, []);

  // 所有受保护接口走 httpOnly cookie（credentials:'include'），token 不进 JS。
  // 可选 init 透传 method/headers/body（admin CRUD 的 POST/DELETE 等需要）。
  const authFetch = useCallback(async (url: string, init?: RequestInit) => {
    const resp = await fetch(url, { credentials: 'include', ...init });
    if (resp.status === 401) {
      // session 失效（未认证）→ 清登录态回登录页
      clearSession();
      throw new Error('SESSION_EXPIRED');
    }
    return resp;
  }, [clearSession]);

  // 初始化：httpOnly cookie 不可被 JS 读取，探测现有 session 是否仍有效。
  // dev 模式由 relay 侧 getSession 旁路（/api/session 直接返回 ok），故无需前端自动登录。
  // 探测成功时一并捕获当前用户身份（role 供 admin 入口 / /admin 守卫判断）。
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/session", { credentials: "include" });
        if (r.ok) {
          const data = await r.json() as { user?: { username?: string; role?: string } };
          setAuthed(true);
          if (data.user?.username && data.user?.role) {
            setCurrentUser({ username: data.user.username, role: data.user.role });
          }
        }
      } catch { /* 网络异常，停留在登录页 */ }
      setSessionChecked(true);
    })();
  }, []);

  const handleLogin = useCallback(async () => {
    setLoginLoading(true);
    setLoginError(null);
    try {
      const resp = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginUsername, password: loginPassword }),
        credentials: "include",
      });
      if (resp.ok) {
        const data = await resp.json() as { user?: { username?: string; role?: string } };
        setAuthed(true);
        if (data.user?.username && data.user?.role) {
          setCurrentUser({ username: data.user.username, role: data.user.role });
        }
      } else {
        const data = await resp.json();
        setLoginError(data.error || "登录失败");
      }
    } catch {
      setLoginError("网络错误");
    } finally {
      setLoginLoading(false);
    }
  }, [loginUsername, loginPassword]);

  const handleLogout = useCallback(() => {
    fetch("/api/logout", { method: "POST", credentials: "include" }).catch(() => {});
    clearSession();
  }, [clearSession]);

  return {
    authed,
    currentUser,
    sessionChecked,
    loginUsername,
    setLoginUsername,
    loginPassword,
    setLoginPassword,
    loginError,
    loginLoading,
    clearSession,
    authFetch,
    handleLogin,
    handleLogout,
    initialLoadDone,
  };
}

import { useState, useCallback, useEffect, useRef } from "react";

// 浏览器层认证（用户名 + 密码登录，httpOnly cookie session）。与节点层认证（useNodeAuth，PR-5）
// 是两套独立 state，不合 useAuth —— "auth" 是 overloaded 词，见 CONTEXT.md。
export function useBrowserAuth() {
  const [authed, setAuthed] = useState(false);
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
  }, []);

  // 所有受保护接口走 httpOnly cookie（credentials:'include'），token 不进 JS
  const authFetch = useCallback(async (url: string) => {
    const resp = await fetch(url, { credentials: 'include' });
    if (resp.status === 401) {
      // 区分两种 401：节点密码拦截（auth_required）透传 response 给调用方弹节点密码框；
      // 仅 session 失效（未认证）才清登录态回登录页。
      const data = await resp.clone().json().catch(() => null) as { error?: string } | null;
      if (data?.error === 'auth_required') return resp;
      clearSession();
      throw new Error('SESSION_EXPIRED');
    }
    return resp;
  }, [clearSession]);

  // 初始化：httpOnly cookie 不可被 JS 读取，探测现有 session 是否仍有效。
  // dev 模式由 relay 侧 getSession 旁路（/api/session 直接返回 ok），故无需前端自动登录。
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/session", { credentials: "include" });
        if (r.ok) setAuthed(true);
      } catch { /* 网络异常，停留在登录页 */ }
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
        setAuthed(true);
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

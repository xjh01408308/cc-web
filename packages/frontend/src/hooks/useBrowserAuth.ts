import { useState, useCallback, useEffect, useRef } from "react";

// 浏览器层认证（httpOnly cookie 访问密码）。与节点层认证（useNodeAuth，PR-5）
// 是两套独立 state，不合 useAuth —— "auth" 是 overloaded 词，见 CONTEXT.md。
export function useBrowserAuth() {
  const [authed, setAuthed] = useState(false);
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
  const authFetch = useCallback((url: string) => {
    return fetch(url, { credentials: 'include' }).then((resp) => {
      // session 失效 → 清除并回到登录页
      if (resp.status === 401) {
        clearSession();
        throw new Error('SESSION_EXPIRED');
      }
      return resp;
    });
  }, [clearSession]);

  // 初始化：httpOnly cookie 不可被 JS 读取，先探测现有 session；未登录时尝试 dev 无密码自动登录
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/session", { credentials: "include" });
        if (r.ok) { setAuthed(true); return; }
      } catch { /* 网络异常，继续尝试自动登录 */ }
      try {
        const r = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "" }),
          credentials: "include",
        });
        if (r.ok) setAuthed(true);
      } catch { /* 停留在登录页 */ }
    })();
  }, []);

  const handleLogin = useCallback(async () => {
    setLoginLoading(true);
    setLoginError(null);
    try {
      const resp = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: loginPassword }),
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
  }, [loginPassword]);

  const handleLogout = useCallback(() => {
    fetch("/api/logout", { method: "POST", credentials: "include" }).catch(() => {});
    clearSession();
  }, [clearSession]);

  return {
    authed,
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

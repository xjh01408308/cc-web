import { useState, useCallback, useEffect, useRef } from "react";
import { useBrowserAuth } from "../hooks/useBrowserAuth";
import { formatAbsoluteTime } from "../utils/time";

// /api/admin/users 返回的用户项（与 relay PublicUser 对齐：不含 password_hash）。
interface AdminUser {
  id: string;
  username: string;
  role: string;
  createdAt: number;
}

// /api/admin/nodes 返回的预注册 Node 项（与 relay PublicNode 对齐：不含 secret_hash）。
interface AdminNode {
  id: string;
  nodeId: string;
  createdAt: number;
}

// admin 管理视图（issue #22）：admin 登录后经 /admin 进入，对普通 user 做 CRUD。
// 守卫三层：未探测完成→loading；未登录→回 /（登录）；非 admin→无权限提示。
// 授权完全由 relay 侧 requireAdmin 强制（401/403），本视图的隐藏入口只是 UX，非安全边界。
export function AdminView() {
  const { authed, currentUser, sessionChecked, authFetch, handleLogout } = useBrowserAuth();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 创建用户表单
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [creating, setCreating] = useState(false);

  // 重置密码弹窗
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetting, setResetting] = useState(false);

  // Node 预注册（issue #23）
  const [nodes, setNodes] = useState<AdminNode[]>([]);
  const [nodesLoading, setNodesLoading] = useState(true);
  const [newNodeId, setNewNodeId] = useState("");
  const [creatingNode, setCreatingNode] = useState(false);
  // 创建/轮转后的一次性明文 nodeSecret 展示（仅此一次，关闭后不再可查）
  const [revealedSecret, setRevealedSecret] = useState<{ nodeId: string; secret: string } | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  const listLoaded = useRef(false);

  const loadUsers = useCallback(async () => {
    setListLoading(true);
    setError(null);
    try {
      const r = await authFetch("/api/admin/users");
      const data = await r.json();
      if (!r.ok) {
        setError((data as { error?: string }).error || "加载用户列表失败");
        return;
      }
      setUsers(data as AdminUser[]);
    } catch {
      setError("网络错误");
    } finally {
      setListLoading(false);
    }
  }, [authFetch]);

  const loadNodes = useCallback(async () => {
    setNodesLoading(true);
    setError(null);
    try {
      const r = await authFetch("/api/admin/nodes");
      const data = await r.json();
      if (!r.ok) {
        setError((data as { error?: string }).error || "加载节点列表失败");
        return;
      }
      setNodes(data as AdminNode[]);
    } catch {
      setError("网络错误");
    } finally {
      setNodesLoading(false);
    }
  }, [authFetch]);

  // 确认为 admin 后加载一次列表（用户 + Node）
  useEffect(() => {
    if (currentUser?.role !== "admin" || listLoaded.current) return;
    listLoaded.current = true;
    loadUsers();
    loadNodes();
  }, [currentUser, loadUsers, loadNodes]);

  const handleCreate = useCallback(async () => {
    const username = newUsername.trim();
    if (!username || !newPassword) {
      setError("用户名和密码不能为空");
      return;
    }
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const r = await authFetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: newPassword }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError((data as { error?: string }).error || "创建失败");
        return;
      }
      setNewUsername("");
      setNewPassword("");
      setNotice(`已创建用户 ${username}`);
      await loadUsers();
    } catch {
      setError("网络错误");
    } finally {
      setCreating(false);
    }
  }, [newUsername, newPassword, authFetch, loadUsers]);

  const handleResetSubmit = useCallback(async () => {
    if (!resetTarget || !resetPassword) {
      setError("新密码不能为空");
      return;
    }
    setResetting(true);
    setError(null);
    setNotice(null);
    try {
      const r = await authFetch(`/api/admin/users/${resetTarget.id}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: resetPassword }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError((data as { error?: string }).error || "重置失败");
        return;
      }
      setNotice(`已重置 ${resetTarget.username} 的密码`);
      setResetTarget(null);
      setResetPassword("");
    } catch {
      setError("网络错误");
    } finally {
      setResetting(false);
    }
  }, [resetTarget, resetPassword, authFetch]);

  const handleDelete = useCallback(async (u: AdminUser) => {
    if (!window.confirm(`确认删除用户 ${u.username}？此操作不可撤销。`)) return;
    setError(null);
    setNotice(null);
    try {
      const r = await authFetch(`/api/admin/users/${u.id}`, { method: "DELETE" });
      const data = await r.json();
      if (!r.ok) {
        setError((data as { error?: string }).error || "删除失败");
        return;
      }
      setNotice(`已删除用户 ${u.username}`);
      await loadUsers();
    } catch {
      setError("网络错误");
    }
  }, [authFetch, loadUsers]);

  // Node 预注册：创建后明文 secret 仅展示一次（relay 仅存 scrypt 哈希，丢失需轮转重发）。
  const handleCreateNode = useCallback(async () => {
    const nodeId = newNodeId.trim();
    if (!nodeId) {
      setError("节点 ID 不能为空");
      return;
    }
    setCreatingNode(true);
    setError(null);
    setNotice(null);
    try {
      const r = await authFetch("/api/admin/nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError((data as { error?: string }).error || "创建失败");
        return;
      }
      const created = data as { node: AdminNode; secret: string };
      setNewNodeId("");
      setRevealedSecret({ nodeId: created.node.nodeId, secret: created.secret });
      setSecretCopied(false);
      await loadNodes();
    } catch {
      setError("网络错误");
    } finally {
      setCreatingNode(false);
    }
  }, [newNodeId, authFetch, loadNodes]);

  // 轮转 nodeSecret：旧 secret 立即失效，新 secret 仅展示一次。
  const handleRotateSecret = useCallback(async (n: AdminNode) => {
    if (!window.confirm(`确认轮转节点 ${n.nodeId} 的 nodeSecret？旧 secret 立即失效，正在使用它的 local 需更新配置重连。`)) return;
    setError(null);
    setNotice(null);
    try {
      const r = await authFetch(`/api/admin/nodes/${n.id}/rotate-secret`, { method: "POST" });
      const data = await r.json();
      if (!r.ok) {
        setError((data as { error?: string }).error || "轮转失败");
        return;
      }
      setRevealedSecret({ nodeId: n.nodeId, secret: (data as { secret: string }).secret });
      setSecretCopied(false);
    } catch {
      setError("网络错误");
    }
  }, [authFetch]);

  const handleDeleteNode = useCallback(async (n: AdminNode) => {
    if (!window.confirm(`确认删除预注册节点 ${n.nodeId}？正在使用它的 local 将无法再连上。此操作不可撤销。`)) return;
    setError(null);
    setNotice(null);
    try {
      const r = await authFetch(`/api/admin/nodes/${n.id}`, { method: "DELETE" });
      const data = await r.json();
      if (!r.ok) {
        setError((data as { error?: string }).error || "删除失败");
        return;
      }
      setNotice(`已删除节点 ${n.nodeId}`);
      await loadNodes();
    } catch {
      setError("网络错误");
    }
  }, [authFetch, loadNodes]);

  const handleCopySecret = useCallback(async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      setSecretCopied(true);
    } catch {
      // 剪贴板不可用时静默（用户可手动选中复制）
    }
  }, []);

  // 守卫：未登录 → 回首页登录（放 effect 里执行跳转，避免渲染期副作用 / StrictMode 重复触发）
  useEffect(() => {
    if (sessionChecked && !authed) window.location.href = "/";
  }, [sessionChecked, authed]);

  // 守卫：探测中
  if (!sessionChecked) {
    return (
      <div className="flex h-dvh items-center justify-center bg-slate-50 dark:bg-slate-900">
        <span className="text-sm text-slate-500 dark:text-slate-400">加载中…</span>
      </div>
    );
  }

  // 守卫：未登录 → effect 已触发跳转，渲染占位
  if (!authed) {
    return null;
  }

  // 守卫：非 admin
  if (currentUser?.role !== "admin") {
    return (
      <div className="flex h-dvh items-center justify-center bg-slate-50 dark:bg-slate-900">
        <div className="text-center">
          <p className="text-sm text-slate-600 dark:text-slate-300">需要管理员权限才能访问此页面。</p>
          <a href="/" className="mt-3 inline-block text-sm text-blue-600 dark:text-blue-400 hover:underline">返回首页</a>
        </div>
      </div>
    );
  }

  const inputCls = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500";

  return (
    <div className="h-dvh bg-slate-50 dark:bg-slate-900 overflow-auto">
      <div className="max-w-3xl mx-auto p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100">cc-web 管理</h1>
          <div className="flex items-center gap-3">
            <a href="/" className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">返回</a>
            <button
              onClick={handleLogout}
              className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
              登出
            </button>
          </div>
        </div>

        {error && <p className="mb-4 text-sm text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded">{error}</p>}
        {notice && <p className="mb-4 text-sm text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2 rounded">{notice}</p>}

        {/* 创建用户 */}
        <section className="mb-8 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-4">
          <h2 className="text-sm font-medium text-slate-700 dark:text-slate-200 mb-3">创建用户</h2>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="用户名"
              className={inputCls}
              autoComplete="username"
            />
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="初始密码"
              className={inputCls}
              autoComplete="new-password"
            />
            <button
              onClick={handleCreate}
              disabled={creating}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600 whitespace-nowrap"
            >
              {creating ? "创建中…" : "创建"}
            </button>
          </div>
        </section>

        {/* 用户列表 */}
        <section className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <h2 className="text-sm font-medium text-slate-700 dark:text-slate-200 px-4 py-3 border-b border-slate-200 dark:border-slate-700">用户列表</h2>
          {listLoading ? (
            <p className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">加载中…</p>
          ) : users.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">暂无用户</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900/40 text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="text-left font-medium px-4 py-2">用户名</th>
                  <th className="text-left font-medium px-4 py-2">角色</th>
                  <th className="text-left font-medium px-4 py-2 hidden sm:table-cell">创建时间</th>
                  <th className="text-right font-medium px-4 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-slate-100 dark:border-slate-700">
                    <td className="px-4 py-2 text-slate-800 dark:text-slate-100">{u.username}</td>
                    <td className="px-4 py-2">
                      <span className={`inline-block text-xs px-2 py-0.5 rounded ${u.role === "admin" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" : "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300"}`}>
                        {u.role}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-slate-500 dark:text-slate-400 hidden sm:table-cell">{formatAbsoluteTime(u.createdAt)}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {u.role === "user" ? (
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => { setResetTarget(u); setResetPassword(""); setError(null); }}
                            className="text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                          >
                            重置密码
                          </button>
                          <button
                            onClick={() => handleDelete(u)}
                            className="text-xs px-2 py-1 rounded border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                          >
                            删除
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* 预注册 Node */}
        <section className="mb-8 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-4">
          <h2 className="text-sm font-medium text-slate-700 dark:text-slate-200 mb-1">预注册 Node</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
            预注册后生成 (nodeId, nodeSecret)，配置到 local .env（NODE_ID / NODE_SECRET）即可连上。nodeSecret 仅展示一次，丢失需轮转重发。
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={newNodeId}
              onChange={(e) => setNewNodeId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreateNode()}
              placeholder="节点 ID（如 dev-laptop）"
              className={inputCls}
            />
            <button
              onClick={handleCreateNode}
              disabled={creatingNode}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600 whitespace-nowrap"
            >
              {creatingNode ? "创建中…" : "预注册"}
            </button>
          </div>
        </section>

        {/* Node 列表 */}
        <section className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <h2 className="text-sm font-medium text-slate-700 dark:text-slate-200 px-4 py-3 border-b border-slate-200 dark:border-slate-700">预注册 Node 列表</h2>
          {nodesLoading ? (
            <p className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">加载中…</p>
          ) : nodes.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">暂无预注册节点</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900/40 text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="text-left font-medium px-4 py-2">节点 ID</th>
                  <th className="text-left font-medium px-4 py-2 hidden sm:table-cell">创建时间</th>
                  <th className="text-right font-medium px-4 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((n) => (
                  <tr key={n.id} className="border-t border-slate-100 dark:border-slate-700">
                    <td className="px-4 py-2 text-slate-800 dark:text-slate-100 font-mono text-xs">{n.nodeId}</td>
                    <td className="px-4 py-2 text-slate-500 dark:text-slate-400 hidden sm:table-cell">{formatAbsoluteTime(n.createdAt)}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => handleRotateSecret(n)}
                          className="text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                        >
                          轮转 secret
                        </button>
                        <button
                          onClick={() => handleDeleteNode(n)}
                          className="text-xs px-2 py-1 rounded border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {/* 重置密码弹窗 */}
      {resetTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm bg-white dark:bg-slate-800 rounded-lg shadow-xl p-5">
            <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200 mb-1">重置密码</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">为用户 {resetTarget.username} 设置新密码</p>
            <input
              type="password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleResetSubmit()}
              placeholder="新密码"
              autoFocus
              className={inputCls + " mb-3"}
              autoComplete="new-password"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setResetTarget(null); setResetPassword(""); }}
                className="text-sm px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
              >
                取消
              </button>
              <button
                onClick={handleResetSubmit}
                disabled={resetting}
                className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
              >
                {resetting ? "重置中…" : "确认重置"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* nodeSecret 一次性展示（创建/轮转后） */}
      {revealedSecret && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-800 rounded-lg shadow-xl p-5">
            <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200 mb-1">
              节点 {revealedSecret.nodeId} 的 nodeSecret
            </h3>
            <p className="text-xs text-amber-600 dark:text-amber-400 mb-3">
              ⚠️ 仅展示一次，关闭后无法再查。请立即复制并配置到 local .env（NODE_ID / NODE_SECRET）。
            </p>
            <div className="flex items-center gap-2 mb-4">
              <code className="flex-1 rounded bg-slate-100 dark:bg-slate-900 px-3 py-2 text-xs text-slate-800 dark:text-slate-100 break-all font-mono">
                {revealedSecret.secret}
              </code>
              <button
                onClick={() => handleCopySecret(revealedSecret.secret)}
                className="text-xs px-3 py-2 rounded border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 whitespace-nowrap"
              >
                {secretCopied ? "已复制" : "复制"}
              </button>
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => setRevealedSecret(null)}
                className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
              >
                我已保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

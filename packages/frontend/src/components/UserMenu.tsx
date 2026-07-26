import { useState, useCallback } from "react";
import type { CurrentUser } from "../hooks/useBrowserAuth";
import { ChangePasswordDialog } from "./ChangePasswordDialog";

// ChatView 顶栏的用户菜单（issue #38）：对所有已登录角色可见。
// 菜单项：「修改密码」打开 ChangePasswordDialog；「登出」调用既有 handleLogout。
//
// admin 的「管理」链接由 ChatView 原位保留（不塞进本菜单——避免给普通 user 一个点了报错的入口）。

interface UserMenuProps {
  currentUser: CurrentUser;
  /** 既有 useBrowserAuth.handleLogout（POST /api/logout + 清登录态 + 回登录页）。 */
  onLogout: () => void;
  /** 走 httpOnly cookie 的认证 fetch，透传给 ChangePasswordDialog。 */
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export function UserMenu({ currentUser, onLogout, authFetch }: UserMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleOpenChangePassword = useCallback(() => {
    setMenuOpen(false);
    setDialogOpen(true);
  }, []);

  const handleLogoutClick = useCallback(() => {
    setMenuOpen(false);
    onLogout();
  }, [onLogout]);

  return (
    <div className="relative">
      <button
        onClick={() => setMenuOpen((v) => !v)}
        className="flex items-center gap-1 text-xs px-2 py-1 rounded-md text-slate-600 hover:text-slate-800 dark:text-slate-300 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
        title="用户菜单"
      >
        <span className="max-w-[8rem] truncate">{currentUser.username}</span>
        <svg
          className={`w-3 h-3 transition-transform ${menuOpen ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {menuOpen && (
        <>
          {/* 透明全屏 click-catcher：点击外部关闭菜单（不动 dom 目标事件） */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenuOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute right-0 top-full mt-1 z-50 min-w-[10rem] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md shadow-lg overflow-hidden">
            <button
              onClick={handleOpenChangePassword}
              className="block w-full text-left px-3 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              修改密码
            </button>
            <button
              onClick={handleLogoutClick}
              className="block w-full text-left px-3 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 border-t border-slate-100 dark:border-slate-700"
            >
              登出
            </button>
          </div>
        </>
      )}

      {dialogOpen && (
        <ChangePasswordDialog
          currentUser={currentUser}
          authFetch={authFetch}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  );
}

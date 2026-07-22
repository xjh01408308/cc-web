// /api/admin/users* 路由处理器 + admin 守卫（issue #22）。
//
// 守卫 requireAdmin 统一强制 admin 角色（未登录 401、非 admin 403），是"角色与操作权限在
// Relay 侧 API 强制"的落点。后续 Node 管理 / Assignment 授权路由可复用同一守卫模式。
//
// 本模块不解析 session（cookie/Authorization）——那是 index.ts 的职责；index.ts 解析出
// session 后作为 AdminRouteDeps.session 传入，故本模块纯逻辑、无副作用，可独立单测。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UserStore, UserRole } from './user-store.js';
import { jsonResponse, readBody } from './http-utils.js';

/** 当前 session 的管理视图子集（index.ts 的 Session 结构兼容：含 userId/username/role 即可） */
export interface AdminSession {
  userId: string;
  username: string;
  role: UserRole;
}

export interface AdminRouteDeps {
  session: AdminSession | null;
  userStore: UserStore;
}

/**
 * admin 守卫：未登录 → 401，非 admin → 403。放行返回 true（并 narrows session 为非 null）。
 * 这是"角色与操作权限在 Relay 侧强制"的落点（issue #22 AC），不依赖前端隐藏入口。
 */
function requireAdmin(res: ServerResponse, session: AdminSession | null): session is AdminSession {
  if (!session) {
    jsonResponse(res, { error: '未认证' }, 401);
    return false;
  }
  if (session.role !== 'admin') {
    jsonResponse(res, { error: '需要管理员权限' }, 403);
    return false;
  }
  return true;
}

/** 校验目标账户必须是普通 user —— admin 只能管理 user，禁止改/删管理员（防自删、防互删）。 */
function ensureTargetIsUser(res: ServerResponse, store: UserStore, id: string): { id: string } | null {
  const target = store.getUserById(id);
  if (!target) {
    jsonResponse(res, { error: '用户不存在' }, 404);
    return null;
  }
  if (target.role !== 'user') {
    jsonResponse(res, { error: '只能管理普通用户' }, 400);
    return null;
  }
  return { id: target.id };
}

/**
 * 处理 /api/admin/users* 路由。返回 true 表示已处理（已结束响应）；false 表示 URL 不归本处理器
 * （index.ts 继续向下匹配）。admin 只能管理 role==='user' 的账户——创建固定 user 角色，
 * 重置/删除前经 ensureTargetIsUser 校验，天然防提权与自删。
 */
export async function handleAdminUsersRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRouteDeps,
): Promise<boolean> {
  const url = req.url || '';
  const method = req.method || '';
  if (!url.startsWith('/api/admin/users')) return false;

  const segments = url.split('?')[0].split('/').filter(Boolean); // ['api','admin','users', ...]

  // /api/admin/users —— 列表 / 创建
  if (segments.length === 3) {
    if (method === 'GET') {
      if (!requireAdmin(res, deps.session)) return true;
      jsonResponse(res, deps.userStore.listUsers());
      return true;
    }
    if (method === 'POST') {
      if (!requireAdmin(res, deps.session)) return true;
      try {
        const parsed = JSON.parse((await readBody(req)) || '{}') as { username?: unknown; password?: unknown; role?: unknown };
        const username = typeof parsed.username === 'string' ? parsed.username.trim() : '';
        const password = typeof parsed.password === 'string' ? parsed.password : '';
        if (!username || !password) {
          jsonResponse(res, { error: '用户名和密码不能为空' }, 400);
          return true;
        }
        // 角色强制 user（忽略 body.role）——admin 经此端点只能建普通 user，无提权路径。
        try {
          deps.userStore.createUser(username, password, 'user');
        } catch {
          jsonResponse(res, { error: '用户名已存在' }, 409);
          return true;
        }
        jsonResponse(res, { ok: true });
        return true;
      } catch {
        jsonResponse(res, { error: '请求格式错误' }, 400);
        return true;
      }
    }
    return false;
  }

  // /api/admin/users/:id/reset-password
  if (segments.length === 5 && segments[4] === 'reset-password' && method === 'POST') {
    if (!requireAdmin(res, deps.session)) return true;
    const target = ensureTargetIsUser(res, deps.userStore, segments[3]);
    if (!target) return true;
    try {
      const parsed = JSON.parse((await readBody(req)) || '{}') as { password?: unknown };
      const password = typeof parsed.password === 'string' ? parsed.password : '';
      if (!password) {
        jsonResponse(res, { error: '密码不能为空' }, 400);
        return true;
      }
      deps.userStore.resetPassword(target.id, password);
      jsonResponse(res, { ok: true });
      return true;
    } catch {
      jsonResponse(res, { error: '请求格式错误' }, 400);
      return true;
    }
  }

  // /api/admin/users/:id —— 删除
  if (segments.length === 4 && method === 'DELETE') {
    if (!requireAdmin(res, deps.session)) return true;
    const target = ensureTargetIsUser(res, deps.userStore, segments[3]);
    if (!target) return true;
    deps.userStore.deleteUser(target.id);
    jsonResponse(res, { ok: true });
    return true;
  }

  return false;
}

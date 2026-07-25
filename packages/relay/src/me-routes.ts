// /api/me/* 路由处理器（issue #37）。
//
// 用户自助端点：已登录用户（admin 或普通 user）改自己的密码。守卫为「已登录即可」
// （无 session → 401），不要求 admin；userId 从 session 取，绝不从请求体——调用方即便
// 在 body 里塞 userId 也会被忽略，杜绝越权改别人密码。
//
// 与 /api/admin/users/:id/reset-password（admin 重置别人密码）形成术语二分（见 CONTEXT.md）：
//   - changePassword（这里）：改自己、必须验旧、对所有角色一致
//   - resetPassword（admin-routes）：admin 改别人、不验旧、目标只能是普通 user
//
// 本模块不解析 session（cookie/Authorization）——那是 index.ts 的职责；index.ts 解析出
// session 后作为 MeRouteDeps.session 传入，故本模块纯逻辑、无副作用，可独立单测。
//
// dev 模式旁路：与 index.ts 的 getSession 一致——dev 模式下 session 为 synthetic admin
// （userId='dev'，不在 users 表），直接返回成功，否则 changePassword 必失败。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UserStore, UserRole } from './user-store.js';
import { jsonResponse, readBody } from './http-utils.js';
import { isDevMode } from './config.js';

/** 当前 session 的自助视图子集（index.ts 的 Session 兼容：含 userId/username/role 即可） */
export interface MeSession {
  userId: string;
  username: string;
  role: UserRole;
}

export interface MeRouteDeps {
  session: MeSession | null;
  userStore: UserStore;
}

/**
 * 处理 /api/me/* 路由。返回 true 表示已处理（已结束响应）；false 表示 URL 不归本处理器
 * （index.ts 继续向下匹配）。
 *
 * - POST /api/me/password  改自己的密码（全角色一致）
 *
 * 守卫：已登录即可（无 session → 401），**不** requireAdmin；userId 严格取自 session，
 * 不从请求体。失败响应严格用 400（旧密码错 / 新密码空），**严禁 401**——前端认证拦截器
 * 见 401 即清登录态，用 401 表达旧密码错会把还登录着的用户踢下线。
 */
export async function handleMeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MeRouteDeps,
): Promise<boolean> {
  const url = req.url || '';
  const method = req.method || '';
  if (!url.startsWith('/api/me/')) return false;

  // /api/me/password —— 改密码
  if (url.startsWith('/api/me/password') && method === 'POST') {
    // 守卫：已登录即可（无 session → 401）。userId 严格取自 session，绝不读 body。
    if (!deps.session) {
      jsonResponse(res, { error: '未认证' }, 401);
      return true;
    }

    // dev 模式旁路（与 getSession 一致）：dev 的 synthetic admin id='dev' 不在 users 表，
    // changePassword 必失败。直接返回成功，让本地开发免登录链路顺畅。
    if (isDevMode()) {
      jsonResponse(res, { ok: true });
      return true;
    }

    try {
      const parsed = JSON.parse((await readBody(req)) || '{}') as { currentPassword?: unknown; newPassword?: unknown };
      const newPassword = typeof parsed.newPassword === 'string' ? parsed.newPassword : '';
      if (!newPassword) {
        jsonResponse(res, { error: '新密码不能为空' }, 400);
        return true;
      }
      const currentPassword = typeof parsed.currentPassword === 'string' ? parsed.currentPassword : '';
      // changePassword 内部：id 不存在或旧密码错均返回 false（不区分，防用户名枚举）。
      // 失败用 400 而非 401：见模块注释。
      const ok = deps.userStore.changePassword(deps.session.userId, currentPassword, newPassword);
      if (!ok) {
        jsonResponse(res, { error: '当前密码错误' }, 400);
        return true;
      }
      // 改密后 session 不动（不踢下线、不续期）——直接返回 ok，不触碰 sessionTokens。
      jsonResponse(res, { ok: true });
      return true;
    } catch {
      jsonResponse(res, { error: '请求格式错误' }, 400);
      return true;
    }
  }

  return false;
}

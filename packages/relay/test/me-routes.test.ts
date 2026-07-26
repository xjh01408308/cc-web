import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';

// 必须在 import 被测模块前 mock：handler 的 dev mode 旁路依赖 isDevMode()。
// 测试覆盖生产路径（dev 旁路不触发），与 admin-routes.test 同型 mock req/res + 注入真实 store。
vi.mock('../src/config.js', () => ({
  isDevMode: () => false,
}));

import { handleMeRoute, __resetRateLimitForTests, type MeSession } from '../src/me-routes.js';
import { UserStore } from '../src/user-store.js';

// 临时 db（与 user-store.test 同构）。
function tmpUserStore(): { store: UserStore; cleanup: () => void } {
  const dbPath = path.join(os.tmpdir(), `cc-web-me-test-${randomUUID()}.db`);
  const store = new UserStore(dbPath);
  const cleanup = (): void => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  };
  return { store, cleanup };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  __resetRateLimitForTests();
});

function makeStore(): UserStore {
  const t = tmpUserStore();
  cleanups.push(t.cleanup);
  return t.store;
}

// 极简 req/res mock：只覆盖 me-routes 触碰的面（method/url/headers/on；writeHead/end）。
function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  const bodyStr = body !== undefined ? JSON.stringify(body) : '';
  const req = {
    method,
    url,
    headers: {},
    on(ev: string, cb: (...a: unknown[]) => void) { (handlers[ev] ||= []).push(cb); return req; },
    destroy() { return req; },
  };
  setImmediate(() => {
    if (bodyStr) (handlers['data'] || []).forEach((cb) => cb(Buffer.from(bodyStr)));
    (handlers['end'] || []).forEach((cb) => cb());
  });
  return req as unknown as IncomingMessage;
}

interface MockRes {
  res: ServerResponse;
  status: () => number;
  json: () => unknown;
}

function mockRes(): MockRes {
  let s = 0;
  let b = '';
  const res = {
    writeHead(status: number) { s = status; return res; },
    end(data?: string) { if (data != null) b = String(data); return res; },
  };
  return {
    res: res as unknown as ServerResponse,
    status: () => s,
    json: () => { try { return JSON.parse(b); } catch { return b; } },
  };
}

async function call(method: string, url: string, opts: { session: MeSession | null; body?: unknown; store: UserStore }): Promise<{ handled: boolean; status: number; json: unknown }> {
  const m = mockRes();
  const handled = await handleMeRoute(mockReq(method, url, opts.body), m.res, { session: opts.session, userStore: opts.store });
  return { handled, status: m.status(), json: m.json() };
}

describe('me-routes — 守卫（已登录即可，不要求 admin）', () => {
  it('未登录 → 401，已处理', async () => {
    const store = makeStore();
    store.createUser('alice', 'pw', 'user');
    const r = await call('POST', '/api/me/password', { session: null, store, body: { currentPassword: 'pw', newPassword: 'x' } });
    expect(r.handled).toBe(true);
    expect(r.status).toBe(401);
  });

  it('非 /api/me/ 前缀 → 不处理（handled=false）', async () => {
    const store = makeStore();
    const r = await call('GET', '/api/admin/users', { session: null, store });
    expect(r.handled).toBe(false);
  });
});

describe('me-routes — POST /api/me/password', () => {
  it('改密成功 → 200 { ok: true }，新密码可用、旧密码失效', async () => {
    const store = makeStore();
    const u = store.createUser('alice', 'old-pw', 'user');
    const session: MeSession = { userId: u.id, username: 'alice', role: 'user' };
    const r = await call('POST', '/api/me/password', { session, store, body: { currentPassword: 'old-pw', newPassword: 'new-pw' } });
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
    expect(store.authenticate('alice', 'old-pw')).toBeNull();
    expect(store.authenticate('alice', 'new-pw')).toBeTruthy();
  });

  it('旧密码错 → 400 { error: "当前密码错误" }（严禁 401，否则前端会踢下线）', async () => {
    const store = makeStore();
    const u = store.createUser('alice', 'old-pw', 'user');
    const session: MeSession = { userId: u.id, username: 'alice', role: 'user' };
    const r = await call('POST', '/api/me/password', { session, store, body: { currentPassword: 'WRONG', newPassword: 'new-pw' } });
    expect(r.status).toBe(400);
    expect((r.json as { error: string }).error).toBe('当前密码错误');
    // 原密码仍可用（哈希未变）
    expect(store.authenticate('alice', 'old-pw')).toBeTruthy();
  });

  it('新密码空 → 400 { error: "新密码不能为空" }', async () => {
    const store = makeStore();
    const u = store.createUser('alice', 'old-pw', 'user');
    const session: MeSession = { userId: u.id, username: 'alice', role: 'user' };
    const r = await call('POST', '/api/me/password', { session, store, body: { currentPassword: 'old-pw', newPassword: '' } });
    expect(r.status).toBe(400);
    expect((r.json as { error: string }).error).toBe('新密码不能为空');
  });

  it('userId 严格取自 session，body 里的 userId 被忽略（防越权改别人）', async () => {
    const store = makeStore();
    const me = store.createUser('alice', 'alice-pw', 'user');
    const victim = store.createUser('bob', 'bob-pw', 'user');
    const session: MeSession = { userId: me.id, username: 'alice', role: 'user' };
    // body 里刻意塞入 victim 的 userId，应被忽略——改的是 session 对应账户（alice）
    const r = await call('POST', '/api/me/password', {
      session,
      store,
      body: { userId: victim.id, currentPassword: 'alice-pw', newPassword: 'new-pw' },
    });
    expect(r.status).toBe(200);
    expect(store.authenticate('alice', 'new-pw')).toBeTruthy();
    // victim 密码不变
    expect(store.authenticate('bob', 'bob-pw')).toBeTruthy();
    expect(store.authenticate('bob', 'new-pw')).toBeNull();
  });

  it('admin 同样可改自己密码（全角色一致）', async () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    const admin = store.listUsers().find((u) => u.username === 'admin')!;
    const session: MeSession = { userId: admin.id, username: 'admin', role: 'admin' };
    const r = await call('POST', '/api/me/password', { session, store, body: { currentPassword: 'secret', newPassword: 'new-secret' } });
    expect(r.status).toBe(200);
    expect(store.authenticate('admin', 'new-secret')).toBeTruthy();
  });

  it('连续改密超限 → 第 6 次 429（失败尝试也计入）', async () => {
    const store = makeStore();
    const u = store.createUser('alice', 'pw', 'user');
    const session: MeSession = { userId: u.id, username: 'alice', role: 'user' };
    // 前 5 次：旧密码错→400，但每次都计入限速额度（rateLimited 在读 body 之前）
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/api/me/password', { session, store, body: { currentPassword: 'WRONG', newPassword: `new-${i}` } });
      expect(r.status).toBe(400);
    }
    // 第 6 次：限速命中 → 429
    const r = await call('POST', '/api/me/password', { session, store, body: { currentPassword: 'WRONG', newPassword: 'new-5' } });
    expect(r.status).toBe(429);
    expect((r.json as { error: string }).error).toBe('操作过于频繁，请稍后再试');
  });

  it('请求体超 1MB → 413', async () => {
    const store = makeStore();
    const u = store.createUser('alice', 'pw', 'user');
    const session: MeSession = { userId: u.id, username: 'alice', role: 'user' };
    const r = await call('POST', '/api/me/password', {
      session,
      store,
      body: { currentPassword: 'pw', newPassword: 'x'.repeat(2_000_000) },
    });
    expect(r.status).toBe(413);
    expect((r.json as { error: string }).error).toBe('请求体过大');
  });
});

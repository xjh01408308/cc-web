import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleAdminUsersRoute, type AdminSession } from '../src/admin-routes.js';
import { UserStore, type UserRole } from '../src/user-store.js';
import { AssignmentStore } from '../src/assignment-store.js';

// 每例独立临时 db（与 user-store.test 同构）。
function tmpUserStore(): { store: UserStore; cleanup: () => void } {
  const dbPath = path.join(os.tmpdir(), `cc-web-admin-test-${randomUUID()}.db`);
  const store = new UserStore(dbPath);
  const cleanup = (): void => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  };
  return { store, cleanup };
}

function tmpAssignmentStore(): { store: AssignmentStore; cleanup: () => void } {
  const dbPath = path.join(os.tmpdir(), `cc-web-admin-assign-${randomUUID()}.db`);
  const store = new AssignmentStore(dbPath);
  const cleanup = (): void => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  };
  return { store, cleanup };
}

// 多个 store 并存时用数组收集 cleanup（user + assignment 可能同例各建一个）。
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function makeStore(): UserStore {
  const t = tmpUserStore();
  cleanups.push(t.cleanup);
  return t.store;
}

function makeAssignments(): AssignmentStore {
  const t = tmpAssignmentStore();
  cleanups.push(t.cleanup);
  return t.store;
}

const adminSession: AdminSession = { userId: 'admin-id', username: 'admin', role: 'admin' };
const userSession: AdminSession = { userId: 'user-id', username: 'alice', role: 'user' };

// 极简 req/res mock：只覆盖 admin-routes 触碰的面（method/url/headers/on；writeHead/end）。
function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  const bodyStr = body !== undefined ? JSON.stringify(body) : '';
  const req = {
    method,
    url,
    headers: {},
    on(ev: string, cb: (...a: unknown[]) => void) { (handlers[ev] ||= []).push(cb); return req; },
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

async function call(method: string, url: string, opts: { session: AdminSession | null; body?: unknown; store: UserStore; assignments?: AssignmentStore }): Promise<{ handled: boolean; status: number; json: unknown }> {
  const m = mockRes();
  const assignmentStore = opts.assignments ?? makeAssignments();
  const handled = await handleAdminUsersRoute(mockReq(method, url, opts.body), m.res, { session: opts.session, userStore: opts.store, assignmentStore });
  return { handled, status: m.status(), json: m.json() };
}

describe('admin-routes — 守卫（relay 侧强制授权）', () => {
  it('未登录 → 401，已处理', async () => {
    const store = makeStore();
    const r = await call('GET', '/api/admin/users', { session: null, store });
    expect(r.handled).toBe(true);
    expect(r.status).toBe(401);
  });

  it('普通 user 调用 → 403（issue #22 AC）', async () => {
    const store = makeStore();
    const r = await call('GET', '/api/admin/users', { session: userSession, store });
    expect(r.handled).toBe(true);
    expect(r.status).toBe(403);
  });

  it('admin 调用 → 放行 200', async () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    const r = await call('GET', '/api/admin/users', { session: adminSession, store });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json)).toBe(true);
  });

  it('非 /api/admin/users 前缀 → 不处理（handled=false）', async () => {
    const store = makeStore();
    const r = await call('GET', '/api/projects', { session: adminSession, store });
    expect(r.handled).toBe(false);
  });
});

describe('admin-routes — GET 列表', () => {
  it('返回全部用户（不含 password_hash）', async () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    store.createUser('alice', 'pw', 'user');
    const r = await call('GET', '/api/admin/users', { session: adminSession, store });
    expect(r.status).toBe(200);
    const list = r.json as Array<{ username: string }>;
    expect(list.map((u) => u.username).sort()).toEqual(['admin', 'alice']);
  });
});

describe('admin-routes — POST 创建（固定 user 角色）', () => {
  it('admin 创建普通 user → 200，新用户可登录', async () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    const r = await call('POST', '/api/admin/users', { session: adminSession, store, body: { username: 'alice', password: 'pw1' } });
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
    // 新用户凭据可登录
    expect(store.authenticate('alice', 'pw1')).toBeTruthy();
    // 角色固定为 user（AC：创建普通 user）
    const list = store.listUsers();
    expect(list.find((u) => u.username === 'alice')?.role).toBe('user');
  });

  it('即便 body 带 role:"admin" 也不提权，强制 user', async () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    await call('POST', '/api/admin/users', { session: adminSession, store, body: { username: 'eve', password: 'pw', role: 'admin' } });
    expect(store.listUsers().find((u) => u.username === 'eve')?.role).toBe('user');
  });

  it('普通 user 创建 → 403', async () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    const r = await call('POST', '/api/admin/users', { session: userSession, store, body: { username: 'eve', password: 'pw' } });
    expect(r.status).toBe(403);
    expect(store.countUsers()).toBe(1);
  });

  it('用户名重复 → 409', async () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    store.createUser('alice', 'pw', 'user');
    const r = await call('POST', '/api/admin/users', { session: adminSession, store, body: { username: 'alice', password: 'pw2' } });
    expect(r.status).toBe(409);
  });

  it('用户名 / 密码为空 → 400', async () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    const r1 = await call('POST', '/api/admin/users', { session: adminSession, store, body: { username: '', password: 'pw' } });
    expect(r1.status).toBe(400);
    const r2 = await call('POST', '/api/admin/users', { session: adminSession, store, body: { username: 'bob', password: '' } });
    expect(r2.status).toBe(400);
  });
});

describe('admin-routes — POST 重置密码', () => {
  it('admin 重置 user 密码 → 200，新密码可用、旧密码失效', async () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    const u = store.createUser('alice', 'old-pw', 'user');
    const r = await call('POST', `/api/admin/users/${u.id}/reset-password`, { session: adminSession, store, body: { password: 'new-pw' } });
    expect(r.status).toBe(200);
    expect(store.authenticate('alice', 'old-pw')).toBeNull();
    expect(store.authenticate('alice', 'new-pw')).toBeTruthy();
  });

  it('空密码 → 400', async () => {
    const store = makeStore();
    const u = store.createUser('alice', 'pw', 'user');
    const r = await call('POST', `/api/admin/users/${u.id}/reset-password`, { session: adminSession, store, body: { password: '' } });
    expect(r.status).toBe(400);
  });

  it('目标不存在 → 404', async () => {
    const store = makeStore();
    const r = await call('POST', '/api/admin/users/nope/reset-password', { session: adminSession, store, body: { password: 'pw' } });
    expect(r.status).toBe(404);
  });

  it('目标是 admin → 400（只能管理普通 user）', async () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    const adminRow = store.getUserById(store.listUsers().find((u) => u.username === 'admin')!.id)!;
    expect(adminRow.role).toBe('admin');
    const r = await call('POST', `/api/admin/users/${adminRow.id}/reset-password`, { session: adminSession, store, body: { password: 'x' } });
    expect(r.status).toBe(400);
  });
});

describe('admin-routes — DELETE 删除', () => {
  it('admin 删除 user → 200，用户消失', async () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    const u = store.createUser('alice', 'pw', 'user');
    const r = await call('DELETE', `/api/admin/users/${u.id}`, { session: adminSession, store });
    expect(r.status).toBe(200);
    expect(store.getUserById(u.id)).toBeUndefined();
  });

  it('目标是 admin → 400（不能删管理员）', async () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    const id = store.listUsers().find((u) => u.username === 'admin')!.id;
    const r = await call('DELETE', `/api/admin/users/${id}`, { session: adminSession, store });
    expect(r.status).toBe(400);
    // admin 仍在
    expect(store.getUserById(id)).toBeTruthy();
  });

  it('目标不存在 → 404', async () => {
    const store = makeStore();
    const r = await call('DELETE', '/api/admin/users/nope', { session: adminSession, store });
    expect(r.status).toBe(404);
  });

  it('普通 user 删除 → 403', async () => {
    const store = makeStore();
    const u = store.createUser('alice', 'pw', 'user');
    const r = await call('DELETE', `/api/admin/users/${u.id}`, { session: userSession, store });
    expect(r.status).toBe(403);
    expect(store.getUserById(u.id)).toBeTruthy();
  });
});

describe('admin-routes — Assignment 管理 /api/admin/users/:id/nodes', () => {
  it('GET → 返回该 user 当前授权集 { assigned }', async () => {
    const store = makeStore();
    const assignments = makeAssignments();
    const u = store.createUser('alice', 'pw', 'user');
    assignments.assign(u.id, 'n1');
    assignments.assign(u.id, 'n2');
    const r = await call('GET', `/api/admin/users/${u.id}/nodes`, { session: adminSession, store, assignments });
    expect(r.status).toBe(200);
    expect((r.json as { assigned: string[] }).assigned.sort()).toEqual(['n1', 'n2']);
  });

  it('PUT { nodeIds } → 全量替换，GET 反映新集合', async () => {
    const store = makeStore();
    const assignments = makeAssignments();
    const u = store.createUser('alice', 'pw', 'user');
    assignments.assign(u.id, 'n1');
    const r = await call('PUT', `/api/admin/users/${u.id}/nodes`, { session: adminSession, store, assignments, body: { nodeIds: ['n2', 'n3'] } });
    expect(r.status).toBe(200);
    expect(assignments.assignedNodeIds(u.id).sort()).toEqual(['n2', 'n3']);
  });

  it('PUT 空数组 → 撤销全部授权', async () => {
    const store = makeStore();
    const assignments = makeAssignments();
    const u = store.createUser('alice', 'pw', 'user');
    assignments.assign(u.id, 'n1');
    const r = await call('PUT', `/api/admin/users/${u.id}/nodes`, { session: adminSession, store, assignments, body: { nodeIds: [] } });
    expect(r.status).toBe(200);
    expect(assignments.assignedNodeIds(u.id)).toEqual([]);
  });

  it('PUT nodeIds 非数组 → 400', async () => {
    const store = makeStore();
    const u = store.createUser('alice', 'pw', 'user');
    const r = await call('PUT', `/api/admin/users/${u.id}/nodes`, { session: adminSession, store, body: { nodeIds: 'n1' } });
    expect(r.status).toBe(400);
  });

  it('未登录 GET → 401', async () => {
    const store = makeStore();
    const u = store.createUser('alice', 'pw', 'user');
    const r = await call('GET', `/api/admin/users/${u.id}/nodes`, { session: null, store });
    expect(r.status).toBe(401);
  });

  it('普通 user GET → 403', async () => {
    const store = makeStore();
    const u = store.createUser('alice', 'pw', 'user');
    const r = await call('GET', `/api/admin/users/${u.id}/nodes`, { session: userSession, store });
    expect(r.status).toBe(403);
  });

  it('目标是 admin → 400（admin 无需 Assignment）', async () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    const adminRow = store.listUsers().find((x) => x.username === 'admin')!;
    const r = await call('GET', `/api/admin/users/${adminRow.id}/nodes`, { session: adminSession, store });
    expect(r.status).toBe(400);
  });

  it('目标 user 不存在 → 404', async () => {
    const store = makeStore();
    const r = await call('GET', '/api/admin/users/nope/nodes', { session: adminSession, store });
    expect(r.status).toBe(404);
  });
});

describe('admin-routes — 删除 user 级联清理 Assignment', () => {
  it('删除 user → 其 Assignment 一并清除', async () => {
    const store = makeStore();
    const assignments = makeAssignments();
    const u = store.createUser('alice', 'pw', 'user');
    assignments.assign(u.id, 'n1');
    assignments.assign(u.id, 'n2');
    const r = await call('DELETE', `/api/admin/users/${u.id}`, { session: adminSession, store, assignments });
    expect(r.status).toBe(200);
    expect(assignments.assignedNodeIds(u.id)).toEqual([]);
  });
});

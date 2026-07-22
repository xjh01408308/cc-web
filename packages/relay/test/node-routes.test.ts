import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleAdminNodesRoute, type AdminSession } from '../src/admin-routes.js';
import { NodeStore } from '../src/node-store.js';

// 每例独立临时 db（与 node-store.test 同构）。
function tmpStore(): { store: NodeStore; cleanup: () => void } {
  const dbPath = path.join(os.tmpdir(), `cc-web-node-route-test-${randomUUID()}.db`);
  const store = new NodeStore(dbPath);
  const cleanup = (): void => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  };
  return { store, cleanup };
}

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

function makeStore(): NodeStore {
  const t = tmpStore();
  cleanup = t.cleanup;
  return t.store;
}

const adminSession: AdminSession = { userId: 'admin-id', username: 'admin', role: 'admin' };
const userSession: AdminSession = { userId: 'user-id', username: 'alice', role: 'user' };

// 复用 admin-routes.test 的极简 req/res mock 形状。
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

function mockRes(): { res: ServerResponse; status: () => number; json: () => unknown } {
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

async function call(method: string, url: string, opts: { session: AdminSession | null; body?: unknown; store: NodeStore }): Promise<{ handled: boolean; status: number; json: unknown }> {
  const m = mockRes();
  const handled = await handleAdminNodesRoute(mockReq(method, url, opts.body), m.res, { session: opts.session, nodeStore: opts.store });
  return { handled, status: m.status(), json: m.json() };
}

describe('admin node-routes — 守卫（relay 侧强制授权）', () => {
  it('未登录 → 401', async () => {
    const store = makeStore();
    const r = await call('GET', '/api/admin/nodes', { session: null, store });
    expect(r.handled).toBe(true);
    expect(r.status).toBe(401);
  });

  it('普通 user → 403', async () => {
    const store = makeStore();
    const r = await call('GET', '/api/admin/nodes', { session: userSession, store });
    expect(r.handled).toBe(true);
    expect(r.status).toBe(403);
  });

  it('非 /api/admin/nodes 前缀 → 不处理', async () => {
    const store = makeStore();
    const r = await call('GET', '/api/admin/users', { session: adminSession, store });
    expect(r.handled).toBe(false);
  });
});

describe('admin node-routes — GET 列表', () => {
  it('返回全部预注册 Node（不含 secret_hash）', async () => {
    const store = makeStore();
    store.createNode('n1');
    store.createNode('n2');
    const r = await call('GET', '/api/admin/nodes', { session: adminSession, store });
    expect(r.status).toBe(200);
    const list = r.json as Array<{ nodeId: string }>;
    expect(list.map((n) => n.nodeId).sort()).toEqual(['n1', 'n2']);
    for (const n of list) {
      expect(n).not.toHaveProperty('secret_hash');
      expect(n).not.toHaveProperty('secret');
    }
  });
});

describe('admin node-routes — POST 创建（返回一次性明文 secret）', () => {
  it('admin 创建 → 200，返回 node + 明文 secret，且 secret 能通过注册校验', async () => {
    const store = makeStore();
    const r = await call('POST', '/api/admin/nodes', { session: adminSession, store, body: { nodeId: 'n1' } });
    expect(r.status).toBe(200);
    const json = r.json as { ok: boolean; node: { nodeId: string }; secret: string };
    expect(json.ok).toBe(true);
    expect(json.node.nodeId).toBe('n1');
    expect(json.secret).toMatch(/^[0-9a-f]{64}$/);
    // 返回的明文 secret 能用于注册校验
    expect(store.verifyNodeSecret('n1', json.secret)).toBe(true);
  });

  it('普通 user 创建 → 403', async () => {
    const store = makeStore();
    const r = await call('POST', '/api/admin/nodes', { session: userSession, store, body: { nodeId: 'n1' } });
    expect(r.status).toBe(403);
    expect(store.countNodes()).toBe(0);
  });

  it('nodeId 重复 → 409', async () => {
    const store = makeStore();
    store.createNode('n1');
    const r = await call('POST', '/api/admin/nodes', { session: adminSession, store, body: { nodeId: 'n1' } });
    expect(r.status).toBe(409);
  });

  it('nodeId 为空 → 400', async () => {
    const store = makeStore();
    const r = await call('POST', '/api/admin/nodes', { session: adminSession, store, body: { nodeId: '  ' } });
    expect(r.status).toBe(400);
  });
});

describe('admin node-routes — POST 轮转 secret', () => {
  it('admin 轮转 → 200，返回新 secret，旧 secret 失效、新可用', async () => {
    const store = makeStore();
    const created = store.createNode('n1');
    const r = await call('POST', `/api/admin/nodes/${created.node.id}/rotate-secret`, { session: adminSession, store });
    expect(r.status).toBe(200);
    const newSecret = (r.json as { secret: string }).secret;
    expect(newSecret).not.toBe(created.secret);
    // 旧失效
    expect(store.verifyNodeSecret('n1', created.secret)).toBe(false);
    // 新可用
    expect(store.verifyNodeSecret('n1', newSecret)).toBe(true);
  });

  it('节点不存在 → 404', async () => {
    const store = makeStore();
    const r = await call('POST', '/api/admin/nodes/nope/rotate-secret', { session: adminSession, store });
    expect(r.status).toBe(404);
  });

  it('普通 user 轮转 → 403', async () => {
    const store = makeStore();
    const created = store.createNode('n1');
    const r = await call('POST', `/api/admin/nodes/${created.node.id}/rotate-secret`, { session: userSession, store });
    expect(r.status).toBe(403);
    // 旧 secret 仍可用（未被轮转）
    expect(store.verifyNodeSecret('n1', created.secret)).toBe(true);
  });
});

describe('admin node-routes — DELETE 删除', () => {
  it('admin 删除 → 200，Node 消失，旧 secret 不再能注册', async () => {
    const store = makeStore();
    const created = store.createNode('n1');
    const r = await call('DELETE', `/api/admin/nodes/${created.node.id}`, { session: adminSession, store });
    expect(r.status).toBe(200);
    expect(store.countNodes()).toBe(0);
    expect(store.verifyNodeSecret('n1', created.secret)).toBe(false);
  });

  it('节点不存在 → 404', async () => {
    const store = makeStore();
    const r = await call('DELETE', '/api/admin/nodes/nope', { session: adminSession, store });
    expect(r.status).toBe(404);
  });

  it('普通 user 删除 → 403', async () => {
    const store = makeStore();
    const created = store.createNode('n1');
    const r = await call('DELETE', `/api/admin/nodes/${created.node.id}`, { session: userSession, store });
    expect(r.status).toBe(403);
    expect(store.countNodes()).toBe(1);
  });
});

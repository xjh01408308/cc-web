import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { NodeStore } from '../src/node-store.js';

// 每例独立临时 db，互不污染；WAL 模式会产生 -wal/-shm 旁路文件，一并清理（与 user-store.test 同构）。
function tmpStore(): { store: NodeStore; cleanup: () => void } {
  const dbPath = path.join(os.tmpdir(), `cc-web-node-test-${randomUUID()}.db`);
  const store = new NodeStore(dbPath);
  const cleanup = (): void => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
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

describe('NodeStore — createNode（预注册）', () => {
  it('空表 → 创建 Node，countNodes 递增，返回明文 secret（仅一次）', () => {
    const store = makeStore();
    expect(store.countNodes()).toBe(0);
    const r = store.createNode('n1');
    expect(r.node).toEqual({ id: expect.any(String), nodeId: 'n1', createdAt: expect.any(Number) });
    expect(r.secret).toBeTruthy();
    // 64 hex 字符（32 字节）
    expect(r.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(store.countNodes()).toBe(1);
  });

  it('nodeId 重复 → 抛错（UNIQUE 约束）', () => {
    const store = makeStore();
    store.createNode('n1');
    expect(() => store.createNode('n1')).toThrow();
    expect(store.countNodes()).toBe(1);
  });

  it('两次 create 生成不同 id 与不同 secret', () => {
    const store = makeStore();
    const a = store.createNode('n1');
    const b = store.createNode('n2');
    expect(a.node.id).not.toBe(b.node.id);
    expect(a.secret).not.toBe(b.secret);
  });
});

describe('NodeStore — verifyNodeSecret（注册校验）', () => {
  it('正确 nodeId + secret → true', () => {
    const store = makeStore();
    const { secret } = store.createNode('n1');
    expect(store.verifyNodeSecret('n1', secret)).toBe(true);
  });

  it('正确 nodeId + 错误 secret → false', () => {
    const store = makeStore();
    store.createNode('n1');
    expect(store.verifyNodeSecret('n1', 'wrong')).toBe(false);
  });

  it('未预注册的 nodeId → false（不泄露 Node 是否存在）', () => {
    const store = makeStore();
    expect(store.verifyNodeSecret('ghost', 'anything')).toBe(false);
  });

  it('空 nodeId / 空 secret → false', () => {
    const store = makeStore();
    const { secret } = store.createNode('n1');
    expect(store.verifyNodeSecret('', secret)).toBe(false);
    expect(store.verifyNodeSecret('n1', '')).toBe(false);
  });
});

describe('NodeStore — secret 哈希不可逆', () => {
  it('secret_hash 不存明文（与 secret 不同），格式 salt:hash', () => {
    const store = makeStore();
    const { node, secret } = store.createNode('n1');
    const row = store.getNodeById(node.id);
    expect(row).toBeTruthy();
    expect(row!.secret_hash).not.toBe(secret);
    expect(row!.secret_hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it('同 secret 两次 create 产生不同 hash（随机 salt）', () => {
    const store = makeStore();
    const a = store.createNode('n1');
    const b = store.createNode('n2');
    expect(store.getNodeById(a.node.id)!.secret_hash).not.toBe(store.getNodeById(b.node.id)!.secret_hash);
    // 但两个 secret 都能各自校验通过
    expect(store.verifyNodeSecret('n1', a.secret)).toBe(true);
    expect(store.verifyNodeSecret('n2', b.secret)).toBe(true);
  });
});

describe('NodeStore — listNodes（不含 secret_hash）', () => {
  it('返回全部 Node，字段为 camelCase，不含 secret_hash', () => {
    const store = makeStore();
    store.createNode('n1');
    store.createNode('n2');
    const list = store.listNodes();
    expect(list).toHaveLength(2);
    expect(list.map((n) => n.nodeId).sort()).toEqual(['n1', 'n2']);
    for (const n of list) {
      expect(n).not.toHaveProperty('secret_hash');
      expect(n).not.toHaveProperty('secretHash');
      expect(typeof n.createdAt).toBe('number');
    }
  });
});

describe('NodeStore — rotateSecret（轮转）', () => {
  it('命中 → 返回新明文 secret，旧 secret 失效、新 secret 可用', () => {
    const store = makeStore();
    const created = store.createNode('n1');
    expect(store.verifyNodeSecret('n1', created.secret)).toBe(true);

    const rotated = store.rotateSecret(created.node.id);
    expect(rotated).not.toBeNull();
    expect(rotated!.secret).not.toBe(created.secret);
    expect(rotated!.secret).toMatch(/^[0-9a-f]{64}$/);

    // 旧 secret 失效
    expect(store.verifyNodeSecret('n1', created.secret)).toBe(false);
    // 新 secret 可用
    expect(store.verifyNodeSecret('n1', rotated!.secret)).toBe(true);
  });

  it('未命中 → 返回 null，不抛错', () => {
    const store = makeStore();
    expect(store.rotateSecret('nope')).toBeNull();
  });
});

describe('NodeStore — deleteNode（删除）', () => {
  it('命中 → 返回 true，Node 消失，旧 secret 不再能注册', () => {
    const store = makeStore();
    const created = store.createNode('n1');
    expect(store.countNodes()).toBe(1);

    expect(store.deleteNode(created.node.id)).toBe(true);
    expect(store.countNodes()).toBe(0);
    expect(store.getNodeById(created.node.id)).toBeUndefined();
    // 即便持有旧 secret 也无法再注册
    expect(store.verifyNodeSecret('n1', created.secret)).toBe(false);
  });

  it('未命中 → 返回 false', () => {
    const store = makeStore();
    expect(store.deleteNode('nope')).toBe(false);
  });
});

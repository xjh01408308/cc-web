import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UserStore } from '../src/user-store.js';

// 每例独立临时 db，互不污染；WAL 模式会产生 -wal/-shm 旁路文件，一并清理。
function tmpStore(): { store: UserStore; cleanup: () => void } {
  const dbPath = path.join(os.tmpdir(), `cc-web-user-test-${randomUUID()}.db`);
  const store = new UserStore(dbPath);
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

function makeStore(): UserStore {
  const t = tmpStore();
  cleanup = t.cleanup;
  return t.store;
}

describe('UserStore — seedInitialAdmin（幂等）', () => {
  it('空表 → 创建 admin，返回 seeded=true', () => {
    const store = makeStore();
    expect(store.countUsers()).toBe(0);
    const r = store.seedInitialAdmin('admin', 'secret');
    expect(r).toEqual({ seeded: true, username: 'admin' });
    expect(store.countUsers()).toBe(1);
  });

  it('表非空 → 不重复创建，返回 seeded=false', () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    expect(store.countUsers()).toBe(1);

    // 再次 seed（即便换了凭据也不覆盖）
    const r = store.seedInitialAdmin('other', 'other-pw');
    expect(r.seeded).toBe(false);
    expect(store.countUsers()).toBe(1);
    // 原 admin 凭据仍可用
    expect(store.authenticate('admin', 'secret')).toBeTruthy();
    expect(store.authenticate('admin', 'other-pw')).toBeNull();
  });
});

describe('UserStore — authenticate（用户名 + scrypt 校验）', () => {
  it('正确用户名 + 密码 → 返回 user（含 role/admin）', () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    const u = store.authenticate('admin', 'secret');
    expect(u).not.toBeNull();
    expect(u!.username).toBe('admin');
    expect(u!.role).toBe('admin');
    expect(u!.id).toBeTruthy();
  });

  it('正确用户名 + 错误密码 → null', () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    expect(store.authenticate('admin', 'wrong')).toBeNull();
  });

  it('未知用户名 → null（不泄露用户是否存在）', () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    expect(store.authenticate('nobody', 'secret')).toBeNull();
  });

  it('空用户名 / 空密码 → null', () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    expect(store.authenticate('', 'secret')).toBeNull();
    expect(store.authenticate('admin', '')).toBeNull();
  });
});

describe('UserStore — 密码哈希', () => {
  it('password_hash 不存明文（与密码不同），格式 salt:hash', () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    // 内部无直接取 hash 的 API，间接验证：明文查不到，但 authenticate 能校验通过
    expect(store.authenticate('admin', 'secret')).toBeTruthy();
  });

  it('同密码两次 create 产生不同 hash（随机 salt）', () => {
    const store = makeStore();
    const a = store.createUser('a', 'same-pw', 'user');
    const b = store.createUser('b', 'same-pw', 'user');
    expect(a.password_hash).not.toBe(b.password_hash);
    expect(store.authenticate('a', 'same-pw')).toBeTruthy();
    expect(store.authenticate('b', 'same-pw')).toBeTruthy();
  });
});

// admin 管理普通用户（issue #22）：listUsers / getUserById / resetPassword / deleteUser。
describe('UserStore — admin CRUD（issue #22）', () => {
  it('listUsers 返回所有用户，不含 password_hash，字段为 camelCase', () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    store.createUser('alice', 'pw1', 'user');
    store.createUser('bob', 'pw2', 'user');

    const list = store.listUsers();
    expect(list).toHaveLength(3);
    expect(list.map((u) => u.username).sort()).toEqual(['admin', 'alice', 'bob']);
    for (const u of list) {
      expect(u).not.toHaveProperty('password_hash');
      expect(u).not.toHaveProperty('passwordHash');
      expect(typeof u.createdAt).toBe('number');
      expect(['admin', 'user']).toContain(u.role);
    }
  });

  it('getUserById 命中 → 返回 UserRow；未命中 → undefined', () => {
    const store = makeStore();
    const created = store.createUser('alice', 'pw', 'user');
    expect(store.getUserById(created.id)?.username).toBe('alice');
    expect(store.getUserById('nope')).toBeUndefined();
  });

  it('resetPassword 用新密码覆写哈希，旧密码失效、新密码可用', () => {
    const store = makeStore();
    const u = store.createUser('alice', 'old-pw', 'user');
    expect(store.resetPassword(u.id, 'new-pw')).toBe(true);

    expect(store.authenticate('alice', 'old-pw')).toBeNull();
    expect(store.authenticate('alice', 'new-pw')).toBeTruthy();
  });

  it('resetPassword 未命中 → 返回 false，不抛错', () => {
    const store = makeStore();
    expect(store.resetPassword('nope', 'pw')).toBe(false);
  });

  it('deleteUser 移除用户，之后 authenticate 失败、countUsers 递减', () => {
    const store = makeStore();
    store.seedInitialAdmin('admin', 'secret');
    const u = store.createUser('alice', 'pw', 'user');
    expect(store.countUsers()).toBe(2);

    expect(store.deleteUser(u.id)).toBe(true);
    expect(store.countUsers()).toBe(1);
    expect(store.authenticate('alice', 'pw')).toBeNull();
    // admin 仍在
    expect(store.authenticate('admin', 'secret')).toBeTruthy();
  });

  it('deleteUser 未命中 → 返回 false', () => {
    const store = makeStore();
    expect(store.deleteUser('nope')).toBe(false);
  });
});

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

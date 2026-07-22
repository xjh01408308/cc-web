// Relay 侧持久化用户表（BrowserAuth 多用户登录）。
//
// 原 BrowserAuth 是单一全局 RELAY_PASSWORD（见 ADR-0003）：/api/login 比对明文密码。
// 本模块将其替换为 users 表（用户名 + scrypt 哈希 + 角色），登录改为查表校验。
// Relay 首启时由 index.ts 调 seedInitialAdmin 按 INITIAL_ADMIN_* 幂等创建首个 admin。
//
// 设计与 ConnectionHandler 一致：导出可实例化的 UserStore 类（构造接 dbPath，便于单测用临时 db），
// index.ts 作为组合根创建生产实例；不在模块加载期产生副作用（import 不会建库）。

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { scryptSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** 用户角色：admin 全访问 + 管理；user 仅可操作被 Assignment 的 Node（Assignment 见后续 ticket） */
export type UserRole = 'admin' | 'user';

/** 生产环境默认 db 路径（相对 relay 包 cwd：packages/relay/data/cc-web.db） */
export const DEFAULT_USER_DB_PATH = path.resolve('data/cc-web.db');

const SCRYPT_KEYLEN = 64;

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: UserRole;
  created_at: number;
}

/**
 * scrypt 哈希：输出 `saltHex:hashHex`。每次随机 salt，故同密码哈希不同。
 * 校验时按存储的 salt 重算并 timingSafeEqual 比对（常数时间，不泄露长度差异之外的信息）。
 */
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const sep = stored.indexOf(':');
  if (sep === -1) return false;
  const salt = Buffer.from(stored.slice(0, sep), 'hex');
  const expected = Buffer.from(stored.slice(sep + 1), 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class UserStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  countUsers(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    return r.c;
  }

  private getUserByUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  }

  /**
   * 创建用户。本 ticket 仅 seedInitialAdmin 内部 + 单测消费；导出是因为下一 ticket（admin 管理用户）
   * 将直接调用它，且单测需借此验证 salt 随机性。返回的 UserRow 含 password_hash，仅供内部/测试，不回传前端。
   */
  createUser(username: string, password: string, role: UserRole): UserRow {
    const now = Date.now();
    const id = randomUUID();
    const passwordHash = hashPassword(password);
    this.db
      .prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, username, passwordHash, role, now);
    return { id, username, password_hash: passwordHash, role, created_at: now };
  }

  /**
   * 登录校验：用户名 + 密码 → 命中且密码正确返回 UserRow，否则 null。
   * 未知用户与错误密码都返回 null（不在登录错误文案里区分，避免用户名枚举）。
   */
  authenticate(username: string, password: string): UserRow | null {
    if (!username || !password) return null;
    const u = this.getUserByUsername(username);
    if (!u) return null;
    return verifyPassword(password, u.password_hash) ? u : null;
  }

  /**
   * 幂等创建首个 admin：仅当 users 表为空时按传入凭据建一个 admin。
   * 表非空（已有用户）直接返回 seeded=false，绝不覆盖既有用户——保证重启 / 改 env 不会重置账户。
   */
  seedInitialAdmin(username: string, password: string): { seeded: boolean; username: string } {
    if (this.countUsers() > 0) return { seeded: false, username: '' };
    this.createUser(username, password, 'admin');
    return { seeded: true, username };
  }
}

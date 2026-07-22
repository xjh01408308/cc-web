// Relay 侧持久化 Node 预注册表（local→relay 注册凭证，见 ADR-0004）。
//
// 原 local 注册认证是单一全局 RELAY_TOKEN（两端共享同一字符串）；本模块将其替换为每 Node 独立凭证：
// 管理员预注册 Node 时生成 (nodeId, nodeSecret) 一对，nodeSecret 以 scrypt 哈希存储。
// local register 带 (nodeId, nodeSecret)，relay 查本表校验——未预注册或 secret 错的 Node 连不上。
//
// 设计与 UserStore 一致：导出可实例化的 NodeStore 类（构造接 dbPath，便于单测用临时 db），
// index.ts 作为组合根创建生产实例；不在模块加载期产生副作用（import 不会建库）。
// scrypt 哈希与 UserStore 各自私有（与 user-store.ts 风格一致），不抽公共 crypto 模块以免改动既有已测代码。

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { scryptSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** 生产环境默认 db 路径（相对 relay 包 cwd：packages/relay/data/cc-web.db；与 users 表同库不同表） */
export const DEFAULT_NODE_DB_PATH = path.resolve('data/cc-web.db');

const SCRYPT_KEYLEN = 64;
/** nodeSecret 随机字节长度（32 字节 → 64 hex 字符） */
const SECRET_BYTES = 32;

export interface NodeRow {
  id: string;
  node_id: string;
  secret_hash: string;
  created_at: number;
}

/**
 * 预注册 Node 的公开视图（listNodes 返回）：剥去 secret_hash，created_at 转 camelCase。
 * 管理列表回传前端用此形状——绝不把 secret_hash 送出 relay（secret 仅在创建/轮转时明文展示一次）。
 */
export interface PublicNode {
  id: string;
  nodeId: string;
  createdAt: number;
}

/** 创建/轮转结果：node 为持久化视图，secret 为明文凭证（仅此一次回传给管理员）。 */
export interface CreatedNode {
  node: PublicNode;
  secret: string;
}

/**
 * scrypt 哈希：输出 `saltHex:hashHex`。每次随机 salt，故同 secret 哈希不同。
 * 校验时按存储的 salt 重算并 timingSafeEqual 比对（常数时间，不泄露长度差异之外的信息）。
 */
function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifySecret(secret: string, stored: string): boolean {
  const sep = stored.indexOf(':');
  if (sep === -1) return false;
  const salt = Buffer.from(stored.slice(0, sep), 'hex');
  const expected = Buffer.from(stored.slice(sep + 1), 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(secret, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class NodeStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id          TEXT PRIMARY KEY,
        node_id     TEXT NOT NULL UNIQUE,
        secret_hash TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  countNodes(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number };
    return r.c;
  }

  /** 按 id 查单个预注册 Node（含 secret_hash，仅供内部/管理操作前校验存在性，不回传前端）。 */
  getNodeById(id: string): NodeRow | undefined {
    return this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
  }

  /** 按 nodeId 查（注册校验用：local register 带的 nodeId 据此查表）。仅内部消费，不外泄。 */
  private getNodeByNodeId(nodeId: string): NodeRow | undefined {
    return this.db.prepare('SELECT * FROM nodes WHERE node_id = ?').get(nodeId) as NodeRow | undefined;
  }

  /**
   * 列出全部预注册 Node（不含 secret_hash）。admin 管理视图消费；secret 哈希绝不外泄。
   */
  listNodes(): PublicNode[] {
    const rows = this.db.prepare('SELECT id, node_id, created_at FROM nodes ORDER BY created_at ASC').all() as Array<Pick<NodeRow, 'id' | 'node_id' | 'created_at'>>;
    return rows.map((r) => ({ id: r.id, nodeId: r.node_id, createdAt: r.created_at }));
  }

  /**
   * 预注册 Node：生成随机 nodeSecret（明文仅返回这一次），哈希入库。
   * nodeId 重复（UNIQUE 约束）抛错，调用方据 HTTP 409 回传。
   */
  createNode(nodeId: string): CreatedNode {
    const now = Date.now();
    const id = randomUUID();
    const secret = randomBytes(SECRET_BYTES).toString('hex');
    this.db
      .prepare('INSERT INTO nodes (id, node_id, secret_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(id, nodeId, hashSecret(secret), now);
    return { node: { id, nodeId, createdAt: now }, secret };
  }

  /**
   * 注册校验：nodeId + nodeSecret → 命中且 secret 正确返回 true，否则 false。
   * 未预注册的 nodeId 与 secret 错误都返回 false（不在注册错误文案里区分，避免 nodeId 枚举）。
   */
  verifyNodeSecret(nodeId: string, secret: string): boolean {
    if (!nodeId || !secret) return false;
    const n = this.getNodeByNodeId(nodeId);
    if (!n) return false;
    return verifySecret(secret, n.secret_hash);
  }

  /**
   * 轮转 nodeSecret：生成新随机 secret 并覆写哈希，返回新明文（仅此一次）。
   * 命中返回 { secret }，未命中（id 不存在）返回 null。旧 secret 立即失效。
   */
  rotateSecret(id: string): { secret: string } | null {
    const existing = this.getNodeById(id);
    if (!existing) return null;
    const secret = randomBytes(SECRET_BYTES).toString('hex');
    this.db.prepare('UPDATE nodes SET secret_hash = ? WHERE id = ?').run(hashSecret(secret), id);
    return { secret };
  }

  /**
   * 删除预注册 Node。命中返回 true，未命中返回 false。
   * 删除后该 nodeId 的 local 即便持有旧 secret 也无法再注册（凭证已从表中移除）。
   */
  deleteNode(id: string): boolean {
    const result = this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
    return result.changes > 0;
  }
}

// Relay 侧持久化 Assignment 授权关系（relay 侧 user↔Node 多对多，见 ADR-0005）。
//
// Assignment 是唯一的操作授权机制：被 Assignment 的 user 即可完全操作该 Node。
// 替代已废弃的 NodeAuth（NODE_PASSWORD / isAuthenticated 第二因素解锁），见 ADR-0005。
// admin 角色绕过 Assignment（全访问），本表仅记录普通 user 的授权。
//
// 设计与 UserStore / NodeStore 一致：可实例化的 AssignmentStore 类（构造接 dbPath，
// 便于单测用临时 db），index.ts 作组合根创建生产实例；不在模块加载期产生副作用。
// node_id 存逻辑 nodeId（与在线节点 NodeRegistry 的 key、local register 的 nodeId 一致），
// 不加 FK 约束（与现有 stores 风格一致），删 user / node 时由调用方显式级联清理。

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/** 生产环境默认 db 路径（与 users / nodes 同库不同表） */
export const DEFAULT_ASSIGNMENT_DB_PATH = path.resolve('data/cc-web.db');

interface AssignmentRow {
  user_id: string;
  node_id: string;
  created_at: number;
}

export class AssignmentStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assignments (
        user_id    TEXT NOT NULL,
        node_id    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, node_id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** 建立 user↔node 授权。INSERT OR IGNORE 幂等（重复 assign 不报错、不重复行）。 */
  assign(userId: string, nodeId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO assignments (user_id, node_id, created_at) VALUES (?, ?, ?)')
      .run(userId, nodeId, Date.now());
  }

  /** 撤销单条授权。命中返回 true，未命中返回 false。 */
  revoke(userId: string, nodeId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM assignments WHERE user_id = ? AND node_id = ?')
      .run(userId, nodeId);
    return result.changes > 0;
  }

  /**
   * 全量替换某 user 的授权集合（PUT 语义）：删该 user 全部 assignment，再插给定 nodeIds。
   * 单事务保证原子。入参去重（防 UNIQUE 冲突 + 不产生重复行）。
   */
  setAssigned(userId: string, nodeIds: string[]): void {
    const now = Date.now();
    const insert = this.db.prepare('INSERT OR IGNORE INTO assignments (user_id, node_id, created_at) VALUES (?, ?, ?)');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM assignments WHERE user_id = ?').run(userId);
      const seen = new Set<string>();
      for (const nodeId of nodeIds) {
        if (!nodeId || seen.has(nodeId)) continue;
        seen.add(nodeId);
        insert.run(userId, nodeId, now);
      }
    })();
  }

  /** 某 user 被授权的 nodeId 列表（授权判定 / 节点列表过滤用）。无授权返回空数组。 */
  assignedNodeIds(userId: string): string[] {
    const rows = this.db
      .prepare('SELECT node_id FROM assignments WHERE user_id = ? ORDER BY created_at ASC')
      .all(userId) as Array<Pick<AssignmentRow, 'node_id'>>;
    return rows.map((r) => r.node_id);
  }

  /** 删某 user 的全部 assignment（删 user 时级联调用）。返回被删行数。 */
  revokeAllForUser(userId: string): number {
    return this.db.prepare('DELETE FROM assignments WHERE user_id = ?').run(userId).changes;
  }

  /** 删某 node 的全部 assignment（删预注册 node 时级联调用）。返回被删行数。 */
  revokeAllForNode(nodeId: string): number {
    return this.db.prepare('DELETE FROM assignments WHERE node_id = ?').run(nodeId).changes;
  }
}

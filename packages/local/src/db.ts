import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = path.resolve('data');
const DB_PATH = path.join(DATA_DIR, 'cc-web.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables();
  }
  return db;
}

function initTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      path       TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      summary           TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'idle',
      message_count     INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL,
      claude_session_id TEXT,
      model             TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, created_at DESC);
  `);
  // 迁移：CREATE TABLE IF NOT EXISTS 不重建已存在的旧表，需手动补 model 列
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'model')) {
    db.exec('ALTER TABLE sessions ADD COLUMN model TEXT');
  }
}

// ─── Project CRUD ────────────────────────────────────────

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  created_at: number;
}

export function createProject(id: string, name: string, projectPath: string): ProjectRow {
  const d = getDb();
  const now = Date.now();
  d.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(id, name, projectPath, now);
  return { id, name, path: projectPath, created_at: now };
}

export function getProject(id: string): ProjectRow | undefined {
  return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
}

export function listProjects(): ProjectRow[] {
  return getDb().prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[];
}

export function deleteProject(id: string): boolean {
  const result = getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
  return result.changes > 0;
}

// ─── Session CRUD ───────────────────────────────────────

export interface SessionRow {
  id: string;
  project_id: string;
  summary: string;
  status: string;
  message_count: number;
  created_at: number;
  claude_session_id: string | null;
  model: string | null;
}

export function createSession(id: string, projectId: string, model?: string): SessionRow {
  const d = getDb();
  const now = Date.now();
  d.prepare(
    'INSERT INTO sessions (id, project_id, summary, status, message_count, created_at, model) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, projectId, '', 'idle', 0, now, model ?? null);
  return { id, project_id: projectId, summary: '', status: 'idle', message_count: 0, created_at: now, claude_session_id: null, model: model ?? null };
}

export function getSession(id: string): SessionRow | undefined {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
}

export function listSessionsByProject(projectId?: string): SessionRow[] {
  const d = getDb();
  if (projectId) {
    return d.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as SessionRow[];
  }
  return d.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all() as SessionRow[];
}

export function deleteSession(id: string): boolean {
  const result = getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return result.changes > 0;
}

export function updateSessionSummary(id: string, summary: string): void {
  getDb().prepare('UPDATE sessions SET summary = ? WHERE id = ?').run(summary, id);
}

export function updateSessionStatus(id: string, status: string): void {
  getDb().prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, id);
}

export function updateSessionClaudeId(id: string, claudeSessionId: string): void {
  getDb().prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?').run(claudeSessionId, id);
}

export function incrementMessageCount(id: string): void {
  getDb().prepare('UPDATE sessions SET message_count = message_count + 1 WHERE id = ?').run(id);
}

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SessionRunner } from './sdk-runner.js';
import type { StreamResponse, SessionInfo, ProjectInfo } from './types.js';
import { send, isConnected } from './ws-client.js';
import * as db from './db.js';
import { validateProjectPath } from './file-utils.js';
import { WORKSPACE_ROOT } from './config.js';

interface Session {
  sessionId: string;
  projectId: string;
  projectPath: string;
  model?: string;
  permissionMode?: string;
  summary: string;
  status: 'idle' | 'running' | 'error';
  messages: StreamResponse[];
  runner: SessionRunner | null;
  createdAt: number;
  claudeSessionId?: string;
  seenUuids?: Set<string>;
  lastUserText?: string;
}

const sessions = new Map<string, Session>();

// 消息持久化目录
const DATA_DIR = path.resolve('data/sessions');

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function saveMessages(session: Session): void {
  ensureDataDir();
  const filePath = path.join(DATA_DIR, `${session.sessionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    sessionId: session.sessionId,
    projectId: session.projectId,
    messages: session.messages,
    createdAt: session.createdAt,
    updatedAt: Date.now(),
    claudeSessionId: session.claudeSessionId,
  }, null, 2));
}

function loadMessages(sessionId: string): StreamResponse[] {
  const filePath = path.join(DATA_DIR, `${sessionId}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return data.messages || [];
    } catch {
      return [];
    }
  }
  return [];
}

// ─── Project API ──────────────────────────────────────────

export function createProject(name: string, projectPath: string): ProjectInfo {
  const pathError = validateProjectPath(projectPath, WORKSPACE_ROOT);
  if (pathError) throw new Error(pathError);
  const id = randomUUID();
  const row = db.createProject(id, name, projectPath);
  return {
    projectId: row.id,
    name: row.name,
    path: row.path,
    sessionCount: 0,
    createdAt: row.created_at,
  };
}

export function listProjects(): ProjectInfo[] {
  const rows = db.listProjects();
  // 为每个项目统计会话数
  const sessionCounts = new Map<string, number>();
  const allSessions = db.listSessionsByProject();
  for (const s of allSessions) {
    sessionCounts.set(s.project_id, (sessionCounts.get(s.project_id) || 0) + 1);
  }
  return rows.map((r) => ({
    projectId: r.id,
    name: r.name,
    path: r.path,
    sessionCount: sessionCounts.get(r.id) || 0,
    createdAt: r.created_at,
  }));
}

export function deleteProject(projectId: string): boolean {
  // 先删除该项目下所有会话的内存状态和消息文件
  const projectSessions = db.listSessionsByProject(projectId);
  for (const s of projectSessions) {
    const memSession = sessions.get(s.id);
    if (memSession?.runner) {
      memSession.runner.close();
    }
    sessions.delete(s.id);
    const filePath = path.join(DATA_DIR, `${s.id}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  return db.deleteProject(projectId);
}

// ─── Session API ──────────────────────────────────────────

export function createSession(projectId: string, projectPath: string, model?: string, permissionMode?: string): SessionInfo {
  const pathError = validateProjectPath(projectPath, WORKSPACE_ROOT);
  if (pathError) throw new Error(pathError);
  const sessionId = randomUUID();
  const row = db.createSession(sessionId, projectId);
  const session: Session = {
    sessionId,
    projectId,
    projectPath,
    model,
    permissionMode,
    summary: '',
    status: 'idle',
    messages: [],
    runner: null,
    createdAt: row.created_at,
  };
  sessions.set(sessionId, session);
  return {
    sessionId,
    projectId,
    projectPath,
    model,
    permissionMode,
    summary: '',
    status: 'idle',
    messageCount: 0,
    createdAt: session.createdAt,
  };
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function getSessionInfo(sessionId: string): SessionInfo | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  return {
    sessionId: session.sessionId,
    projectId: session.projectId,
    projectPath: session.projectPath,
    model: session.model,
    permissionMode: session.permissionMode,
    summary: session.summary,
    status: session.status,
    messageCount: session.messages.length,
    createdAt: session.createdAt,
  };
}

export function listSessions(projectId?: string): SessionInfo[] {
  const rows = db.listSessionsByProject(projectId);
  return rows.map((r) => {
    // 如果有内存中的 session，用内存数据（更实时）
    const mem = sessions.get(r.id);
    const projectPath = mem?.projectPath || getProjectPath(r.project_id);
    return {
      sessionId: r.id,
      projectId: r.project_id,
      projectPath,
      model: mem?.model,
      permissionMode: mem?.permissionMode,
      summary: r.summary,
      status: (r.status as 'idle' | 'running' | 'error'),
      messageCount: r.message_count,
      createdAt: r.created_at,
      messages: mem?.messages || loadMessages(r.id),
    };
  });
}

function getProjectPath(projectId: string): string {
  const p = db.getProject(projectId);
  return p?.path || '';
}

export function getHistory(sessionId: string): StreamResponse[] | undefined {
  const session = sessions.get(sessionId);
  if (session) return session.messages;
  return loadMessages(sessionId);
}

function isSdkResult(resp: StreamResponse): boolean {
  if (resp.type !== 'claude_json') return false;
  const data = resp.data as { type?: string } | undefined;
  return data?.type === 'result';
}

function isSdkInit(resp: StreamResponse): string | undefined {
  if (resp.type !== 'claude_json') return undefined;
  const data = resp.data as { type?: string; subtype?: string; session_id?: string } | undefined;
  if (data?.type === 'system' && data?.subtype === 'init') {
    return data.session_id;
  }
  return undefined;
}

// 自动生成会话摘要（首次用户消息前 50 字）
export function generateSummary(sessionId: string, text: string): void {
  const session = sessions.get(sessionId);
  if (!session || session.summary) return; // 已有摘要则跳过

  const summary = text.replace(/\s+/g, ' ').trim().substring(0, 50);
  session.summary = summary;
  db.updateSessionSummary(sessionId, summary);
}

/** 创建 SessionRunner 并附加 UUID 去重逻辑（用于 --resume 重放时跳过旧消息） */
function createRunner(session: Session): SessionRunner {
  if (!session.seenUuids) session.seenUuids = new Set();

  const controller = new AbortController();
  return new SessionRunner({
    claudeSessionId: session.claudeSessionId,
    projectPath: session.projectPath,
    model: session.model,
    permissionMode: session.permissionMode || "acceptEdits",
    signal: controller.signal,
    onMessage: (resp) => {
      // UUID 去重：--resume 重放的消息不重复转发到前端
      const data = (resp as unknown as Record<string, unknown>).data as Record<string, unknown> | undefined;
      const uuid = data?.uuid as string | undefined;
      if (uuid && session.seenUuids) {
        if (session.seenUuids.has(uuid)) return; // 旧消息，跳过
        session.seenUuids.add(uuid);
      }

      // 存入历史
      session.messages.push(resp);

      // 捕获 Claude session_id（首次 init 消息返回）
      if (!session.claudeSessionId) {
        const sid = isSdkInit(resp);
        if (sid) {
          session.claudeSessionId = sid;
          db.updateSessionClaudeId(session.sessionId, sid);
        }
      }

      // 发送到中转（附加 sessionId）
      if (isConnected()) {
        send({ ...resp, sessionId: session.sessionId });
      }

      // 当收到 result 时，本轮对话结束
      if (isSdkResult(resp)) {
        session.status = "idle";
        db.updateSessionStatus(session.sessionId, "idle");
        db.incrementMessageCount(session.sessionId);
        if (isConnected()) {
          send({ type: "done", sessionId: session.sessionId });
        }
        saveMessages(session);
      }
    },
  });
}

export function sendMessage(
  sessionId: string,
  text: string,
): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  session.status = "running";
  db.updateSessionStatus(sessionId, "running");

  // 如果还没有 runner，创建并启动
  if (!session.runner) {
    session.runner = createRunner(session);
    session.runner.start();
  }

  // 记住最后一条用户消息（权限重试时用于重发）
  session.lastUserText = text;

  // 存储用户消息到历史
  session.messages.push({
    type: 'claude_json',
    data: { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } },
  } as StreamResponse);

  // 发送用户消息到持久进程的 stdin
  const ok = session.runner.send(text);
  if (!ok) {
    session.status = 'error';
    db.updateSessionStatus(sessionId, 'error');
    if (isConnected()) {
      send({ type: 'error', sessionId, error: 'Claude CLI 进程异常' });
    }
    return false;
  }

  return true;
}

/** 更新会话的权限模式，如果当前有 runner 则关闭它（下次消息用新模式重启） */
export function updatePermissionMode(sessionId: string, mode: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  const oldMode = session.permissionMode;
  session.permissionMode = mode;
  // 权限模式变了，关闭当前 runner 让新模式下条消息时重启
  if (oldMode !== mode && session.runner) {
    session.runner.close();
    session.runner = null;
    session.status = "idle";
  }
}

/** 即时切换会话权限模式：关闭当前 runner，用 --resume 重建上下文。
 *  如果会话正在运行，则重发最后一条用户消息（相当于以新模式重试当前请求）。 */
export function switchPermissionMode(sessionId: string, mode: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  const oldMode = session.permissionMode;
  session.permissionMode = mode;

  if (session.runner) {
    session.runner.close();
    session.runner = null;
  }

  const wasRunning = session.status === 'running';
  session.status = 'idle';

  // 如果有 claudeSessionId，用 --resume 立即重建上下文
  if (session.claudeSessionId) {
    const runner = createRunner(session);
    runner.start();
    session.runner = runner;

    if (wasRunning && session.lastUserText) {
      session.status = 'running';
      db.updateSessionStatus(sessionId, 'running');
      runner.send(session.lastUserText);
    }
  }

  if (session.status === 'idle') {
    db.updateSessionStatus(sessionId, 'idle');
  }

  // 通知前端模式已切换
  if (isConnected()) {
    send({
      type: 'session_info',
      sessionId,
      projectId: session.projectId,
      projectPath: session.projectPath,
      model: session.model,
      permissionMode: mode,
      summary: session.summary,
      status: session.status,
      messageCount: session.messages.length,
      createdAt: session.createdAt,
    });
  }

  console.log(`[session] 权限模式切换: ${sessionId.substring(0, 8)} ${oldMode || '(none)'} → ${mode}${wasRunning ? ' (重试当前消息)' : ''}`);
  return true;
}

/** 权限批准后重试：移除被拒回复，用新权限模式重启 CLI 并重放对话 */
export function retryWithPermission(sessionId: string, permissionMode: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  // 1. 移除最后一条被拒绝的回复（从末尾直到遇到 user 消息为止）
  const msgs = session.messages;
  let lastUuid: string | undefined;
  while (msgs.length > 0) {
    const last = msgs[msgs.length - 1];
    const data = (last as unknown as Record<string, unknown>).data as Record<string, unknown> | undefined;
    if (data?.type === "user") break;
    lastUuid = (data as unknown as Record<string, unknown>)?.uuid as string | undefined;
    msgs.pop();
  }

  // 2. 更新权限模式
  session.permissionMode = permissionMode;

  // 3. 关闭当前 runner
  if (session.runner) {
    session.runner.close();
    session.runner = null;
  }
  session.status = "idle";

  // 4. 清空 seenUuids（新进程会重新发送）
  session.seenUuids = new Set();

  // 5. 立即创建新 runner，用 --resume 重放对话，然后重发用户消息
  const runner = createRunner(session);
  runner.start();
  session.runner = runner;
  session.status = "running";
  db.updateSessionStatus(sessionId, "running");

  // --resume 重放完毕后 CLI 等待 stdin，在 start 之后立即发送即可
  const retryText = session.lastUserText;
  if (retryText) {
    runner.send(retryText);
  }

  return true;
}

export function stopSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  if (session.runner) {
    session.runner.close();
    session.runner = null;
  }

  session.status = 'idle';
  db.updateSessionStatus(sessionId, 'idle');
  saveMessages(session);

  if (isConnected()) {
    send({ type: 'session_end', sessionId, reason: 'stopped' });
  }

  return true;
}

export function deleteSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  if (session.runner) {
    session.runner.close();
    session.runner = null;
  }

  sessions.delete(sessionId);
  db.deleteSession(sessionId);

  const filePath = path.join(DATA_DIR, `${sessionId}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  return true;
}

export function loadPersistedSessions(): void {
  ensureDataDir();

  try {
    const rows = db.listSessionsByProject();
    for (const row of rows) {
      const messages = loadMessages(row.id);
      const project = db.getProject(row.project_id);
      const session: Session = {
        sessionId: row.id,
        projectId: row.project_id,
        projectPath: project?.path || '',
        summary: row.summary,
        status: 'idle',
        messages,
        runner: null,
        createdAt: row.created_at,
        claudeSessionId: row.claude_session_id || undefined,
      };
      sessions.set(row.id, session);
    }
    console.log(`已加载 ${sessions.size} 个持久化会话`);
  } catch (err) {
    console.error('加载持久化会话失败:', err);
  }
}

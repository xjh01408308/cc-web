// 全局时间戳——所有 console 输出前自动加上时间，方便定位问题发生时刻
const _log = console.log.bind(console);
const _error = console.error.bind(console);
const _warn = console.warn.bind(console);
function ts(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
console.log = (...args: unknown[]) => _log(`[${ts()}]`, ...args);
console.error = (...args: unknown[]) => _error(`[${ts()}]`, ...args);
console.warn = (...args: unknown[]) => _warn(`[${ts()}]`, ...args);

import { start, onMessage, send } from './ws-client.js';
import { NODE_ID, NODE_SECRET, FORCE_PERMISSION_MODE, isDevMode, WORKSPACE_ROOT } from './config.js';
import {
  createSession,
  sendMessage,
  stopSession,
  retryWithPermission,
  updatePermissionMode,
  switchPermissionMode,
  listSessions,
  getSession,
  getHistory,
  generateSummary,
  loadPersistedSessions,
  createProject,
  listProjects,
  deleteProject,
  deleteSession,
  setTransport,
} from './session-manager.js';
import { getGitStatus, getGitDiff } from './git-utils.js';
import { getFileTree, getFileContent } from './file-utils.js';
import type { LocalResponseEvent } from './types.js';
import { LocalCommandType, LocalControlType, LocalEventType } from './types.js';

// 启动前置校验：NODE_ID / NODE_SECRET 必填（管理员在 /admin 预注册 Node 后获得，见 ADR-0004）。
// 缺一不可——未预注册或凭证错的 local 会被 relay 拒绝并停止重连，故在此 fail fast 给明确提示。
if (!NODE_ID || !NODE_SECRET) {
  console.error('启动失败：NODE_ID 和 NODE_SECRET 必须设置。');
  console.error('由管理员在 /admin 预注册 Node 获得（NODE_ID = 节点 ID，NODE_SECRET = 展示一次的注册凭证）。');
  process.exit(1);
}

// composition root：注入传输端点到领域层（依赖反转的 wiring）。
// 必须在任何可能触发领域层传输出口的代码之前完成，避免丢失启动早期的领域事件。
setTransport(send);

// 加载持久化会话
loadPersistedSessions();

// 处理来自中转的消息
onMessage((msg) => {
  // 回传 _reqId（用于 HTTP API 请求-响应匹配）；reply 只接受带 _reqId 槽位的响应类事件
  const reqId = (msg as { _reqId?: string })._reqId;
  const reply = (data: LocalResponseEvent): void => {
    send(reqId ? { ...data, _reqId: reqId } : data);
  };

  switch (msg.type) {
    case LocalControlType.Registered:
      console.log('已在服务中注册');
      // 重连后同步当前状态到前端
      {
        const sessions = listSessions();
        const sessionsWithHistory = sessions.map((s) => ({
          ...s,
          messages: getHistory(s.sessionId) || [],
        }));
        send({ type: LocalEventType.SessionsList, sessions: sessionsWithHistory });
        const projects = listProjects();
        send({ type: LocalEventType.ProjectsList, projects });
      }
      break;

    case LocalCommandType.Chat: {
      let sessionId = msg.sessionId as string | undefined;
      const text = msg.text;
      const permMode = FORCE_PERMISSION_MODE || msg.permissionMode || undefined;
      if (!text) return;

      // 必须有有效的项目和会话，不允许自动创建
      if (!sessionId || !getSession(sessionId)) {
        if (sessionId) {
          send({ type: LocalEventType.Error, sessionId, error: '会话已过期，请刷新页面后重新创建会话' });
        }
        return;
      }

      // 同步前端设置的权限模式
      if (permMode) {
        updatePermissionMode(sessionId, permMode);
      }
      console.log(`收到消息 [${sessionId.substring(0, 8)}]: ${text.substring(0, 50)}...`);
      generateSummary(sessionId, text);
      const ok = sendMessage(sessionId, text);
      if (!ok) {
        send({ type: LocalEventType.Error, sessionId, error: `会话 ${sessionId.substring(0, 8)} 不存在` });
      }
      break;
    }

    case LocalCommandType.CreateProject: {
      const name = msg.name || '';
      const projectPath = msg.path;
      if (!name) {
        reply({ type: LocalEventType.Error, error: '项目名称不能为空' });
        return;
      }
      if (!projectPath) {
        reply({ type: LocalEventType.Error, error: '项目路径不能为空' });
        return;
      }
      try {
        const project = createProject(name, projectPath);
        console.log(`项目已创建: ${project.name} (${project.projectId.substring(0, 8)})`);
        reply({ type: LocalEventType.ProjectInfo, project });
        const projects = listProjects();
        send({ type: LocalEventType.ProjectsList, projects });
      } catch (err) {
        reply({ type: LocalEventType.Error, error: (err as Error).message });
      }
      break;
    }

    case LocalCommandType.ListProjects: {
      const projects = listProjects();
      reply({ type: LocalEventType.ProjectsList, projects });
      break;
    }

    case LocalCommandType.DeleteProject: {
      const projectId = msg.projectId;
      if (!projectId) return;
      const ok = deleteProject(projectId);
      if (ok) {
        console.log(`项目已删除: ${projectId.substring(0, 8)}`);
        const projects = listProjects();
        send({ type: LocalEventType.ProjectsList, projects });
      }
      break;
    }

    case LocalCommandType.CreateSession: {
      const projectId = msg.projectId || '';
      const projectPath = msg.projectPath;
      const model = msg.model || undefined;
      const permissionMode = FORCE_PERMISSION_MODE || msg.permissionMode || undefined;
      if (!projectId) {
        reply({ type: LocalEventType.Error, error: '创建会话需要指定 projectId' });
        return;
      }
      if (!projectPath) {
        reply({ type: LocalEventType.Error, error: '创建会话需要指定 projectPath' });
        return;
      }
      try {
        const info = createSession(projectId, projectPath, model, permissionMode);
        console.log(`会话已创建: ${info.sessionId.substring(0, 8)} (${projectPath})${model ? `, 模型=${model}` : ""}${permissionMode ? `, 权限=${permissionMode}` : ""}`);
        send({ type: LocalEventType.SessionInfo, ...info });
        const projects = listProjects();
        send({ type: LocalEventType.ProjectsList, projects });
      } catch (err) {
        reply({ type: LocalEventType.Error, error: (err as Error).message });
      }
      break;
    }

    case LocalCommandType.ChangePermissionMode: {
      const sid = msg.sessionId;
      const permMode = FORCE_PERMISSION_MODE || msg.permissionMode;
      if (sid && permMode) {
        if (permMode === 'bypassPermissions' && !FORCE_PERMISSION_MODE && !isDevMode()) {
          console.error(`[SECURITY] 拒绝远程 bypassPermissions | sessionId=${sid.substring(0, 8)}`);
          reply({ type: LocalEventType.Error, error: '生产环境不允许远程设置全权限模式' });
          break;
        }
        switchPermissionMode(sid, permMode);
      }
      break;
    }

    case LocalCommandType.RetryWithPermission: {
      const sid = msg.sessionId;
      const permMode = FORCE_PERMISSION_MODE || msg.permissionMode || "bypassPermissions";
      if (sid) {
        if (permMode === 'bypassPermissions' && !FORCE_PERMISSION_MODE && !isDevMode()) {
          console.error(`[SECURITY] 拒绝远程 retry bypassPermissions | sessionId=${sid.substring(0, 8)}`);
          reply({ type: LocalEventType.Error, error: '生产环境不允许远程全权限重试' });
          break;
        }
        retryWithPermission(sid, permMode);
      }
      break;
    }

    case LocalCommandType.StopSession: {
      const sid = msg.sessionId;
      if (sid) stopSession(sid);
      break;
    }

    case LocalCommandType.DeleteSession: {
      const sid = msg.sessionId;
      if (!sid) return;
      const ok = deleteSession(sid);
      if (ok) {
        console.log(`会话已删除: ${sid.substring(0, 8)}`);
        const sessions = listSessions();
        send({ type: LocalEventType.SessionsList, sessions: sessions.map((s) => ({ ...s, messages: getHistory(s.sessionId) || [] })) });
        const projects = listProjects();
        send({ type: LocalEventType.ProjectsList, projects });
      }
      break;
    }

    case LocalCommandType.ListSessions: {
      const projectId = msg.projectId;
      const sessions = listSessions(projectId);
      const sessionsWithHistory = sessions.map((s) => ({
        ...s,
        messages: getHistory(s.sessionId) || [],
      }));
      reply({ type: LocalEventType.SessionsList, sessions: sessionsWithHistory });
      break;
    }

    case LocalCommandType.GetGitStatus: {
      const projectPath = msg.projectPath;
      const projectId = msg.projectId;
      if (!projectPath || !projectId) return;
      const status = getGitStatus(projectPath, projectId);
      reply({ type: LocalEventType.GitStatus, gitStatus: status });
      break;
    }

    case LocalCommandType.GetGitDiff: {
      const projectPath = msg.projectPath;
      const filePath = msg.filePath;
      const staged = msg.staged === true;
      if (!projectPath || !filePath) return;
      const result = getGitDiff(projectPath, filePath, staged);
      reply({ type: LocalEventType.GitDiff, diffResult: result, staged });
      break;
    }

    case LocalCommandType.GetFileTree: {
      const projectPath = msg.projectPath;
      const projectId = msg.projectId;
      if (!projectPath || !projectId) return;
      const result = getFileTree(projectPath, projectId);
      reply({ type: LocalEventType.FileTree, fileTreeResult: result });
      break;
    }

    case LocalCommandType.GetFileContent: {
      const projectPath = msg.projectPath;
      const filePath = msg.filePath;
      if (!projectPath || !filePath) return;
      const result = getFileContent(projectPath, filePath);
      reply({ type: LocalEventType.FileContent, fileContentResult: result });
      break;
    }
  }
});

console.log('cc-web 本地服务已启动');

if (isDevMode()) {
  console.warn('════════════════════════════════════════════════════════');
  console.warn('  [DEV MODE] 开发模式 (NODE_ENV != "production")');
  if (!WORKSPACE_ROOT) {
    console.warn('  [INSECURE] WORKSPACE_ROOT 为空 — 任意路径均可作为项目目录');
  }
  console.warn('  公网部署时请设置 NODE_ENV=production 并配置工作区');
  console.warn('════════════════════════════════════════════════════════');
}

start();

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n正在关闭本地服务...');
  process.exit(0);
});

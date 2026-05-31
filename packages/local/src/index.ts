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
import { NODE_PASSWORD, NODE_ID, FORCE_PERMISSION_MODE, isDevMode, isNodePasswordEmpty, WORKSPACE_ROOT } from './config.js';
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
} from './session-manager.js';
import { getGitStatus, getGitDiff } from './git-utils.js';
import { getFileTree, getFileContent } from './file-utils.js';

// 加载持久化会话
loadPersistedSessions();

// 处理来自中转的消息
onMessage((msg) => {
  // 回传 _reqId（用于 HTTP API 请求-响应匹配）
  const reqId = msg._reqId as string | undefined;
  const reply = (data: Record<string, unknown>) => {
    if (reqId) data._reqId = reqId;
    send(data);
  };

  switch (msg.type) {
    case 'registered':
      console.log('已在服务中注册');
      // 重连后同步当前状态到前端
      {
        const sessions = listSessions();
        const sessionsWithHistory = sessions.map((s) => ({
          ...s,
          messages: getHistory(s.sessionId) || [],
        }));
        send({ type: 'sessions_list', sessions: sessionsWithHistory });
        const projects = listProjects();
        send({ type: 'projects_list', projects });
      }
      break;

    case 'chat': {
      let sessionId = msg.sessionId as string | undefined;
      const text = msg.text as string | undefined;
      const permMode = FORCE_PERMISSION_MODE || (msg.permissionMode as string) || undefined;
      if (!text) return;

      // 必须有有效的项目和会话，不允许自动创建
      if (!sessionId || !getSession(sessionId)) {
        if (sessionId) {
          send({ type: 'error', sessionId, error: '会话已过期，请刷新页面后重新创建会话' });
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
        send({ type: 'error', sessionId, error: `会话 ${sessionId.substring(0, 8)} 不存在` });
      }
      break;
    }

    case 'create_project': {
      const name = (msg.name as string) || '';
      const projectPath = msg.path as string;
      if (!name) {
        reply({ type: 'error', error: '项目名称不能为空' });
        return;
      }
      if (!projectPath) {
        reply({ type: 'error', error: '项目路径不能为空' });
        return;
      }
      try {
        const project = createProject(name, projectPath);
        console.log(`项目已创建: ${project.name} (${project.projectId.substring(0, 8)})`);
        reply({ type: 'project_info', project });
        const projects = listProjects();
        send({ type: 'projects_list', projects });
      } catch (err) {
        reply({ type: 'error', error: (err as Error).message });
      }
      break;
    }

    case 'list_projects': {
      const projects = listProjects();
      reply({ type: 'projects_list', projects });
      break;
    }

    case 'delete_project': {
      const projectId = msg.projectId as string;
      if (!projectId) return;
      const ok = deleteProject(projectId);
      if (ok) {
        console.log(`项目已删除: ${projectId.substring(0, 8)}`);
        const projects = listProjects();
        send({ type: 'projects_list', projects });
      }
      break;
    }

    case 'create_session': {
      const projectId = (msg.projectId as string) || '';
      const projectPath = msg.projectPath as string;
      const model = (msg.model as string) || undefined;
      const permissionMode = FORCE_PERMISSION_MODE || (msg.permissionMode as string) || undefined;
      if (!projectId) {
        reply({ type: 'error', error: '创建会话需要指定 projectId' });
        return;
      }
      if (!projectPath) {
        reply({ type: 'error', error: '创建会话需要指定 projectPath' });
        return;
      }
      const info = createSession(projectId, projectPath, model, permissionMode);
      console.log(`会话已创建: ${info.sessionId.substring(0, 8)} (${projectPath})${model ? `, 模型=${model}` : ""}${permissionMode ? `, 权限=${permissionMode}` : ""}`);
      send({ type: 'session_info', ...info });
      const projects = listProjects();
      send({ type: 'projects_list', projects });
      break;
    }

    case 'change_permission_mode': {
      const sid = msg.sessionId as string;
      const permMode = FORCE_PERMISSION_MODE || (msg.permissionMode as string);
      if (sid && permMode) switchPermissionMode(sid, permMode);
      break;
    }

    case 'retry_with_permission': {
      const sid = msg.sessionId as string;
      const permMode = FORCE_PERMISSION_MODE || (msg.permissionMode as string) || "bypassPermissions";
      if (sid) retryWithPermission(sid, permMode);
      break;
    }

    case 'stop_session': {
      const sid = msg.sessionId as string;
      if (sid) stopSession(sid);
      break;
    }

    case 'delete_session': {
      const sid = msg.sessionId as string;
      if (!sid) return;
      const ok = deleteSession(sid);
      if (ok) {
        console.log(`会话已删除: ${sid.substring(0, 8)}`);
        const sessions = listSessions();
        send({ type: 'sessions_list', sessions: sessions.map((s) => ({ ...s, messages: getHistory(s.sessionId) || [] })) });
        const projects = listProjects();
        send({ type: 'projects_list', projects });
      }
      break;
    }

    case 'list_sessions': {
      const projectId = msg.projectId as string | undefined;
      const sessions = listSessions(projectId);
      const sessionsWithHistory = sessions.map((s) => ({
        ...s,
        messages: getHistory(s.sessionId) || [],
      }));
      reply({ type: 'sessions_list', sessions: sessionsWithHistory });
      break;
    }

    case 'auth_node': {
      const password = msg.password as string;
      if (!NODE_PASSWORD) {
        reply({ type: 'auth_result', nodeId: NODE_ID, success: true });
      } else if (password === NODE_PASSWORD) {
        reply({ type: 'auth_result', nodeId: NODE_ID, success: true });
      } else {
        reply({ type: 'auth_result', nodeId: NODE_ID, success: false, error: '密码错误' });
      }
      break;
    }

    case 'get_git_status': {
      const projectPath = msg.projectPath as string;
      const projectId = msg.projectId as string;
      if (!projectPath || !projectId) return;
      const status = getGitStatus(projectPath, projectId);
      reply({ type: 'git_status', gitStatus: status });
      break;
    }

    case 'get_git_diff': {
      const projectPath = msg.projectPath as string;
      const filePath = msg.filePath as string;
      const staged = msg.staged === true;
      if (!projectPath || !filePath) return;
      const result = getGitDiff(projectPath, filePath, staged);
      reply({ type: 'git_diff', diffResult: result, staged });
      break;
    }

    case 'get_file_tree': {
      const projectPath = msg.projectPath as string;
      const projectId = msg.projectId as string;
      if (!projectPath || !projectId) return;
      const result = getFileTree(projectPath, projectId);
      reply({ type: 'file_tree', fileTreeResult: result });
      break;
    }

    case 'get_file_content': {
      const projectPath = msg.projectPath as string;
      const filePath = msg.filePath as string;
      if (!projectPath || !filePath) return;
      const result = getFileContent(projectPath, filePath);
      reply({ type: 'file_content', fileContentResult: result });
      break;
    }
  }
});

console.log('cc-web 本地服务已启动');

if (isDevMode()) {
  console.warn('════════════════════════════════════════════════════════');
  console.warn('  [DEV MODE] 开发模式 (NODE_ENV != "production")');
  if (isNodePasswordEmpty()) {
    console.warn('  [INSECURE] NODE_PASSWORD 为空 — 无需密码认证即可执行命令');
  }
  if (!WORKSPACE_ROOT) {
    console.warn('  [INSECURE] WORKSPACE_ROOT 为空 — 任意路径均可作为项目目录');
  }
  console.warn('  公网部署时请设置 NODE_ENV=production 并配置密码和工作区');
  console.warn('════════════════════════════════════════════════════════');
}

start();

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n正在关闭本地服务...');
  process.exit(0);
});

// 三端共享的 DTO 集中在 @cc-web/shared；本文件仅保留 relay 的四向消息类型。
// SessionInfo 此前为欠类型的抄本（messages 为 unknown[]、缺 model/permissionMode），现统一取 shared canonical 形状。

export type {
  ProjectInfo,
  SessionInfo,
  GitStatusFile,
  GitStatusResult,
  GitDiffResult,
  FileTreeNode,
  FileTreeResult,
  FileContentResult,
} from '@cc-web/shared';

import type {
  SessionInfo,
  ProjectInfo,
  GitStatusResult,
  GitDiffResult,
  FileTreeResult,
  FileContentResult,
} from '@cc-web/shared';

export interface BrowserMessage {
  type: 'chat' | 'create_session' | 'stop_session' | 'delete_session' | 'list_sessions' | 'create_project' | 'delete_project' | 'list_projects' | 'select_node' | 'list_nodes' | 'retry_with_permission' | 'change_permission_mode' | 'auth_node' | 'get_git_status' | 'get_git_diff' | 'get_file_tree' | 'get_file_content';
  sessionId?: string;
  text?: string;
  projectPath?: string;
  projectId?: string;
  nodeId?: string;
  name?: string;
  path?: string;
  model?: string;
  permissionMode?: string;
  password?: string;
  filePath?: string;
  staged?: boolean;
  gitStatus?: GitStatusResult;
  diffResult?: GitDiffResult;
  fileTreeResult?: FileTreeResult;
  fileContentResult?: FileContentResult;
}

export interface LocalMessage {
  type: 'register' | 'claude_json' | 'done' | 'error' | 'pong' | 'aborted' | 'session_info' | 'session_end' | 'sessions_list' | 'projects_list' | 'project_info' | 'retry_with_permission' | 'change_permission_mode' | 'create_session' | 'create_project' | 'delete_project' | 'delete_session' | 'list_sessions' | 'list_projects' | 'stop_session' | 'chat' | 'auth_node' | 'auth_result' | 'get_git_status' | 'get_git_diff' | 'git_status' | 'git_diff' | 'get_file_tree' | 'file_tree' | 'get_file_content' | 'file_content';
  sessionId?: string;
  data?: unknown;
  error?: string;
  nodeId?: string;
  token?: string;
  projectPath?: string;
  projectId?: string;
  name?: string;
  path?: string;
  text?: string;
  model?: string;
  permissionMode?: string;
  sessions?: SessionInfo[];
  projects?: ProjectInfo[];
  project?: ProjectInfo;
  _reqId?: string;
  password?: string;
  success?: boolean;
  passwordRequired?: boolean;
  workspaceRoot?: string;
  filePath?: string;
  staged?: boolean;
  gitStatus?: GitStatusResult;
  diffResult?: GitDiffResult;
  fileTreeResult?: FileTreeResult;
  fileContentResult?: FileContentResult;
}

export interface RelayMessage {
  type: 'claude_json' | 'done' | 'error' | 'aborted' | 'session_info' | 'session_end' | 'sessions_list' | 'projects_list' | 'project_info' | 'nodes_list' | 'node_selected' | 'auth_result' | 'auth_required' | 'git_status' | 'git_diff' | 'file_tree' | 'file_content';
  sessionId?: string;
  nodeId?: string;
  data?: unknown;
  error?: string;
  message?: string;
  sessions?: SessionInfo[];
  projects?: ProjectInfo[];
  project?: ProjectInfo;
  nodes?: Array<{ nodeId: string; sessionCount: number; passwordRequired: boolean; workspaceRoot?: string }>;
  success?: boolean;
  gitStatus?: GitStatusResult;
  diffResult?: GitDiffResult;
  fileTreeResult?: FileTreeResult;
  fileContentResult?: FileContentResult;
}

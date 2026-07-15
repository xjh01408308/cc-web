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

export interface ProjectInfo {
  projectId: string;
  name: string;
  path: string;
  sessionCount: number;
  createdAt: number;
}

export interface SessionInfo {
  sessionId: string;
  projectId: string;
  projectPath: string;
  summary: string;
  status: 'idle' | 'running' | 'error';
  messageCount: number;
  createdAt: number;
  messages?: unknown[];
}

export interface GitStatusFile {
  path: string;
  staged: string;
  unstaged: string;
  displayPath: string;
}

export interface GitStatusResult {
  projectPath: string;
  projectId: string;
  isGitRepo: boolean;
  error?: string;
  staged: GitStatusFile[];
  unstaged: GitStatusFile[];
  untracked: GitStatusFile[];
}

export interface GitDiffResult {
  projectPath: string;
  filePath: string;
  diff: string;
  error?: string;
}

export interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileTreeNode[];
}

export interface FileTreeResult {
  projectPath: string;
  projectId: string;
  tree: FileTreeNode[];
  error?: string;
}

export interface FileContentResult {
  projectPath: string;
  filePath: string;
  content: string;
  mimeType: 'markdown' | 'html' | 'code' | 'text' | 'binary';
  language?: string;
  error?: string;
}

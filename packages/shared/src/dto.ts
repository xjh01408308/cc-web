// cc-web 三端共享的 canonical DTO。
// 形状以 packages/local 现有定义为准（local 是数据源）。
// 此 expand 阶段与各包自带 types.ts 并存，尚无代码消费。

/** 单条流式响应（local → relay → browser 逐帧推送） */
export interface StreamResponse {
  type: 'claude_json' | 'error' | 'done' | 'aborted';
  /** SDKMessage 对象（type 为 claude_json 时） */
  data?: unknown;
  error?: string;
}

/** 项目元信息 */
export interface ProjectInfo {
  projectId: string;
  name: string;
  path: string;
  nodeId?: string;
  sessionCount: number;
  createdAt: number;
}

/** 会话元信息 */
export interface SessionInfo {
  sessionId: string;
  projectId: string;
  projectPath: string;
  model?: string;
  permissionMode?: string;
  summary: string;
  status: 'idle' | 'running' | 'error';
  messageCount: number;
  createdAt: number;
  messages?: StreamResponse[];
}

/** 在线节点描述（nodes_list 事件的元素） */
export interface NodeInfo {
  nodeId: string;
  sessionCount: number;
  passwordRequired?: boolean;
  workspaceRoot?: string;
}

/** git status 单行 */
export interface GitStatusFile {
  path: string;
  staged: string; // X 列（index）
  unstaged: string; // Y 列（working tree）
  displayPath: string; // 重命名时为 "old -> new"
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
  diff: string; // unified diff 文本
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

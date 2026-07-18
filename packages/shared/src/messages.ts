// cc-web 三端 WS 协议的 canonical 消息定义。
//
// 拓扑：  Browser  ⇄  Relay  ⇄  Local
//
// 四个方向性 discriminated union：
//   BrowserCommand — 浏览器 → 中转（下行第一跳）
//   LocalCommand    — 中转 → 本地（下行第二跳；relay 转发并注入 nodeId / _reqId）
//   LocalEvent      — 本地 → 中转（上行第一跳）
//   BrowserEvent    — 中转 → 浏览器（上行第二跳；relay 转发并注入 nodeId）
//
// 另有 LocalControl（中转 → 本地的非命令控制消息：registered / ping 心跳），
// 与 LocalCommand 同方向但不承载业务命令，独立成联合。
//
// 下行命令在两跳复用的载荷抽成共享子类型（ChatPayload / CreateSessionPayload）。
// 三端均直接消费本文件的 union 与常量，不再自带扁平信封类型。

import type {
  SessionInfo,
  ProjectInfo,
  NodeInfo,
  GitStatusResult,
  GitDiffResult,
  FileTreeResult,
  FileContentResult,
} from './dto.js';

// ---- 下行命令共享载荷（两跳复用）----

/** chat 命令载荷：Browser→Relay→Local 两跳复用 */
export interface ChatPayload {
  sessionId: string;
  text: string;
  permissionMode?: string;
  projectPath?: string;
}

/** create_session 命令载荷：两跳复用 */
export interface CreateSessionPayload {
  projectPath: string;
  projectId?: string;
  model?: string;
  permissionMode?: string;
}

// ===========================================================================
// BrowserCommand — 浏览器 → 中转
// ===========================================================================

export const BrowserCommandType = {
  Chat: 'chat',
  CreateSession: 'create_session',
  StopSession: 'stop_session',
  DeleteSession: 'delete_session',
  ListSessions: 'list_sessions',
  CreateProject: 'create_project',
  DeleteProject: 'delete_project',
  ListProjects: 'list_projects',
  SelectNode: 'select_node',
  ListNodes: 'list_nodes',
  RetryWithPermission: 'retry_with_permission',
  ChangePermissionMode: 'change_permission_mode',
  AuthNode: 'auth_node',
  GetGitStatus: 'get_git_status',
  GetGitDiff: 'get_git_diff',
  GetFileTree: 'get_file_tree',
  GetFileContent: 'get_file_content',
} as const;

export interface BrowserChatCommand extends ChatPayload {
  type: typeof BrowserCommandType.Chat;
  nodeId?: string;
}

export interface BrowserCreateSessionCommand extends CreateSessionPayload {
  type: typeof BrowserCommandType.CreateSession;
  nodeId?: string;
}

export interface BrowserStopSessionCommand {
  type: typeof BrowserCommandType.StopSession;
  sessionId: string;
  nodeId?: string;
}

export interface BrowserDeleteSessionCommand {
  type: typeof BrowserCommandType.DeleteSession;
  sessionId: string;
  nodeId?: string;
}

export interface BrowserListSessionsCommand {
  type: typeof BrowserCommandType.ListSessions;
  projectId?: string;
  nodeId?: string;
}

export interface BrowserCreateProjectCommand {
  type: typeof BrowserCommandType.CreateProject;
  name: string;
  path: string;
  nodeId?: string;
}

export interface BrowserDeleteProjectCommand {
  type: typeof BrowserCommandType.DeleteProject;
  projectId: string;
  nodeId?: string;
}

export interface BrowserListProjectsCommand {
  type: typeof BrowserCommandType.ListProjects;
  nodeId?: string;
}

/** relay 自处理：选择当前浏览器绑定的节点 */
export interface BrowserSelectNodeCommand {
  type: typeof BrowserCommandType.SelectNode;
  nodeId: string;
}

/** relay 自处理：返回在线节点列表 */
export interface BrowserListNodesCommand {
  type: typeof BrowserCommandType.ListNodes;
}

export interface BrowserRetryWithPermissionCommand {
  type: typeof BrowserCommandType.RetryWithPermission;
  sessionId: string;
  permissionMode: string;
  nodeId?: string;
}

export interface BrowserChangePermissionModeCommand {
  type: typeof BrowserCommandType.ChangePermissionMode;
  sessionId: string;
  permissionMode: string;
  nodeId?: string;
}

export interface BrowserAuthNodeCommand {
  type: typeof BrowserCommandType.AuthNode;
  nodeId: string;
  password: string;
}

export interface BrowserGetGitStatusCommand {
  type: typeof BrowserCommandType.GetGitStatus;
  projectPath: string;
  projectId: string;
  nodeId?: string;
}

export interface BrowserGetGitDiffCommand {
  type: typeof BrowserCommandType.GetGitDiff;
  projectPath: string;
  filePath: string;
  staged: boolean;
  nodeId?: string;
}

export interface BrowserGetFileTreeCommand {
  type: typeof BrowserCommandType.GetFileTree;
  projectPath: string;
  projectId: string;
  nodeId?: string;
}

export interface BrowserGetFileContentCommand {
  type: typeof BrowserCommandType.GetFileContent;
  projectPath: string;
  filePath: string;
  nodeId?: string;
}

export type BrowserCommand =
  | BrowserChatCommand
  | BrowserCreateSessionCommand
  | BrowserStopSessionCommand
  | BrowserDeleteSessionCommand
  | BrowserListSessionsCommand
  | BrowserCreateProjectCommand
  | BrowserDeleteProjectCommand
  | BrowserListProjectsCommand
  | BrowserSelectNodeCommand
  | BrowserListNodesCommand
  | BrowserRetryWithPermissionCommand
  | BrowserChangePermissionModeCommand
  | BrowserAuthNodeCommand
  | BrowserGetGitStatusCommand
  | BrowserGetGitDiffCommand
  | BrowserGetFileTreeCommand
  | BrowserGetFileContentCommand;

// ===========================================================================
// LocalCommand — 中转 → 本地（转发的下行命令；请求-响应类带 _reqId）
// ===========================================================================

export const LocalCommandType = {
  Chat: 'chat',
  CreateSession: 'create_session',
  StopSession: 'stop_session',
  DeleteSession: 'delete_session',
  ListSessions: 'list_sessions',
  CreateProject: 'create_project',
  DeleteProject: 'delete_project',
  ListProjects: 'list_projects',
  RetryWithPermission: 'retry_with_permission',
  ChangePermissionMode: 'change_permission_mode',
  AuthNode: 'auth_node',
  GetGitStatus: 'get_git_status',
  GetGitDiff: 'get_git_diff',
  GetFileTree: 'get_file_tree',
  GetFileContent: 'get_file_content',
} as const;

/** relay 用于把 local 的响应匹配回原始浏览器请求 */
export interface RequestEnvelope {
  _reqId: string;
}

export interface LocalChatCommand extends ChatPayload {
  type: typeof LocalCommandType.Chat;
}

export interface LocalCreateSessionCommand extends CreateSessionPayload {
  type: typeof LocalCommandType.CreateSession;
}

export interface LocalStopSessionCommand {
  type: typeof LocalCommandType.StopSession;
  sessionId: string;
}

export interface LocalDeleteSessionCommand {
  type: typeof LocalCommandType.DeleteSession;
  sessionId: string;
}

export interface LocalListSessionsCommand extends RequestEnvelope {
  type: typeof LocalCommandType.ListSessions;
  projectId?: string;
}

export interface LocalCreateProjectCommand extends RequestEnvelope {
  type: typeof LocalCommandType.CreateProject;
  name: string;
  path: string;
}

export interface LocalDeleteProjectCommand {
  type: typeof LocalCommandType.DeleteProject;
  projectId: string;
}

export interface LocalListProjectsCommand extends RequestEnvelope {
  type: typeof LocalCommandType.ListProjects;
}

export interface LocalRetryWithPermissionCommand {
  type: typeof LocalCommandType.RetryWithPermission;
  sessionId: string;
  permissionMode: string;
}

export interface LocalChangePermissionModeCommand {
  type: typeof LocalCommandType.ChangePermissionMode;
  sessionId: string;
  permissionMode: string;
}

export interface LocalAuthNodeCommand extends RequestEnvelope {
  type: typeof LocalCommandType.AuthNode;
  password: string;
}

export interface LocalGetGitStatusCommand extends RequestEnvelope {
  type: typeof LocalCommandType.GetGitStatus;
  projectPath: string;
  projectId: string;
}

export interface LocalGetGitDiffCommand extends RequestEnvelope {
  type: typeof LocalCommandType.GetGitDiff;
  projectPath: string;
  filePath: string;
  staged: boolean;
}

export interface LocalGetFileTreeCommand extends RequestEnvelope {
  type: typeof LocalCommandType.GetFileTree;
  projectPath: string;
  projectId: string;
}

export interface LocalGetFileContentCommand extends RequestEnvelope {
  type: typeof LocalCommandType.GetFileContent;
  projectPath: string;
  filePath: string;
}

export type LocalCommand =
  | LocalChatCommand
  | LocalCreateSessionCommand
  | LocalStopSessionCommand
  | LocalDeleteSessionCommand
  | LocalListSessionsCommand
  | LocalCreateProjectCommand
  | LocalDeleteProjectCommand
  | LocalListProjectsCommand
  | LocalRetryWithPermissionCommand
  | LocalChangePermissionModeCommand
  | LocalAuthNodeCommand
  | LocalGetGitStatusCommand
  | LocalGetGitDiffCommand
  | LocalGetFileTreeCommand
  | LocalGetFileContentCommand;

// ===========================================================================
// LocalControl — 中转 → 本地（非命令控制：注册确认 / 心跳探测）
// ===========================================================================

export const LocalControlType = {
  Registered: 'registered',
  Ping: 'ping',
} as const;

/** relay 确认 local 的 register 成功 */
export interface LocalRegisteredMessage {
  type: typeof LocalControlType.Registered;
}

/** relay 心跳探测（local 回 LocalPongEvent） */
export interface LocalPingMessage {
  type: typeof LocalControlType.Ping;
}

export type LocalControl = LocalRegisteredMessage | LocalPingMessage;

// ===========================================================================
// LocalEvent — 本地 → 中转
// ===========================================================================

export const LocalEventType = {
  Register: 'register',
  ClaudeJson: 'claude_json',
  Done: 'done',
  Error: 'error',
  Pong: 'pong',
  Aborted: 'aborted',
  SessionInfo: 'session_info',
  SessionEnd: 'session_end',
  SessionsList: 'sessions_list',
  ProjectsList: 'projects_list',
  ProjectInfo: 'project_info',
  AuthResult: 'auth_result',
  GitStatus: 'git_status',
  GitDiff: 'git_diff',
  FileTree: 'file_tree',
  FileContent: 'file_content',
} as const;

export interface LocalRegisterEvent {
  type: typeof LocalEventType.Register;
  nodeId?: string;
  token: string;
  passwordRequired?: boolean;
  workspaceRoot?: string;
}

export interface LocalClaudeJsonEvent {
  type: typeof LocalEventType.ClaudeJson;
  sessionId: string;
  data?: unknown;
}

export interface LocalDoneEvent {
  type: typeof LocalEventType.Done;
  sessionId: string;
}

export interface LocalErrorEvent {
  type: typeof LocalEventType.Error;
  sessionId?: string;
  error: string;
  data?: unknown;
  /** relay 请求-响应匹配（reply error 路径）；转发到浏览器时由 relay 剥离 */
  _reqId?: string;
}

export interface LocalPongEvent {
  type: typeof LocalEventType.Pong;
}

export interface LocalAbortedEvent {
  type: typeof LocalEventType.Aborted;
  sessionId: string;
}

/** 继承 SessionInfo：local 调用 send({ type:'session_info', ...info }) */
export interface LocalSessionInfoEvent extends SessionInfo {
  type: typeof LocalEventType.SessionInfo;
}

export interface LocalSessionEndEvent {
  type: typeof LocalEventType.SessionEnd;
  sessionId: string;
  reason?: string;
}

export interface LocalSessionsListEvent {
  type: typeof LocalEventType.SessionsList;
  sessions: SessionInfo[];
  _reqId?: string;
}

export interface LocalProjectsListEvent {
  type: typeof LocalEventType.ProjectsList;
  projects: ProjectInfo[];
  _reqId?: string;
}

export interface LocalProjectInfoEvent {
  type: typeof LocalEventType.ProjectInfo;
  project: ProjectInfo;
  _reqId?: string;
}

export interface LocalAuthResultEvent {
  type: typeof LocalEventType.AuthResult;
  success: boolean;
  error?: string;
  _reqId?: string;
}

export interface LocalGitStatusEvent {
  type: typeof LocalEventType.GitStatus;
  gitStatus: GitStatusResult;
  _reqId?: string;
}

export interface LocalGitDiffEvent {
  type: typeof LocalEventType.GitDiff;
  diffResult: GitDiffResult;
  staged?: boolean;
  _reqId?: string;
}

export interface LocalFileTreeEvent {
  type: typeof LocalEventType.FileTree;
  fileTreeResult: FileTreeResult;
  _reqId?: string;
}

export interface LocalFileContentEvent {
  type: typeof LocalEventType.FileContent;
  fileContentResult: FileContentResult;
  _reqId?: string;
}

export type LocalEvent =
  | LocalRegisterEvent
  | LocalClaudeJsonEvent
  | LocalDoneEvent
  | LocalErrorEvent
  | LocalPongEvent
  | LocalAbortedEvent
  | LocalSessionInfoEvent
  | LocalSessionEndEvent
  | LocalSessionsListEvent
  | LocalProjectsListEvent
  | LocalProjectInfoEvent
  | LocalAuthResultEvent
  | LocalGitStatusEvent
  | LocalGitDiffEvent
  | LocalFileTreeEvent
  | LocalFileContentEvent;

/** LocalEvent 中带 `_reqId` 的请求-响应类事件（local→relay，relay 据此匹配回原始请求）。
 *  reply() 只接受这个子联合，避免给无 _reqId 的变体塞 _reqId（type hole）。 */
export type LocalResponseEvent =
  | LocalErrorEvent
  | LocalSessionsListEvent
  | LocalProjectsListEvent
  | LocalProjectInfoEvent
  | LocalAuthResultEvent
  | LocalGitStatusEvent
  | LocalGitDiffEvent
  | LocalFileTreeEvent
  | LocalFileContentEvent;

// ===========================================================================
// BrowserEvent — 中转 → 浏览器（转发的事件注入 nodeId；另含 relay 自产事件）
// ===========================================================================

export const BrowserEventType = {
  ClaudeJson: 'claude_json',
  Done: 'done',
  Error: 'error',
  Aborted: 'aborted',
  SessionInfo: 'session_info',
  SessionEnd: 'session_end',
  SessionsList: 'sessions_list',
  ProjectsList: 'projects_list',
  ProjectInfo: 'project_info',
  NodesList: 'nodes_list',
  NodeSelected: 'node_selected',
  AuthResult: 'auth_result',
  AuthRequired: 'auth_required',
  GitStatus: 'git_status',
  GitDiff: 'git_diff',
  FileTree: 'file_tree',
  FileContent: 'file_content',
} as const;

export interface BrowserClaudeJsonEvent {
  type: typeof BrowserEventType.ClaudeJson;
  sessionId: string;
  nodeId?: string;
  data?: unknown;
}

export interface BrowserDoneEvent {
  type: typeof BrowserEventType.Done;
  sessionId: string;
  nodeId?: string;
}

export interface BrowserErrorEvent {
  type: typeof BrowserEventType.Error;
  sessionId?: string;
  nodeId?: string;
  error: string;
}

export interface BrowserAbortedEvent {
  type: typeof BrowserEventType.Aborted;
  sessionId: string;
  nodeId?: string;
}

export interface BrowserSessionInfoEvent extends SessionInfo {
  type: typeof BrowserEventType.SessionInfo;
  nodeId?: string;
}

export interface BrowserSessionEndEvent {
  type: typeof BrowserEventType.SessionEnd;
  sessionId: string;
  nodeId?: string;
  reason?: string;
}

export interface BrowserSessionsListEvent {
  type: typeof BrowserEventType.SessionsList;
  sessions: SessionInfo[];
  nodeId?: string;
}

export interface BrowserProjectsListEvent {
  type: typeof BrowserEventType.ProjectsList;
  projects: ProjectInfo[];
  nodeId?: string;
}

export interface BrowserProjectInfoEvent {
  type: typeof BrowserEventType.ProjectInfo;
  project: ProjectInfo;
  nodeId?: string;
}

/** relay 自产：在线节点列表 */
export interface BrowserNodesListEvent {
  type: typeof BrowserEventType.NodesList;
  nodes: NodeInfo[];
}

/** relay 自产：浏览器已绑定节点 */
export interface BrowserNodeSelectedEvent {
  type: typeof BrowserEventType.NodeSelected;
  nodeId: string;
}

export interface BrowserAuthResultEvent {
  type: typeof BrowserEventType.AuthResult;
  nodeId: string;
  success: boolean;
  error?: string;
}

/** relay 自产：节点需要密码，前端据此弹密码框 */
export interface BrowserAuthRequiredEvent {
  type: typeof BrowserEventType.AuthRequired;
  nodeId: string;
  message: string;
}

export interface BrowserGitStatusEvent {
  type: typeof BrowserEventType.GitStatus;
  gitStatus: GitStatusResult;
  nodeId?: string;
}

export interface BrowserGitDiffEvent {
  type: typeof BrowserEventType.GitDiff;
  diffResult: GitDiffResult;
  staged?: boolean;
  nodeId?: string;
}

export interface BrowserFileTreeEvent {
  type: typeof BrowserEventType.FileTree;
  fileTreeResult: FileTreeResult;
  nodeId?: string;
}

export interface BrowserFileContentEvent {
  type: typeof BrowserEventType.FileContent;
  fileContentResult: FileContentResult;
  nodeId?: string;
}

export type BrowserEvent =
  | BrowserClaudeJsonEvent
  | BrowserDoneEvent
  | BrowserErrorEvent
  | BrowserAbortedEvent
  | BrowserSessionInfoEvent
  | BrowserSessionEndEvent
  | BrowserSessionsListEvent
  | BrowserProjectsListEvent
  | BrowserProjectInfoEvent
  | BrowserNodesListEvent
  | BrowserNodeSelectedEvent
  | BrowserAuthResultEvent
  | BrowserAuthRequiredEvent
  | BrowserGitStatusEvent
  | BrowserGitDiffEvent
  | BrowserFileTreeEvent
  | BrowserFileContentEvent;

// 三端共享的 DTO 集中在 @cc-web/shared；本文件仅保留 local 自有的 WSMessage。
// SessionInfo 以 @cc-web/shared 的 canonical 形状为准（含 model? / permissionMode? / messages?: StreamResponse[]）。

export type {
  StreamResponse,
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

export interface WSMessage {
  type: string;
  sessionId?: string;
  text?: string;
  projectPath?: string;
  projectId?: string;
  name?: string;
  data?: unknown;
  error?: string;
  nodeId?: string;
  token?: string;
  password?: string;
  success?: boolean;
  passwordRequired?: boolean;
  sessions?: SessionInfo[];
  projects?: ProjectInfo[];
  project?: ProjectInfo;
  filePath?: string;
  staged?: boolean;
  gitStatus?: GitStatusResult;
  diffResult?: GitDiffResult;
  fileTreeResult?: FileTreeResult;
  fileContentResult?: FileContentResult;
}

// relay 消费的全部协议类型来自 @cc-web/shared：
//   DTO（SessionInfo / ProjectInfo / Git* / File* / NodeInfo ...）
//   四向消息 union（BrowserCommand / LocalCommand / LocalEvent / BrowserEvent）+ LocalControl
//   各方向 as const 常量对象（BrowserCommandType / LocalCommandType / LocalEventType / BrowserEventType / LocalControlType）
// relay 不再自带扁平信封类型。

export type {
  // DTO
  StreamResponse,
  ProjectInfo,
  SessionInfo,
  NodeInfo,
  GitStatusFile,
  GitStatusResult,
  GitDiffResult,
  FileTreeNode,
  FileTreeResult,
  FileContentResult,
  // 四向消息 union
  BrowserCommand,
  LocalCommand,
  LocalEvent,
  BrowserEvent,
  LocalControl,
  // 下行命令共享载荷
  ChatPayload,
  CreateSessionPayload,
  RequestEnvelope,
} from '@cc-web/shared';

export {
  BrowserCommandType,
  LocalCommandType,
  LocalEventType,
  BrowserEventType,
  LocalControlType,
} from '@cc-web/shared';

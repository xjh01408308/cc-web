// local 消费的全部协议类型来自 @cc-web/shared：
//   DTO（StreamResponse / SessionInfo / ProjectInfo / Git* / File*）
//   local 收到的下行消息（LocalCommand + LocalControl）、发出的上行事件（LocalEvent）
//   as const 常量对象（LocalCommandType / LocalControlType / LocalEventType）
// local 不再自带 WSMessage 扁平信封。

export type {
  // DTO
  StreamResponse,
  ProjectInfo,
  SessionInfo,
  GitStatusFile,
  GitStatusResult,
  GitDiffResult,
  FileTreeNode,
  FileTreeResult,
  FileContentResult,
  // local 收到（relay→local）：业务命令 + 控制消息
  LocalCommand,
  LocalControl,
  // local 发出（local→relay）：上行事件
  LocalEvent,
  // LocalEvent 中带 _reqId 的子联合（reply 用）
  LocalResponseEvent,
} from '@cc-web/shared';

export { LocalCommandType, LocalControlType, LocalEventType, HISTORY_PAGE_SIZE } from '@cc-web/shared';

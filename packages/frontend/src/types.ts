import type {
  SDKUserMessage,
  SDKAssistantMessage,
  SDKSystemMessage,
  SDKResultMessage,
  PermissionMode as SDKPermissionMode,
} from "@anthropic-ai/claude-code";

// Chat message for user/assistant interactions (not part of SDKMessage)
export interface ChatMessage {
  type: "chat";
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

// Error message for streaming errors
export type ErrorMessage = {
  type: "error";
  subtype: "stream_error";
  message: string;
  timestamp: number;
};

// Abort message for aborted operations
export type AbortMessage = {
  type: "system";
  subtype: "abort";
  message: string;
  timestamp: number;
};

// Hooks message for hook execution notifications
export type HooksMessage = {
  type: "system";
  content: string;
  level?: string;
  toolUseID?: string;
};

// System message extending SDK types with timestamp
export type SystemMessage = (
  | SDKSystemMessage
  | SDKResultMessage
  | ErrorMessage
  | AbortMessage
  | HooksMessage
) & {
  timestamp: number;
};

// Tool message for tool usage display
export type ToolMessage = {
  type: "tool";
  content: string;
  timestamp: number;
};

// Tool result message for tool result display
export type ToolResultMessage = {
  type: "tool_result";
  toolName: string;
  content: string;
  summary: string;
  timestamp: number;
  toolUseResult?: unknown; // Contains structured data like structuredPatch, stdout, stderr etc.
};

// Plan approval dialog state
export interface PlanApprovalDialog {
  isOpen: boolean;
  plan: string;
  toolUseId: string;
}

// Plan message type for UI display
export interface PlanMessage {
  type: "plan";
  plan: string;
  toolUseId: string;
  timestamp: number;
}

// Thinking message for Claude's reasoning process
export interface ThinkingMessage {
  type: "thinking";
  content: string;
  timestamp: number;
}

// Todo item structure for TodoWrite tool results
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

// Todo message for TodoWrite tool result display
export interface TodoMessage {
  type: "todo";
  todos: TodoItem[];
  timestamp: number;
}

// Thinking content item from Claude SDK
export interface ThinkingContentItem {
  type: "thinking";
  thinking: string;
}

// TimestampedSDKMessage types for conversation history API
// These extend Claude SDK types with timestamp information
type WithTimestamp<T> = T & { timestamp: string };

export type TimestampedSDKUserMessage = WithTimestamp<SDKUserMessage>;
export type TimestampedSDKAssistantMessage = WithTimestamp<SDKAssistantMessage>;
export type TimestampedSDKSystemMessage = WithTimestamp<SDKSystemMessage>;
export type TimestampedSDKResultMessage = WithTimestamp<SDKResultMessage>;

export type TimestampedSDKMessage =
  | TimestampedSDKUserMessage
  | TimestampedSDKAssistantMessage
  | TimestampedSDKSystemMessage
  | TimestampedSDKResultMessage;

export type AllMessage =
  | ChatMessage
  | SystemMessage
  | ToolMessage
  | ToolResultMessage
  | PlanMessage
  | ThinkingMessage
  | TodoMessage;

// Type guard functions
export function isChatMessage(message: AllMessage): message is ChatMessage {
  return message.type === "chat";
}

export function isSystemMessage(message: AllMessage): message is SystemMessage {
  return (
    message.type === "system" ||
    message.type === "result" ||
    message.type === "error"
  );
}

export function isToolMessage(message: AllMessage): message is ToolMessage {
  return message.type === "tool";
}

export function isToolResultMessage(
  message: AllMessage,
): message is ToolResultMessage {
  return message.type === "tool_result";
}

export function isPlanMessage(message: AllMessage): message is PlanMessage {
  return message.type === "plan";
}

export function isThinkingMessage(
  message: AllMessage,
): message is ThinkingMessage {
  return message.type === "thinking";
}

export function isTodoMessage(message: AllMessage): message is TodoMessage {
  return message.type === "todo";
}

// Permission mode types (UI-focused subset of SDK PermissionMode)
export type PermissionMode = "default" | "plan" | "acceptEdits";

// SDK type integration utilities
export function toSDKPermissionMode(uiMode: PermissionMode): SDKPermissionMode {
  return uiMode as SDKPermissionMode;
}

export function fromSDKPermissionMode(
  sdkMode: SDKPermissionMode,
): PermissionMode {
  // Filter out bypassPermissions for UI
  return sdkMode === "bypassPermissions" ? "default" : sdkMode;
}

// Chat state extensions for permission mode
export interface ChatStatePermissions {
  permissionMode: PermissionMode;
  planApprovalDialog: PlanApprovalDialog | null;
  setPermissionMode: (mode: PermissionMode) => void;
  showPlanApprovalDialog: (plan: string, toolUseId: string) => void;
  closePlanApprovalDialog: () => void;
  approvePlan: () => void;
  rejectPlan: () => void;
}

// Permission mode preference type
export interface PermissionModePreference {
  mode: PermissionMode;
  timestamp: number;
}

// Plan approval error types (simplified, realistic)
export interface PlanApprovalError {
  type: "user_rejected" | "network_error";
  message: string;
  canRetry: boolean;
}

export type PlanApprovalResult =
  | { success: true; sessionId: string }
  | { success: false; error: PlanApprovalError };

// DTO 统一从 @cc-web/shared 导入（SessionInfo / ProjectInfo 等不再在此重复定义）
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
} from "@cc-web/shared";

// ChatRequest / ProjectsResponse 暂仍来自 legacy shared/types（不在本次迁移范围）
export type { ChatRequest, ProjectsResponse } from "../../shared/types";

// Re-export SDK types
export type {
  SDKMessage,
  SDKSystemMessage,
  SDKResultMessage,
  SDKAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-code";

// ====== cc-web WS 协议消息类型 ======

// 浏览器 → 中转
// 节点信息
export interface NodeInfo {
  nodeId: string;
  sessionCount: number;
  passwordRequired?: boolean;
  workspaceRoot?: string;
}

export interface WSAuthNodeMessage {
  type: 'auth_node';
  nodeId: string;
  password: string;
}

export interface WSChatMessage {
  type: "chat";
  sessionId: string;
  text: string;
  nodeId?: string;
  permissionMode?: string;
}

export interface WSCreateSessionMessage {
  type: "create_session";
  projectPath: string;
  projectId?: string;
  nodeId?: string;
  model?: string;
  permissionMode?: string;
}

export interface WSStopSessionMessage {
  type: "stop_session";
  sessionId: string;
  nodeId?: string;
}

export interface WSDeleteSessionMessage {
  type: "delete_session";
  sessionId: string;
  nodeId?: string;
}

export interface WSListSessionsMessage {
  type: "list_sessions";
  projectId?: string;
  nodeId?: string;
}

export interface WSCreateProjectMessage {
  type: "create_project";
  name: string;
  path: string;
  nodeId?: string;
}

export interface WSDeleteProjectMessage {
  type: "delete_project";
  projectId: string;
  nodeId?: string;
}

export interface WSListProjectsMessage {
  type: "list_projects";
  nodeId?: string;
}

export interface WSSelectNodeMessage {
  type: "select_node";
  nodeId: string;
}

export interface WSListNodesMessage {
  type: "list_nodes";
}

export interface WSChangePermissionModeMessage {
  type: "change_permission_mode";
  sessionId: string;
  permissionMode: string;
  nodeId?: string;
}

export interface WSRetryWithPermissionMessage {
  type: "retry_with_permission";
  sessionId: string;
  permissionMode: string;
  nodeId?: string;
}

export interface WSGetGitStatusMessage {
  type: "get_git_status";
  projectPath: string;
  projectId: string;
  nodeId?: string;
}

export interface WSGetGitDiffMessage {
  type: "get_git_diff";
  projectPath: string;
  filePath: string;
  staged: boolean;
  nodeId?: string;
}

export interface WSGetFileTreeMessage {
  type: "get_file_tree";
  projectPath: string;
  projectId: string;
  nodeId?: string;
}

export interface WSGetFileContentMessage {
  type: "get_file_content";
  projectPath: string;
  filePath: string;
  nodeId?: string;
}

export type WSBrowserMessage =
  | WSChatMessage
  | WSCreateSessionMessage
  | WSStopSessionMessage
  | WSDeleteSessionMessage
  | WSListSessionsMessage
  | WSCreateProjectMessage
  | WSDeleteProjectMessage
  | WSListProjectsMessage
  | WSSelectNodeMessage
  | WSListNodesMessage
  | WSAuthNodeMessage
  | WSRetryWithPermissionMessage
  | WSChangePermissionModeMessage
  | WSGetGitStatusMessage
  | WSGetGitDiffMessage
  | WSGetFileTreeMessage
  | WSGetFileContentMessage;

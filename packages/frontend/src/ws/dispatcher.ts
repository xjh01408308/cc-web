// WebSocket 消息分发器。
//
// 把原 ChatView.handleRawMessage 里 ~335 行的 if 链抽成对 BrowserEvent union 的
// 穷尽分发。行为与原实现逐行等价（重构时以 git show HEAD:.../ChatView.tsx 对照）。
//
// state 归属重构（拆 custom hooks）留给后续 T-B —— 本文件只负责路由层抽出 +
// 行为锁定。DispatchContext 字段多是 god component 的本质，T-A 不解决。

import type { Dispatch, SetStateAction, MutableRefObject } from "react";
import type {
  BrowserEvent,
  AllMessage,
  ChatMessage,
  SessionInfo,
  ProjectInfo,
  NodeInfo,
  GitStatusResult,
  FileTreeNode,
} from "../types";
import { BrowserEventType } from "../types";
import type { StreamingContext } from "../hooks/streaming/useStreamParser";
import { UnifiedMessageProcessor } from "../utils/UnifiedMessageProcessor";
import { dedupConsecutiveAssistant } from "../utils/dedupMessages";
import { loadLastView, removeNodePassword } from "../utils/localStorage";

// ---- 进度统计 / 浏览态形状（与 ChatView 内联类型对齐；T-B 时提取共享）----

export interface TaskProgress {
  description: string;
  totalTokens: number;
  toolUses: number;
  durationMs: number;
  lastToolName: string;
}

export interface PermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  contextWindow: number;
  compactionVersion: number;
}

export interface DiffState {
  filePath: string;
  projectPath: string;
  staged: boolean;
  diff: string;
}

export interface FileViewState {
  filePath: string;
  projectPath: string;
  content: string;
  mimeType: "markdown" | "html" | "code" | "text" | "binary";
  language?: string;
}

// ---- dispatcher 所需的全部外部依赖（原 handleRawMessage 闭包捕获）----

export interface DispatchContext {
  // 当前选中节点 / 会话（nodeId 过滤 + auto-select 用）
  activeNodeId: string | null;
  activeSessionId: string | null;

  // 流式处理器及其输入
  processStreamLine: (line: string, ctx: StreamingContext) => void;
  hasReceivedInit: boolean;

  // 跨消息可变 ref
  currentAssistantMessageRef: MutableRefObject<ChatMessage | null>;
  pendingSessionRef: MutableRefObject<string | null>;
  creatingNewSessionRef: MutableRefObject<boolean>;
  autoAuthTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;

  // 节点 / 认证 setter
  setNodes: Dispatch<SetStateAction<NodeInfo[]>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;
  setAuthenticatedNodes: Dispatch<SetStateAction<Set<string>>>;
  setPendingAuthNodeId: Dispatch<SetStateAction<string | null>>;
  setAuthError: Dispatch<SetStateAction<string | null>>;
  setAutoAuthInProgress: Dispatch<SetStateAction<boolean>>;

  // 项目 / 会话 setter
  setProjects: Dispatch<SetStateAction<ProjectInfo[]>>;
  setSessions: Dispatch<SetStateAction<SessionInfo[]>>;
  setActiveSessionId: Dispatch<SetStateAction<string | null>>;
  setActiveProjectId: Dispatch<SetStateAction<string | null>>;
  setMessages: Dispatch<SetStateAction<AllMessage[]>>;

  // 模型 / 权限 / 进度 setter
  setModel: Dispatch<SetStateAction<string>>;
  setPermissionMode: Dispatch<SetStateAction<string>>;
  setHasReceivedInit: Dispatch<SetStateAction<boolean>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setTaskProgress: Dispatch<SetStateAction<TaskProgress | null>>;
  setPermissionDenials: Dispatch<SetStateAction<PermissionDenial[] | null>>;
  setTokenUsage: Dispatch<SetStateAction<TokenUsage | null>>;

  // git / file 浏览 setter
  setGitStatuses: Dispatch<SetStateAction<Map<string, GitStatusResult>>>;
  setDiffState: Dispatch<SetStateAction<DiffState | null>>;
  setFileTrees: Dispatch<SetStateAction<Map<string, FileTreeNode[]>>>;
  setFileTreeErrors: Dispatch<SetStateAction<Map<string, string>>>;
  setFileTreeLoading: Dispatch<SetStateAction<Set<string>>>;
  setFileViewState: Dispatch<SetStateAction<FileViewState | null>>;
}

// ---- per-type 事件窄化别名 ----

type NodesListEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.NodesList }>;
type AuthResultEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.AuthResult }>;
type AuthRequiredEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.AuthRequired }>;
type ProjectsListEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.ProjectsList }>;
type ProjectInfoEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.ProjectInfo }>;
type SessionInfoEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.SessionInfo }>;
type SessionsListEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.SessionsList }>;
type GitStatusEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.GitStatus }>;
type GitDiffEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.GitDiff }>;
type FileTreeEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.FileTree }>;
type FileContentEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.FileContent }>;
type StreamingEvent = Extract<
  BrowserEvent,
  {
    type:
      | typeof BrowserEventType.ClaudeJson
      | typeof BrowserEventType.Error
      | typeof BrowserEventType.Done
      | typeof BrowserEventType.Aborted;
  }
>;

// 早期处理类：在 nodeId 过滤之前处理（不附带业务 nodeId，或语义上属于全局）。
// 与原 handleRawMessage 一致：NodesList / AuthResult / AuthRequired 在 nodeId 过滤分支之前。
const EARLY_TYPES: ReadonlySet<BrowserEvent["type"]> = new Set([
  BrowserEventType.NodesList,
  BrowserEventType.AuthResult,
  BrowserEventType.AuthRequired,
]);

/** 附带 nodeId 且与当前选中节点不匹配时跳过。activeNodeId 为 null 时不过滤（全收）。 */
function shouldSkipByNodeId(event: BrowserEvent, activeNodeId: string | null): boolean {
  if (!activeNodeId) return false;
  if (!("nodeId" in event)) return false;
  const nodeId = (event as { nodeId?: string }).nodeId;
  return !!nodeId && nodeId !== activeNodeId;
}

/**
 * 处理一条已解析的 BrowserEvent。
 *
 * 行为与原 ChatView.handleRawMessage 的 for-loop body 逐分支等价：
 *   1. 早期处理 NodesList / AuthResult / AuthRequired（不经 nodeId 过滤）
 *   2. nodeId 过滤（附带 nodeId 且 ≠ activeNodeId → 跳过）
 *   3. 其余 type 穷尽分发
 *
 * 多行 raw 的拆分 / JSON.parse 仍由调用方负责（本函数只处理单条 event）。
 */
export function dispatchBrowserEvent(event: BrowserEvent, ctx: DispatchContext): void {
  if (!EARLY_TYPES.has(event.type) && shouldSkipByNodeId(event, ctx.activeNodeId)) {
    return;
  }

  switch (event.type) {
    case BrowserEventType.NodesList:
      handleNodesList(event, ctx);
      return;
    case BrowserEventType.AuthResult:
      handleAuthResult(event, ctx);
      return;
    case BrowserEventType.AuthRequired:
      handleAuthRequired(event, ctx);
      return;
    case BrowserEventType.ProjectsList:
      handleProjectsList(event, ctx);
      return;
    case BrowserEventType.ProjectInfo:
      handleProjectInfo(event, ctx);
      return;
    case BrowserEventType.SessionInfo:
      handleSessionInfo(event, ctx);
      return;
    case BrowserEventType.SessionsList:
      handleSessionsList(event, ctx);
      return;
    case BrowserEventType.GitStatus:
      handleGitStatus(event, ctx);
      return;
    case BrowserEventType.GitDiff:
      handleGitDiff(event, ctx);
      return;
    case BrowserEventType.FileTree:
      handleFileTree(event, ctx);
      return;
    case BrowserEventType.FileContent:
      handleFileContent(event, ctx);
      return;
    case BrowserEventType.SessionEnd:
      handleSessionEnd(ctx);
      return;
    case BrowserEventType.ClaudeJson:
    case BrowserEventType.Error:
    case BrowserEventType.Done:
    case BrowserEventType.Aborted:
      handleStreaming(event, ctx);
      return;
    case BrowserEventType.NodeSelected:
      // relay 内部消费，不转发到浏览器；防御性 no-op
      return;
    default: {
      // 穷尽性检查：BrowserEventType 加新成员时此行 tsc 报错（never 不接受新类型）
      const _exhaustive: never = event;
      throw new Error(`Unhandled BrowserEvent: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function handleNodesList(event: NodesListEvent, ctx: DispatchContext): void {
  if (!event.nodes) return;
  const nodeList = event.nodes;
  ctx.setNodes(nodeList);
  // 只有一个节点时自动选中；当前选中节点不在线时清空
  if (nodeList.length === 1) {
    ctx.setActiveNodeId((prev) => prev || nodeList[0].nodeId);
  } else if (nodeList.length === 0) {
    ctx.setActiveNodeId(null);
  }
}

function handleAuthResult(event: AuthResultEvent, ctx: DispatchContext): void {
  const resultNodeId = event.nodeId;
  if (event.success) {
    ctx.setAuthenticatedNodes((prev) => {
      const next = new Set(prev);
      next.add(resultNodeId);
      return next;
    });
    ctx.setPendingAuthNodeId(null);
    ctx.setAuthError(null);
    ctx.setAutoAuthInProgress(false);
    if (ctx.autoAuthTimeoutRef.current) {
      clearTimeout(ctx.autoAuthTimeoutRef.current);
      ctx.autoAuthTimeoutRef.current = null;
    }
    // 确保 pendingSessionRef 已设置（初始加载自动认证时）
    if (!ctx.pendingSessionRef.current) {
      const saved = loadLastView();
      if (saved?.sessionId && saved.nodeId === resultNodeId) {
        ctx.pendingSessionRef.current = saved.sessionId;
      }
    }
  } else {
    removeNodePassword(resultNodeId);
    ctx.setAutoAuthInProgress(false);
    if (ctx.autoAuthTimeoutRef.current) {
      clearTimeout(ctx.autoAuthTimeoutRef.current);
      ctx.autoAuthTimeoutRef.current = null;
    }
    ctx.setAuthError(event.error || "认证失败");
  }
}

function handleAuthRequired(event: AuthRequiredEvent, ctx: DispatchContext): void {
  if (!event.nodeId) return;
  ctx.setPendingAuthNodeId(event.nodeId);
  ctx.setIsLoading(false);
  ctx.setTaskProgress(null);
}

function handleProjectsList(event: ProjectsListEvent, ctx: DispatchContext): void {
  if (!event.projects) return;
  ctx.setProjects(event.projects);
}

function handleProjectInfo(event: ProjectInfoEvent, ctx: DispatchContext): void {
  if (!event.project) return;
  const project = event.project;
  ctx.setProjects((prev) => {
    const idx = prev.findIndex((p) => p.projectId === project.projectId);
    if (idx >= 0) {
      const updated = [...prev];
      updated[idx] = project;
      return updated;
    }
    return [...prev, project];
  });
}

function handleSessionInfo(event: SessionInfoEvent, ctx: DispatchContext): void {
  const info: SessionInfo = {
    sessionId: event.sessionId || "",
    projectId: event.projectId || "",
    projectPath: event.projectPath || "",
    model: event.model || undefined,
    permissionMode: event.permissionMode || undefined,
    summary: event.summary || "",
    status: event.status || "running",
    messageCount: event.messageCount || 0,
    createdAt: event.createdAt || Date.now(),
  };
  ctx.setSessions((prev) => {
    const idx = prev.findIndex((s) => s.sessionId === info.sessionId);
    if (idx >= 0) {
      const updated = [...prev];
      updated[idx] = info;
      return updated;
    }
    return [...prev, info];
  });
  if (ctx.creatingNewSessionRef.current) {
    // 新建会话成功，默认选中该会话
    ctx.creatingNewSessionRef.current = false;
    ctx.setActiveSessionId(info.sessionId);
    ctx.setActiveProjectId(info.projectId);
    ctx.pendingSessionRef.current = info.sessionId;
    ctx.setMessages([]);
    ctx.setHasReceivedInit(false);
    ctx.setTokenUsage(null);
    ctx.setModel("");
    ctx.setPermissionDenials(null);
    ctx.setTaskProgress(null);
  } else if (!ctx.activeSessionId && !ctx.pendingSessionRef.current) {
    ctx.setActiveSessionId(info.sessionId);
    ctx.setActiveProjectId(info.projectId);
    ctx.pendingSessionRef.current = info.sessionId;
  }
  if (event.model) ctx.setModel(event.model);
  if (event.permissionMode) ctx.setPermissionMode(event.permissionMode);
}

function handleSessionsList(event: SessionsListEvent, ctx: DispatchContext): void {
  if (!event.sessions) return;
  ctx.setSessions(event.sessions);
  // 如果有待加载的会话，将其历史消息加载到聊天视图
  const pendingId = ctx.pendingSessionRef.current;
  if (!pendingId) return;
  const target = event.sessions.find((s) => s.sessionId === pendingId);
  if (!target) return;
  // 恢复活跃会话状态（HTTP 认证失败时通过 WebSocket 恢复）
  if (!ctx.activeSessionId) {
    ctx.setActiveSessionId(target.sessionId);
    ctx.setActiveProjectId(target.projectId);
    if (target.model) ctx.setModel(target.model);
    if (target.permissionMode) ctx.setPermissionMode(target.permissionMode);
  }
  if (target.messages && target.messages.length > 0) {
    const msgs = target.messages as unknown as Record<string, unknown>[];
    const historyProcessor = new UnifiedMessageProcessor();
    const created = target.createdAt || Date.now();
    // 提取 claude_json 类型的消息，取 .data 作为 SDKMessage，附上 timestamp
    const timestamped = msgs
      .filter((m) => m.type === "claude_json" && m.data)
      .map((m, i) => ({
        ...(m.data as Record<string, unknown>),
        timestamp: new Date(created + i).toISOString(),
      }));
    if (timestamped.length > 0) {
      const processed = historyProcessor.processMessagesBatch(
        timestamped as Parameters<typeof historyProcessor.processMessagesBatch>[0],
      );
      ctx.setMessages(dedupConsecutiveAssistant(processed));
    }
    ctx.setHasReceivedInit(true);
  }
}

function handleGitStatus(event: GitStatusEvent, ctx: DispatchContext): void {
  if (!event.gitStatus) return;
  const status = event.gitStatus;
  ctx.setGitStatuses((prev) => {
    const next = new Map(prev);
    next.set(status.projectId, status);
    return next;
  });
}

function handleGitDiff(event: GitDiffEvent, ctx: DispatchContext): void {
  if (!event.diffResult) return;
  const dr = event.diffResult;
  if (!dr.error) {
    ctx.setDiffState({
      filePath: dr.filePath,
      projectPath: dr.projectPath,
      staged: event.staged ?? false,
      diff: dr.diff,
    });
  }
}

function handleFileTree(event: FileTreeEvent, ctx: DispatchContext): void {
  if (!event.fileTreeResult) return;
  const result = event.fileTreeResult;
  ctx.setFileTreeLoading((prev) => {
    const next = new Set(prev);
    next.delete(result.projectId);
    return next;
  });
  if (result.error) {
    ctx.setFileTreeErrors((prev) => {
      const next = new Map(prev);
      next.set(result.projectId, result.error!);
      return next;
    });
  } else {
    ctx.setFileTrees((prev) => {
      const next = new Map(prev);
      next.set(result.projectId, result.tree);
      return next;
    });
    ctx.setFileTreeErrors((prev) => {
      const next = new Map(prev);
      next.delete(result.projectId);
      return next;
    });
  }
}

function handleFileContent(event: FileContentEvent, ctx: DispatchContext): void {
  if (!event.fileContentResult) return;
  const r = event.fileContentResult;
  if (!r.error) {
    ctx.setFileViewState({
      filePath: r.filePath,
      projectPath: r.projectPath,
      content: r.content,
      mimeType: r.mimeType,
      language: r.language,
    });
  }
}

function handleSessionEnd(ctx: DispatchContext): void {
  ctx.setIsLoading(false);
  ctx.currentAssistantMessageRef.current = null;
}

function handleStreaming(event: StreamingEvent, ctx: DispatchContext): void {
  // 刷新后正在运行的会话继续发送流式消息，自动恢复 activeSessionId
  const streamSid = event.sessionId;
  if (streamSid && !ctx.activeSessionId) {
    ctx.setActiveSessionId(streamSid);
  }

  const streamingContext: StreamingContext = {
    currentAssistantMessage: ctx.currentAssistantMessageRef.current,
    setCurrentAssistantMessage: (msg) => {
      ctx.currentAssistantMessageRef.current = msg;
    },
    addMessage: (msg) => {
      ctx.setMessages((prev) => [...prev, msg]);
    },
    updateLastMessage: (content) => {
      ctx.setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last && last.type === "chat" && last.role === "assistant") {
          updated[updated.length - 1] = { ...last, content };
        }
        return updated;
      });
    },
    onSessionId: (_sid) => {},
    hasReceivedInit: ctx.hasReceivedInit,
    setHasReceivedInit: ctx.setHasReceivedInit,
    shouldShowInitMessage: () => !ctx.hasReceivedInit,
    onModel: (m) => ctx.setModel(m),
    onTaskProgress: (p) => ctx.setTaskProgress(p),
    onPermissionDenied: (denials) => {
      ctx.setPermissionDenials(denials);
    },
    onTokenUsage: (u) =>
      ctx.setTokenUsage((prev) => ({
        ...u,
        compactionVersion: prev?.compactionVersion ?? 0,
      })),
  };

  ctx.processStreamLine(JSON.stringify(event), streamingContext);

  if (event.type === BrowserEventType.ClaudeJson && event.data) {
    const sdkMsg = event.data as Record<string, unknown>;
    if (sdkMsg.type === "system" && sdkMsg.subtype === "init" && sdkMsg.model) {
      ctx.setModel(String(sdkMsg.model));
    }
    // compact_boundary 给出 compact 前的真实上下文 token 数，用于校准进度条
    if (sdkMsg.type === "system" && sdkMsg.subtype === "compact_boundary") {
      const meta = sdkMsg.compact_metadata as Record<string, unknown> | undefined;
      if (meta?.pre_tokens) {
        const preTokens = Number(meta.pre_tokens);
        ctx.setTokenUsage((prev) =>
          prev
            ? {
                ...prev,
                inputTokens: preTokens,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                compactionVersion: (prev.compactionVersion ?? 0) + 1,
              }
            : null,
        );
      }
    }
  }

  if (
    event.type === BrowserEventType.Done ||
    event.type === BrowserEventType.Error ||
    event.type === BrowserEventType.Aborted
  ) {
    ctx.setIsLoading(false);
    ctx.setTaskProgress(null);
    ctx.currentAssistantMessageRef.current = null;
  }
}

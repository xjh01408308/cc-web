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
  BrowserCommand,
  AllMessage,
  ChatMessage,
  SessionInfo,
  ProjectInfo,
  NodeInfo,
  GitStatusResult,
  FileTreeNode,
} from "../types";
import { BrowserEventType, BrowserCommandType } from "../types";
import type { StreamingContext } from "../hooks/streaming/useStreamParser";
import { UnifiedMessageProcessor } from "../utils/UnifiedMessageProcessor";
import { dedupConsecutiveAssistant } from "../utils/dedupMessages";

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

  // 节点 setter
  setNodes: Dispatch<SetStateAction<NodeInfo[]>>;
  setActiveNodeId: Dispatch<SetStateAction<string | null>>;

  // 项目 / 会话 setter
  setProjects: Dispatch<SetStateAction<ProjectInfo[]>>;
  setSessions: Dispatch<SetStateAction<SessionInfo[]>>;
  setActiveSessionId: Dispatch<SetStateAction<string | null>>;
  setActiveProjectId: Dispatch<SetStateAction<string | null>>;
  setMessages: Dispatch<SetStateAction<AllMessage[]>>;

  // 历史分页加载（点击会话逐步刷新；dispatcher 据 hasMore 自动续拉更早的历史）
  send: (cmd: BrowserCommand) => void;
  setIsHistoryLoading: Dispatch<SetStateAction<boolean>>;
  rawHistoryBufferRef: MutableRefObject<Record<string, unknown>[]>;

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
type ProjectsListEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.ProjectsList }>;
type ProjectInfoEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.ProjectInfo }>;
type SessionInfoEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.SessionInfo }>;
type SessionsListEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.SessionsList }>;
type GitStatusEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.GitStatus }>;
type GitDiffEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.GitDiff }>;
type FileTreeEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.FileTree }>;
type FileContentEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.FileContent }>;
type HistoryEvent = Extract<BrowserEvent, { type: typeof BrowserEventType.History }>;
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
// 与原 handleRawMessage 一致：NodesList 在 nodeId 过滤分支之前。
const EARLY_TYPES: ReadonlySet<BrowserEvent["type"]> = new Set([
  BrowserEventType.NodesList,
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
 *   1. 早期处理 NodesList（不经 nodeId 过滤）
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
    case BrowserEventType.History:
      handleHistory(event, ctx);
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
  // 列表现在只回元数据（无 messages）——历史消息由 get_history 的 History 事件按需恢复。
  // 仅保留 WS 恢复活跃会话的兜底：HTTP 认证失败时靠 WS 列表把 pending 会话选中。
  const pendingId = ctx.pendingSessionRef.current;
  if (!pendingId) return;
  const target = event.sessions.find((s) => s.sessionId === pendingId);
  if (!target) return;
  if (!ctx.activeSessionId) {
    ctx.setActiveSessionId(target.sessionId);
    ctx.setActiveProjectId(target.projectId);
  }
}

function handleHistory(event: HistoryEvent, ctx: DispatchContext): void {
  // 仅恢复当前活跃会话（或 pending）的历史——快速连点切换时，
  // 旧请求的 History 响应 sessionId ≠ 当前活跃会话，直接丢弃避免覆盖。
  const sid = event.sessionId;
  if (sid !== ctx.activeSessionId && sid !== ctx.pendingSessionRef.current) return;
  // 首页才回填 model/permissionMode（续页不带，前端已持有）。
  if (event.model) ctx.setModel(event.model);
  if (event.permissionMode) ctx.setPermissionMode(event.permissionMode);

  // 分页：新页是更早的历史 → 提取后 prepend 到缓冲区（正序 最早..最近）。
  // 直接用 SDKMessage 自带的 timestamp（真实历史时间）；processMessagesBatch 据此转毫秒。
  // 早期用 Date.now()+i 伪造 timestamp，导致历史消息显示成"当前时间"。
  const pageMsgs = (event.messages as unknown as Record<string, unknown>[]) ?? [];
  const pageTimestamped = pageMsgs
    .filter((m) => m.type === "claude_json" && m.data)
    .map((m) => m.data as Record<string, unknown>);
  ctx.rawHistoryBufferRef.current = [...pageTimestamped, ...ctx.rawHistoryBufferRef.current];

  // 整体重跑正序全量：processor 每次 new，toolUseCache 在单 batch 内正确，
  // 避免「从最近往前」增量喂入导致 tool_use↔tool_result 跨页关联断裂。
  if (ctx.rawHistoryBufferRef.current.length > 0) {
    const processor = new UnifiedMessageProcessor();
    const processed = processor.processMessagesBatch(
      ctx.rawHistoryBufferRef.current as Parameters<typeof processor.processMessagesBatch>[0],
    );
    ctx.setMessages(dedupConsecutiveAssistant(processed));
    ctx.setHasReceivedInit(true);
  }
  // buffer 空（空会话 / 本页全非 claude_json）→ 不调 setMessages，保持现状
  // （切会话时 resetForSessionChange 已清空 messages）。

  // 自动续拉更早的历史；hasMore=false（或旧协议无分页字段）时停止并关闭加载指示。
  if (event.hasMore && event.nextBefore != null) {
    ctx.send({
      type: BrowserCommandType.GetHistory,
      sessionId: sid,
      nodeId: ctx.activeNodeId || undefined,
      before: event.nextBefore,
    });
  } else {
    ctx.setIsHistoryLoading(false);
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

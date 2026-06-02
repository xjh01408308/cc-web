import { useState, useCallback, useEffect, useRef } from "react";
import type { AllMessage, ChatMessage, SessionInfo, ProjectInfo, NodeInfo, GitStatusResult, GitDiffResult, FileTreeNode, FileTreeResult, FileContentResult } from "../types";
import { useWebSocket } from "../hooks/useWebSocket";
import { useClaudeStreaming } from "../hooks/useClaudeStreaming";
import type { StreamingContext } from "../hooks/streaming/useMessageProcessor";
import { UnifiedMessageProcessor } from "../utils/UnifiedMessageProcessor";
import { ProjectSidebar } from "./ProjectSidebar";
import { ChatMessages } from "./ChatMessages";
import { ChatInput } from "./ChatInput";
import { StatusBar } from "./StatusBar";
import { ModelPicker } from "./ModelPicker";
import { PermissionDialog } from "./PermissionDialog";
import { GitDiffModal } from "./GitDiffModal";
import { FileViewerModal } from "./FileViewerModal";

// 去重：result 消息的文本与它前面的 assistant 消息相同，批量加载时会产生重复
function dedupConsecutiveAssistant(messages: AllMessage[]): AllMessage[] {
  const result: AllMessage[] = [];
  for (const msg of messages) {
    if (msg.type === 'chat' && msg.role === 'assistant') {
      const prev = result[result.length - 1];
      if (prev && prev.type === 'chat' && prev.role === 'assistant' && prev.content === msg.content) {
        continue;
      }
    }
    result.push(msg);
  }
  return result;
}

const KNOWN_MODELS = [
  { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
];

const PERMISSION_MODES = [
  { mode: "default", label: "只读", shortLabel: "读" },
  { mode: "acceptEdits", label: "读写", shortLabel: "写" },
  { mode: "bypassPermissions", label: "全权限", shortLabel: "全" },
] as const;

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 640);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return isMobile;
}

export function ChatView() {
  // ---- 登录状态 ----
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);

  const { connected, send, onRawMessage } = useWebSocket(sessionToken);
  const { processStreamLine } = useClaudeStreaming();

  const authFetch = useCallback((url: string) => {
    return fetch(url, { headers: { 'Authorization': `Bearer ${sessionToken!}` } });
  }, [sessionToken]);

  // 自动登录（开发模式下 relay 无密码时）
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "" }),
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.token) setSessionToken(data.token);
        }
      } catch { /* 登录失败不处理，用户手动登录 */ }
    })();
  }, []);

  const handleLogin = useCallback(async () => {
    setLoginLoading(true);
    setLoginError(null);
    try {
      const resp = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: loginPassword }),
      });
      if (resp.ok) {
        const data = await resp.json();
        setSessionToken(data.token);
      } else {
        const data = await resp.json();
        setLoginError(data.error || "登录失败");
      }
    } catch {
      setLoginError("网络错误");
    } finally {
      setLoginLoading(false);
    }
  }, [loginPassword]);

  const handleLogout = useCallback(() => {
    setSessionToken(null);
  }, []);

  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AllMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [model, setModel] = useState("");
  const [hasReceivedInit, setHasReceivedInit] = useState(false);
  const [permissionMode, setPermissionMode] = useState<string>("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [taskProgress, setTaskProgress] = useState<{
    description: string;
    totalTokens: number;
    toolUses: number;
    durationMs: number;
    lastToolName: string;
  } | null>(null);
  const [permissionDenials, setPermissionDenials] = useState<
    Array<{ tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }> | null
  >(null);
  const [tokenUsage, setTokenUsage] = useState<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUSD: number;
    contextWindow: number;
    compactionVersion: number;
  } | null>(null);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [authenticatedNodes, setAuthenticatedNodes] = useState<Set<string>>(new Set());
  const [pendingAuthNodeId, setPendingAuthNodeId] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [autoAuthInProgress, setAutoAuthInProgress] = useState(false);
  const [gitStatuses, setGitStatuses] = useState<Map<string, GitStatusResult>>(new Map());
  const [diffState, setDiffState] = useState<{ filePath: string; projectPath: string; staged: boolean; diff: string } | null>(null);
  const [fileTrees, setFileTrees] = useState<Map<string, FileTreeNode[]>>(new Map());
  const [fileTreeErrors, setFileTreeErrors] = useState<Map<string, string>>(new Map());
  const [fileTreeLoading, setFileTreeLoading] = useState<Set<string>>(new Set());
  const [fileViewState, setFileViewState] = useState<{
    filePath: string;
    projectPath: string;
    content: string;
    mimeType: "markdown" | "html" | "code" | "text" | "binary";
    language?: string;
  } | null>(null);

  const currentAssistantMessageRef = useRef<ChatMessage | null>(null);
  const initialLoadDone = useRef(false);
  const pendingSessionRef = useRef<string | null>(null);
  const handleRawMessageRef = useRef<((raw: string) => void) | null>(null);
  const restoredRef = useRef(false);
  const autoAuthTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  // 持久化最后浏览状态（含 projectPath，避免重启后路径依赖 process.cwd()）
  const LAST_VIEW_KEY = "cc-web-last-view";
  const saveLastView = (nodeId: string, projectId?: string | null, sessionId?: string | null, projectPath?: string | null, projectName?: string | null) => {
    try {
      localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({
        nodeId,
        projectId: projectId || undefined,
        sessionId: sessionId || undefined,
        projectPath: projectPath || undefined,
        projectName: projectName || undefined,
      }));
    } catch { /* localStorage 不可用 */ }
  };
  const loadLastView = (): { nodeId?: string; projectId?: string; sessionId?: string; projectPath?: string; projectName?: string } | null => {
    try {
      const raw = localStorage.getItem(LAST_VIEW_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  };

  const NODE_PASSWORDS_KEY = "cc-web-node-passwords";
  const loadNodePasswords = (): Record<string, string> => {
    try {
      const raw = localStorage.getItem(NODE_PASSWORDS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  };
  const saveNodePassword = (nodeId: string, password: string) => {
    try {
      const passwords = loadNodePasswords();
      passwords[nodeId] = password;
      localStorage.setItem(NODE_PASSWORDS_KEY, JSON.stringify(passwords));
    } catch {}
  };
  const removeNodePassword = (nodeId: string) => {
    try {
      const passwords = loadNodePasswords();
      delete passwords[nodeId];
      localStorage.setItem(NODE_PASSWORDS_KEY, JSON.stringify(passwords));
    } catch {}
  };
  const loadNodePassword = (nodeId: string): string | null => {
    return loadNodePasswords()[nodeId] || null;
  };

  // 初始加载节点列表和项目列表（通过 HTTP，可靠）
  useEffect(() => {
    if (!sessionToken || initialLoadDone.current) return;
    initialLoadDone.current = true;

    const saved = loadLastView();

    authFetch("/api/nodes")
      .then((r) => r.json())
      .then((data: NodeInfo[]) => {
        setNodes(data);

        // 恢复上次的节点（如果还在线），否则单节点时自动选中
        const restoreNodeId = saved?.nodeId && data.some((n) => n.nodeId === saved.nodeId)
          ? saved.nodeId
          : data.length === 1
            ? data[0].nodeId
            : null;

        if (restoreNodeId) {
          setActiveNodeId(restoreNodeId);
          restoredRef.current = true;
          pendingSessionRef.current = saved?.sessionId || null;

          // 加载该节点的项目和会话
          authFetch(`/api/projects?nodeId=${encodeURIComponent(restoreNodeId)}`)
            .then((r) => r.json())
            .then((projData) => {
              if ((projData as { error?: string }).error === 'auth_required') {
                setPendingAuthNodeId(restoreNodeId);
                return;
              }
              setProjects(projData as ProjectInfo[]);
            })
            .catch(() => {});
          authFetch(`/api/sessions?nodeId=${encodeURIComponent(restoreNodeId)}`)
            .then((r) => r.json())
            .then((sessData: SessionInfo[] | { error?: string }) => {
              if ('error' in sessData && sessData.error === 'auth_required') {
                setPendingAuthNodeId(restoreNodeId);
                return;
              }
              const sessions = sessData as SessionInfo[];
              setSessions(sessions);
              // 恢复上次的会话（含历史消息）
              pendingSessionRef.current = null;
              if (saved?.sessionId) {
                const target = sessions.find((s) => s.sessionId === saved.sessionId);
                if (target) {
                  setActiveSessionId(target.sessionId);
                  setActiveProjectId(target.projectId);
                  if (target.model) setModel(target.model);
                  if (target.permissionMode) setPermissionMode(target.permissionMode);
                  // 加载历史消息
                  if (target.messages && target.messages.length > 0) {
                    const msgs = target.messages as unknown as Record<string, unknown>[];
                    const historyProcessor = new UnifiedMessageProcessor();
                    const created = target.createdAt || Date.now();
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
                      setMessages(dedupConsecutiveAssistant(processed));
                    }
                    setHasReceivedInit(true);
                  }
                }
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {});

    // 没有恢复节点时才用默认请求（无 nodeId = 取第一个在线节点）
    if (!saved?.nodeId) {
      authFetch("/api/projects")
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((data: ProjectInfo[]) => {
          if (!restoredRef.current) setProjects(data);
        })
        .catch(() => {});
      authFetch("/api/sessions")
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((data: SessionInfo[]) => {
          if (!restoredRef.current) setSessions(data);
        })
        .catch(() => {});
    }
  }, [sessionToken, authFetch]);

  // 持久化当前浏览状态
  useEffect(() => {
    if (activeNodeId) {
      const session = sessions.find(s => s.sessionId === activeSessionId);
      const project = activeProjectId ? projects.find(p => p.projectId === activeProjectId) : null;
      saveLastView(activeNodeId, activeProjectId, activeSessionId,
        session?.projectPath || project?.path,
        project?.name);
    }
  }, [activeNodeId, activeProjectId, activeSessionId, sessions, projects]);

  // 当节点需要认证且 WebSocket 已连接时，尝试用本地保存的密码自动认证
  useEffect(() => {
    if (pendingAuthNodeId && connected && !autoAuthInProgress && !authenticatedNodes.has(pendingAuthNodeId)) {
      const savedPassword = loadNodePassword(pendingAuthNodeId);
      if (savedPassword) {
        if (autoAuthTimeoutRef.current) clearTimeout(autoAuthTimeoutRef.current);
        setAutoAuthInProgress(true);
        setAuthError(null);
        send({ type: 'auth_node', nodeId: pendingAuthNodeId, password: savedPassword });
        autoAuthTimeoutRef.current = setTimeout(() => {
          setAutoAuthInProgress(false);
          autoAuthTimeoutRef.current = null;
        }, 5000);
      }
    }
    return () => {
      if (autoAuthTimeoutRef.current) {
        clearTimeout(autoAuthTimeoutRef.current);
        autoAuthTimeoutRef.current = null;
      }
    };
  }, [pendingAuthNodeId, connected, autoAuthInProgress, send, authenticatedNodes]);

  // 节点认证成功后加载项目和会话（仅当 HTTP 未返回数据时通过 WS 补充加载）
  // 不用 loadedNodesRef 防重 —— 因为 send() 在 WS 未 OPEN 时会静默丢弃，
  // 如果首次被丢弃，后续重连必须能重新请求。用 projects/sessions 是否为空来判断是否需要加载。
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const loadRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRetryCountRef = useRef(0);

  useEffect(() => {
    if (activeNodeId && authenticatedNodes.has(activeNodeId) && connected) {
      // 确保 pendingSessionRef 已设置（初始加载自动认证时）
      if (!pendingSessionRef.current) {
        const saved = loadLastView();
        if (saved?.sessionId && saved.nodeId === activeNodeId) {
          pendingSessionRef.current = saved.sessionId;
        }
      }

      const needProjects = projectsRef.current.length === 0;
      const needSessions = sessionsRef.current.length === 0;

      if (needProjects || needSessions) {
        if (needProjects) send({ type: "list_projects", nodeId: activeNodeId });
        if (needSessions) send({ type: "list_sessions", nodeId: activeNodeId });

        // 2 秒后如果数据还没到就重试，最多 3 次
        loadRetryCountRef.current = 0;
        const doRetry = () => {
          if (loadRetryCountRef.current >= 3) return;
          const stillNeedProjects = projectsRef.current.length === 0;
          const stillNeedSessions = sessionsRef.current.length === 0;
          if (!stillNeedProjects && !stillNeedSessions) return;
          loadRetryCountRef.current++;
          if (stillNeedProjects) send({ type: "list_projects", nodeId: activeNodeId });
          if (stillNeedSessions) send({ type: "list_sessions", nodeId: activeNodeId });
          loadRetryRef.current = setTimeout(doRetry, 2000);
        };
        loadRetryRef.current = setTimeout(doRetry, 2000);
      }
    }
    return () => {
      if (loadRetryRef.current) {
        clearTimeout(loadRetryRef.current);
        loadRetryRef.current = null;
      }
    };
  }, [activeNodeId, authenticatedNodes, connected, send]);

  // 处理一条 WebSocket 原始消息
  const handleRawMessage = useCallback(
    (raw: string) => {
      const lines = raw.split("\n").filter((line) => line.trim());

      for (const line of lines) {
        try {
          const data = JSON.parse(line);

          // 节点列表更新
          if (data.type === "nodes_list" && data.nodes) {
            const nodeList = data.nodes as NodeInfo[];
            setNodes(nodeList);
            // 只有一个节点时自动选中；当前选中节点不在线时清空
            if (nodeList.length === 1) {
              setActiveNodeId((prev) => prev || nodeList[0].nodeId);
            } else if (nodeList.length === 0) {
              setActiveNodeId(null);
            }
            continue;
          }

          // 认证结果
          if (data.type === "auth_result") {
            const resultNodeId = data.nodeId as string;
            if (data.success) {
              setAuthenticatedNodes((prev) => {
                const next = new Set(prev);
                next.add(resultNodeId);
                return next;
              });
              setPendingAuthNodeId(null);
              setAuthError(null);
              setAutoAuthInProgress(false);
              if (autoAuthTimeoutRef.current) {
                clearTimeout(autoAuthTimeoutRef.current);
                autoAuthTimeoutRef.current = null;
              }
              // 确保 pendingSessionRef 已设置（初始加载自动认证时）
              if (!pendingSessionRef.current) {
                const saved = loadLastView();
                if (saved?.sessionId && saved.nodeId === resultNodeId) {
                  pendingSessionRef.current = saved.sessionId;
                }
              }
            } else {
              removeNodePassword(resultNodeId);
              setAutoAuthInProgress(false);
              if (autoAuthTimeoutRef.current) {
                clearTimeout(autoAuthTimeoutRef.current);
                autoAuthTimeoutRef.current = null;
              }
              setAuthError((data.error as string) || "认证失败");
            }
            continue;
          }

          // 按 nodeId 过滤：消息附带 nodeId 且与当前选中节点不匹配时跳过
          if (data.nodeId && activeNodeId && data.nodeId !== activeNodeId) {
            continue;
          }

          if (data.type === "projects_list" && data.projects) {
            setProjects(data.projects);
            continue;
          }

          if (data.type === "project_info" && data.project) {
            setProjects((prev) => {
              const idx = prev.findIndex((p) => p.projectId === data.project.projectId);
              if (idx >= 0) {
                const updated = [...prev];
                updated[idx] = data.project;
                return updated;
              }
              return [...prev, data.project];
            });
            continue;
          }

          if (data.type === "session_info") {
            const info: SessionInfo = {
              sessionId: data.sessionId || "",
              projectId: data.projectId || "",
              projectPath: data.projectPath || data.cwd || "",
              model: data.model || undefined,
              permissionMode: data.permissionMode || undefined,
              summary: data.summary || "",
              status: data.status || "running",
              messageCount: data.messageCount || 0,
              createdAt: data.createdAt || Date.now(),
            };
            setSessions((prev) => {
              const idx = prev.findIndex((s) => s.sessionId === info.sessionId);
              if (idx >= 0) {
                const updated = [...prev];
                updated[idx] = info;
                return updated;
              }
              return [...prev, info];
            });
            if (!activeSessionId && !pendingSessionRef.current) {
              setActiveSessionId(info.sessionId);
              setActiveProjectId(info.projectId);
              pendingSessionRef.current = info.sessionId;
            }
            if (data.model) setModel(data.model);
            if (data.permissionMode) setPermissionMode(data.permissionMode);
            continue;
          }

          if (data.type === "sessions_list" && data.sessions) {
            setSessions(data.sessions);
            // 如果有待加载的会话，将其历史消息加载到聊天视图
            const pendingId = pendingSessionRef.current;
            if (pendingId) {
              const targetSession = (data.sessions as SessionInfo[]).find(
                (s) => s.sessionId === pendingId,
              );
              if (targetSession) {
                // 恢复活跃会话状态（HTTP 认证失败时通过 WebSocket 恢复）
                if (!activeSessionIdRef.current) {
                  setActiveSessionId(targetSession.sessionId);
                  setActiveProjectId(targetSession.projectId);
                  if (targetSession.model) setModel(targetSession.model);
                  if (targetSession.permissionMode) setPermissionMode(targetSession.permissionMode);
                }
                if (targetSession.messages && targetSession.messages.length > 0) {
                const msgs = targetSession.messages as unknown as Record<string, unknown>[];
                const historyProcessor = new UnifiedMessageProcessor();
                const created = targetSession.createdAt || Date.now();
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
                  setMessages(dedupConsecutiveAssistant(processed));
                }
                setHasReceivedInit(true);
              }
              }
            }
            continue;
          }

          if (data.type === "git_status" && data.gitStatus) {
            const status = data.gitStatus as GitStatusResult;
            setGitStatuses((prev) => {
              const next = new Map(prev);
              next.set(status.projectId, status);
              return next;
            });
            continue;
          }

          if (data.type === "git_diff" && data.diffResult) {
            const dr = data.diffResult as GitDiffResult;
            if (!dr.error) {
              setDiffState({
                filePath: dr.filePath,
                projectPath: dr.projectPath,
                staged: data.staged ?? false,
                diff: dr.diff,
              });
            }
            continue;
          }

          if (data.type === "file_tree" && data.fileTreeResult) {
            const result = data.fileTreeResult as FileTreeResult;
            setFileTreeLoading((prev) => {
              const next = new Set(prev);
              next.delete(result.projectId);
              return next;
            });
            if (result.error) {
              setFileTreeErrors((prev) => {
                const next = new Map(prev);
                next.set(result.projectId, result.error!);
                return next;
              });
            } else {
              setFileTrees((prev) => {
                const next = new Map(prev);
                next.set(result.projectId, result.tree);
                return next;
              });
              setFileTreeErrors((prev) => {
                const next = new Map(prev);
                next.delete(result.projectId);
                return next;
              });
            }
            continue;
          }

          if (data.type === "file_content" && data.fileContentResult) {
            const r = data.fileContentResult as FileContentResult;
            if (!r.error) {
              setFileViewState({
                filePath: r.filePath,
                projectPath: r.projectPath,
                content: r.content,
                mimeType: r.mimeType,
                language: r.language,
              });
            }
            continue;
          }

          if (data.type === "session_end") {
            setIsLoading(false);
            currentAssistantMessageRef.current = null;
            continue;
          }

          if (
            data.type === "claude_json" ||
            data.type === "error" ||
            data.type === "done" ||
            data.type === "aborted"
          ) {
            // 刷新后正在运行的会话继续发送流式消息，自动恢复 activeSessionId
            const streamSid = data.sessionId as string | undefined;
            if (streamSid && !activeSessionIdRef.current) {
              setActiveSessionId(streamSid);
            }

            const streamingContext: StreamingContext = {
              currentAssistantMessage: currentAssistantMessageRef.current,
              setCurrentAssistantMessage: (msg) => {
                currentAssistantMessageRef.current = msg;
              },
              addMessage: (msg) => {
                setMessages((prev) => [...prev, msg]);
              },
              updateLastMessage: (content) => {
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (
                    last &&
                    last.type === "chat" &&
                    last.role === "assistant"
                  ) {
                    updated[updated.length - 1] = { ...last, content };
                  }
                  return updated;
                });
              },
              onSessionId: (_sid) => {},
              hasReceivedInit,
              setHasReceivedInit,
              shouldShowInitMessage: () => !hasReceivedInit,
              onModel: (m) => setModel(m),
              onTaskProgress: (p) => setTaskProgress(p),
              onPermissionDenied: (denials) => {
                setPermissionDenials(denials);
              },
              onTokenUsage: (u) =>
                setTokenUsage((prev) => ({
                  ...u,
                  compactionVersion: prev?.compactionVersion ?? 0,
                })),
            };

            processStreamLine(JSON.stringify(data), streamingContext);

            if (data.type === "claude_json" && data.data) {
              const sdkMsg = data.data as Record<string, unknown>;
              if (sdkMsg.type === "system" && sdkMsg.subtype === "init" && sdkMsg.model) {
                setModel(String(sdkMsg.model));
              }
              // compact_boundary 给出 compact 前的真实上下文 token 数，用于校准进度条
              if (sdkMsg.type === "system" && sdkMsg.subtype === "compact_boundary") {
                const meta = sdkMsg.compact_metadata as Record<string, unknown> | undefined;
                if (meta?.pre_tokens) {
                  const preTokens = Number(meta.pre_tokens);
                  setTokenUsage((prev) =>
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
              data.type === "done" ||
              data.type === "error" ||
              data.type === "aborted"
            ) {
              setIsLoading(false);
              setTaskProgress(null);
              currentAssistantMessageRef.current = null;
            }
          }
        } catch (err) {
          console.error("[ChatView] handleRawMessage 解析失败:", err, line.substring(0, 200));
        }
      }
    },
    [processStreamLine, hasReceivedInit, activeSessionId, activeNodeId],
  );
  handleRawMessageRef.current = handleRawMessage;

  // 监听 WebSocket 新消息（通过回调直接处理，避免双路径导致重复消息）
  useEffect(() => {
    onRawMessage((raw: string) => {
      handleRawMessageRef.current?.(raw);
    });
  }, [onRawMessage]);

  const tryAutoAuth = useCallback(
    (nodeId: string): boolean => {
      const savedPassword = loadNodePassword(nodeId);
      if (savedPassword && connected) {
        if (autoAuthTimeoutRef.current) clearTimeout(autoAuthTimeoutRef.current);
        setAutoAuthInProgress(true);
        setPendingAuthNodeId(nodeId);
        setAuthError(null);
        send({ type: 'auth_node', nodeId, password: savedPassword });
        autoAuthTimeoutRef.current = setTimeout(() => {
          setAutoAuthInProgress(false);
          autoAuthTimeoutRef.current = null;
        }, 5000);
        return true;
      }
      return false;
    },
    [connected, send],
  );

  const handleSelectNode = useCallback(
    (nodeId: string) => {
      setActiveNodeId(nodeId);
      setActiveSessionId(null);
      setActiveProjectId(null);
      setMessages([]);
      setProjects([]);
      setSessions([]);
      setHasReceivedInit(false);
      setTokenUsage(null);
      setModel("");
      setPermissionMode("");
      setPermissionDenials(null);
      setTaskProgress(null);
      setAuthError(null);
      setAutoAuthInProgress(false);

      const node = nodes.find((n) => n.nodeId === nodeId);

      if (node?.passwordRequired && !authenticatedNodes.has(nodeId)) {
        if (!tryAutoAuth(nodeId)) {
          setPendingAuthNodeId(nodeId);
        }
        return;
      }

      setPendingAuthNodeId(null);

      // 加载该节点的项目和会话
      authFetch(`/api/projects?nodeId=${encodeURIComponent(nodeId)}`)
        .then((r) => r.json())
        .then((data) => {
          if ((data as { error?: string }).error === 'auth_required') {
            setPendingAuthNodeId(nodeId);
            return;
          }
          setProjects(data as ProjectInfo[]);
        })
        .catch(() => {});

      authFetch(`/api/sessions?nodeId=${encodeURIComponent(nodeId)}`)
        .then((r) => r.json())
        .then((data) => {
          if ((data as { error?: string }).error === 'auth_required') {
            setPendingAuthNodeId(nodeId);
            return;
          }
          setSessions(data as SessionInfo[]);
        })
        .catch(() => {});
    },
    [nodes, authenticatedNodes, tryAutoAuth],
  );

  const handleAuthNode = useCallback(
    (nodeId: string, password: string) => {
      setAuthError(null);
      saveNodePassword(nodeId, password);
      send({ type: 'auth_node', nodeId, password });
    },
    [send],
  );

  const handleCreateProject = useCallback(
    (name: string, projectPath: string) => {
      send({ type: "create_project", name, path: projectPath, nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId],
  );

  const handleDeleteProject = useCallback(
    (projectId: string) => {
      send({ type: "delete_project", projectId, nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId],
  );

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      send({ type: "delete_session", sessionId, nodeId: activeNodeId || undefined });
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
        setMessages([]);
        setHasReceivedInit(false);
      }
    },
    [send, activeNodeId, activeSessionId],
  );

  const handleCreateSession = useCallback(
    (projectId: string, projectPath: string) => {
      // acceptEdits: 自动批准文件读写，Bash 等操作仍需确认
      send({ type: "create_session", projectId, projectPath, permissionMode: "acceptEdits", nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId],
  );

  const handleSelectSession = useCallback(
    (sessionId: string, projectId: string) => {
      setActiveSessionId(sessionId);
      setActiveProjectId(projectId);
      pendingSessionRef.current = sessionId;
      setMessages([]);
      setHasReceivedInit(false);
      setTokenUsage(null);
      setModel("");
      setPermissionMode("");
      setPermissionDenials(null);
      setTaskProgress(null);
      send({ type: "list_sessions", projectId, nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId],
  );

  const handleSelectProject = useCallback(
    (projectId: string) => {
      setActiveProjectId(projectId);
      send({ type: "list_projects", nodeId: activeNodeId || undefined });
      send({ type: "list_sessions", projectId, nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId],
  );

  const handleSwitchPermissionMode = useCallback(
    (newMode: string) => {
      if (!activeSessionId) return;
      if (newMode === permissionMode) return;
      setPermissionMode(newMode);
      send({
        type: "change_permission_mode",
        sessionId: activeSessionId,
        permissionMode: newMode,
        nodeId: activeNodeId || undefined,
      });
    },
    [activeSessionId, send, activeNodeId, permissionMode],
  );

  const handleSlashCommand = useCallback(
    (text: string) => {
      const parts = text.trim().split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = parts[1] || "";

      if (cmd === "/model") {
        // 弹出模型选择器（支持交互确认）
        setModelPickerOpen(true);
        return;
      }

      // /permission <mode> — 即时切换权限模式
      if (cmd === "/permission" && arg) {
        const newMode = parts[1];
        const validModes = ["acceptEdits", "bypassPermissions", "default"];
        if (!validModes.includes(newMode)) {
          const errMsg: ChatMessage = {
            type: "chat",
            role: "assistant",
            content: `无效的权限模式: ${newMode}\n可选: ${validModes.join(", ")}`,
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, errMsg]);
          return;
        }
        if (!activeSessionId) {
          setPermissionMode(newMode);
          return;
        }
        handleSwitchPermissionMode(newMode);
        const modeLabel = PERMISSION_MODES.find(m => m.mode === newMode)?.label || newMode;
        const infoMsg: ChatMessage = {
          type: "chat",
          role: "assistant",
          content: `权限模式已切换为: ${modeLabel} (${newMode})`,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, infoMsg]);
        return;
      }

      // /permission（无参数）— 显示当前模式
      if (cmd === "/permission") {
        const currentMode = permissionMode || "acceptEdits";
        const currentLabel = PERMISSION_MODES.find(m => m.mode === currentMode)?.label || currentMode;
        let content = `/permission — 当前模式: ${currentLabel} (${currentMode})\n\n可切换模式:\n`;
        for (const m of PERMISSION_MODES) {
          const marker = permissionMode === m.mode ? " *" : "  ";
          content += `${marker} ${m.label} — ${m.mode}\n`;
        }
        content += `\n输入 /permission <模式名> 即时切换，或点击顶部模式按钮。`;
        setMessages((prev) => [
          ...prev,
          { type: "chat", role: "assistant", content, timestamp: Date.now() } as ChatMessage,
        ]);
        return;
      }

      // 其他斜杠命令透传给 Claude CLI（如 /compact, /help 等）
      const userMsg: ChatMessage = {
        type: "chat",
        role: "user",
        content: text,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      send({ type: "chat", sessionId: activeSessionId || "", text, nodeId: activeNodeId || undefined });
      setIsLoading(true);
    },
    [activeSessionId, send, activeNodeId, handleSwitchPermissionMode, permissionMode],
  );

  // 模型选择器回调：用户确认切换模型
  const handleModelSelect = useCallback(
    (newModel: string) => {
      setModelPickerOpen(false);
      if (!activeProjectId) return;

      // 创建新会话并使用选定的模型
      const project = projects.find((p) => p.projectId === activeProjectId);
      const projectPath = project?.path || "";
      if (projectPath) {
        send({ type: "create_session", projectId: activeProjectId, projectPath, model: newModel, permissionMode: permissionMode || "acceptEdits", nodeId: activeNodeId || undefined });
      }

      const infoMsg: ChatMessage = {
        type: "chat",
        role: "assistant",
        content: `模型切换为 ${newModel}，已创建新会话。\n原会话保留在侧边栏中，可随时切回。`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, infoMsg]);
    },
    [activeProjectId, projects, send, permissionMode, activeNodeId],
  );

  const handleSendMessage = useCallback(
    (text: string) => {
      // 斜杠命令由前端拦截处理
      if (text.startsWith("/")) {
        handleSlashCommand(text);
        return;
      }

      // 没有活跃会话时提示用户创建项目
      if (!activeSessionId) {
        const tipMsg: ChatMessage = {
          type: "chat",
          role: "assistant",
          content: projects.length === 0
            ? '请先在左侧创建一个项目并指定工作目录，然后创建会话。'
            : '请先在左侧选择一个项目并创建会话。',
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, tipMsg]);
        return;
      }

      const userMsg: ChatMessage = {
        type: "chat",
        role: "user",
        content: text,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      send({ type: "chat", sessionId: activeSessionId, text, permissionMode: permissionMode || "acceptEdits", nodeId: activeNodeId || undefined });
      setIsLoading(true);
    },
    [activeSessionId, send, permissionMode, handleSlashCommand, activeNodeId, projects],
  );

  // 权限拒绝处理：批准并重试
  const handlePermissionApprove = useCallback(() => {
    if (!activeSessionId) return;
    // 发送重试指令：后端会移除被拒回复、用 bypassPermissions 重启 CLI、重放对话
    send({
      type: "retry_with_permission",
      sessionId: activeSessionId,
      permissionMode: "bypassPermissions",
      nodeId: activeNodeId || undefined,
    });
    setPermissionDenials(null);
    // 给用户反馈
    const infoMsg: ChatMessage = {
      type: "chat",
      role: "assistant",
      content: "已批准权限，正在以完全权限重试...",
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, infoMsg]);
    setIsLoading(true);
  }, [activeSessionId, send, activeNodeId]);

  const handlePermissionDismiss = useCallback(() => {
    setPermissionDenials(null);
  }, []);

  const handleAbort = useCallback(() => {
    if (activeSessionId) {
      send({ type: "stop_session", sessionId: activeSessionId, nodeId: activeNodeId || undefined });
    }
    setIsLoading(false);
    currentAssistantMessageRef.current = null;
  }, [activeSessionId, send, activeNodeId]);

  const handleStopSession = useCallback(
    (sessionId: string) => {
      send({ type: "stop_session", sessionId, nodeId: activeNodeId || undefined });
      setSessions((prev) =>
        prev.map((s) =>
          s.sessionId === sessionId ? { ...s, status: "idle" as const } : s,
        ),
      );
    },
    [send, activeNodeId],
  );

  const handleRequestGitStatus = useCallback(
    (projectId: string, projectPath: string) => {
      send({ type: "get_git_status", projectPath, projectId, nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId],
  );

  const handleFileClick = useCallback(
    (filePath: string, projectPath: string, staged: boolean) => {
      send({ type: "get_git_diff", projectPath, filePath, staged, nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId],
  );

  const handleRequestFileTree = useCallback(
    (projectPath: string, projectId: string) => {
      if (fileTrees.has(projectId)) return;
      setFileTreeLoading((prev) => new Set(prev).add(projectId));
      send({ type: "get_file_tree", projectPath, projectId, nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId, fileTrees],
  );

  const handleFileTreeNodeClick = useCallback(
    (filePath: string, projectPath: string) => {
      send({ type: "get_file_content", projectPath, filePath, nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId],
  );

  // 未登录时显示登录表单
  if (!sessionToken) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 dark:bg-slate-900">
        <div className="w-full max-w-sm p-8">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">cc-web</h1>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">请输入访问密码</p>
          </div>
          <div className="space-y-4">
            <input
              type="password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleLogin()}
              placeholder="访问密码"
              className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500 dark:focus:border-blue-400 dark:focus:ring-blue-400"
              autoFocus
            />
            {loginError && (
              <p className="text-sm text-red-500">{loginError}</p>
            )}
            <button
              onClick={handleLogin}
              disabled={loginLoading}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600 dark:focus:ring-offset-slate-900"
            >
              {loginLoading ? "登录中..." : "登录"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full gap-0 relative">
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId={activeProjectId}
        activeSessionId={activeSessionId}
        onSelectProject={handleSelectProject}
        onSelectSession={handleSelectSession}
        onCreateProject={handleCreateProject}
        onCreateSession={handleCreateSession}
        onDeleteProject={handleDeleteProject}
        onDeleteSession={handleDeleteSession}
        onStopSession={handleStopSession}
        isOpen={sidebarOpen}
        isMobile={isMobile}
        onClose={() => setSidebarOpen(false)}
        gitStatuses={gitStatuses}
        onRequestGitStatus={handleRequestGitStatus}
        onFileClick={handleFileClick}
        fileTrees={fileTrees}
        fileTreeErrors={fileTreeErrors}
        fileTreeLoading={fileTreeLoading}
        onRequestFileTree={handleRequestFileTree}
        onFileTreeNodeClick={handleFileTreeNodeClick}
      />
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toggle button bar */}
        <div className="flex items-center gap-2 px-2 py-1 flex-shrink-0 sticky top-0 z-10 bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className={`p-1.5 rounded-md transition-colors text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 ${
              !sidebarOpen ? "" : isMobile ? "hidden" : ""
            }`}
            title={sidebarOpen ? "收起侧栏" : "展开侧栏"}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          {/* 节点选择器 */}
          {nodes.length === 0 ? (
            <span className="text-xs text-amber-600 dark:text-amber-400">无节点在线</span>
          ) : nodes.length === 1 ? (
            <span className="text-xs text-emerald-600 dark:text-emerald-400">
              {nodes[0].passwordRequired && !authenticatedNodes.has(nodes[0].nodeId) ? '\u{1F512} ' : ''}
              {nodes[0].nodeId}
              {authenticatedNodes.has(nodes[0].nodeId) ? ' ✓' : ''}
            </span>
          ) : (
            <select
              value={activeNodeId || ""}
              onChange={(e) => handleSelectNode(e.target.value)}
              className="text-xs rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="" disabled>选择节点</option>
              {nodes.map((n) => (
                <option key={n.nodeId} value={n.nodeId}>
                  {n.passwordRequired && !authenticatedNodes.has(n.nodeId) ? '\u{1F512} ' : ''}
                  {n.nodeId} ({n.sessionCount} 会话)
                  {authenticatedNodes.has(n.nodeId) ? ' ✓' : ''}
                </option>
              ))}
            </select>
          )}
          {/* 会话模式切换器 */}
          {activeSessionId && (
            <div className="flex items-center rounded-md border border-slate-300 dark:border-slate-600 overflow-hidden flex-shrink-0">
              {PERMISSION_MODES.map((pm) => {
                const active = (permissionMode || "acceptEdits") === pm.mode;
                return (
                  <button
                    key={pm.mode}
                    onClick={() => handleSwitchPermissionMode(pm.mode)}
                    disabled={active}
                    title={pm.mode === "default" ? "只读：所有操作需确认" : pm.mode === "acceptEdits" ? "读写：自动批准文件编辑" : "全权限：全部自动批准"}
                    className={`text-xs px-2 py-0.5 transition-colors ${
                      active
                        ? "bg-blue-600 text-white cursor-default"
                        : "text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700"
                    }`}
                  >
                    <span className="hidden sm:inline">{pm.label}</span>
                    <span className="sm:hidden">{pm.shortLabel}</span>
                  </button>
                );
              })}
            </div>
          )}
          {isMobile && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {activeSessionId ? "会话中" : "cc-web"}
            </span>
          )}
        </div>
        {pendingAuthNodeId && !autoAuthInProgress && (
          <div className="flex items-center justify-center py-4 px-2 flex-shrink-0">
            <div className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg p-4 w-full max-w-sm shadow-lg">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-3">
                节点 {pendingAuthNodeId} 需要密码认证
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const input = (e.target as HTMLFormElement).querySelector('input');
                  if (input) {
                    handleAuthNode(pendingAuthNodeId, input.value);
                    input.value = '';
                  }
                }}
              >
                <input
                  type="password"
                  placeholder="请输入节点密码"
                  autoFocus
                  className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2"
                />
                {authError && (
                  <div className="text-xs text-red-500 mb-2">{authError}</div>
                )}
                <div className="flex gap-2">
                  <button
                    type="submit"
                    className="flex-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                  >
                    认证
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPendingAuthNodeId(null);
                      setAuthError(null);
                      setAutoAuthInProgress(false);
                      if (autoAuthTimeoutRef.current) {
                        clearTimeout(autoAuthTimeoutRef.current);
                        autoAuthTimeoutRef.current = null;
                      }
                    }}
                    className="px-3 py-1.5 text-sm border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 rounded-md hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                  >
                    取消
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
        <ChatMessages messages={messages} isLoading={isLoading} />
        <StatusBar
          connected={connected}
          sessionId={activeSessionId}
          nodeId={activeNodeId}
          model={model}
          permissionMode={permissionMode}
          tokenUsage={tokenUsage}
          taskProgress={taskProgress}
        />
        <ChatInput
          isLoading={isLoading}
          onSubmit={handleSendMessage}
          onAbort={handleAbort}
        />
      </div>

      {modelPickerOpen && (
        <ModelPicker
          models={KNOWN_MODELS}
          currentModel={model}
          onSelect={handleModelSelect}
          onClose={() => setModelPickerOpen(false)}
        />
      )}

      {permissionDenials && permissionDenials.length > 0 && (
        <PermissionDialog
          denials={permissionDenials}
          onApprove={handlePermissionApprove}
          onDismiss={handlePermissionDismiss}
        />
      )}

      <GitDiffModal
        isOpen={!!diffState}
        filePath={diffState?.filePath || ""}
        staged={diffState?.staged ?? false}
        diffText={diffState?.diff || ""}
        onClose={() => setDiffState(null)}
      />

      <FileViewerModal
        isOpen={!!fileViewState}
        filePath={fileViewState?.filePath || ""}
        content={fileViewState?.content || ""}
        mimeType={fileViewState?.mimeType || "text"}
        language={fileViewState?.language}
        onClose={() => setFileViewState(null)}
      />
    </div>
  );
}

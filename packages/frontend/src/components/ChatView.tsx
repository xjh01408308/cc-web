import { useState, useCallback, useEffect, useRef } from "react";
import type { ChatMessage, SessionInfo, ProjectInfo, NodeInfo, BrowserEvent } from "../types";
import { BrowserCommandType } from "../types";
import { useWebSocket } from "../hooks/useWebSocket";
import { useStreamParser } from "../hooks/streaming/useStreamParser";
import { useBrowserAuth } from "../hooks/useBrowserAuth";
import { useUi } from "../hooks/useUi";
import { useFileBrowser } from "../hooks/useFileBrowser";
import { useSession } from "../hooks/useSession";
import { useChat } from "../hooks/useChat";
import { UnifiedMessageProcessor } from "../utils/UnifiedMessageProcessor";
import { dedupConsecutiveAssistant } from "../utils/dedupMessages";
import { saveLastView, loadLastView } from "../utils/localStorage";
import { dispatchBrowserEvent } from "../ws/dispatcher";
import { ProjectSidebar } from "./ProjectSidebar";
import { ChatMessages } from "./ChatMessages";
import { ChatInput } from "./ChatInput";
import { StatusBar } from "./StatusBar";
import { ModelPicker } from "./ModelPicker";
import { PermissionDialog } from "./PermissionDialog";
import { GitDiffModal } from "./GitDiffModal";
import { FileViewerModal } from "./FileViewerModal";

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
  const {
    authed,
    clearSession,
    currentUser,
    loginUsername,
    setLoginUsername,
    loginPassword,
    setLoginPassword,
    loginError,
    loginLoading,
    authFetch,
    handleLogin,
    initialLoadDone,
  } = useBrowserAuth();

  // WS 被动断开后探测到 session 失效（如 relay 重启丢内存 session）时清登录态，跳回登录页
  const { connected, send, onRawMessage } = useWebSocket(authed, clearSession);
  const { processStreamLine } = useStreamParser();

  const isMobile = useIsMobile();
  const { sidebarOpen, setSidebarOpen, modelPickerOpen, setModelPickerOpen } = useUi();
  const {
    nodes, setNodes,
    activeNodeId, setActiveNodeId,
    projects, setProjects,
    sessions, setSessions,
    activeSessionId, setActiveSessionId,
    activeProjectId, setActiveProjectId,
    pendingSessionRef, creatingNewSessionRef, restoredRef,
    handleSelectProject, handleCreateProject, handleDeleteProject, handleStopSession,
  } = useSession({ send });
  const {
    messages, setMessages,
    isLoading, setIsLoading,
    model, setModel,
    hasReceivedInit, setHasReceivedInit,
    permissionMode, setPermissionMode,
    taskProgress, setTaskProgress,
    permissionDenials, setPermissionDenials,
    tokenUsage, setTokenUsage,
    currentAssistantMessageRef,
    resetForSessionChange,
  } = useChat();
  const {
    gitStatuses, setGitStatuses,
    diffState, setDiffState,
    fileTrees, setFileTrees,
    fileTreeErrors, setFileTreeErrors,
    fileTreeLoading, setFileTreeLoading,
    fileViewState, setFileViewState,
    handleRequestGitStatus, handleFileClick, handleRequestFileTree, handleFileTreeNodeClick,
  } = useFileBrowser({ send, activeNodeId });

  const handleRawMessageRef = useRef<((raw: string) => void) | null>(null);

  // 初始加载节点列表和项目列表（通过 HTTP，可靠）
  useEffect(() => {
    if (!authed || initialLoadDone.current) return;
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
              setProjects(projData as ProjectInfo[]);
            })
            .catch(() => {});
          authFetch(`/api/sessions?nodeId=${encodeURIComponent(restoreNodeId)}`)
            .then((r) => r.json())
            .then((sessData: SessionInfo[]) => {
              setSessions(sessData);
              // 恢复上次的会话（含历史消息）
              pendingSessionRef.current = null;
              if (saved?.sessionId) {
                const target = sessData.find((s) => s.sessionId === saved.sessionId);
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
  }, [authed, authFetch]);

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

  // 节点选中后通过 WS 加载项目和会话（HTTP 未返回数据时的补充路径；切换节点时也走此）
  // 不用 loadedNodesRef 防重 —— 因为 send() 在 WS 未 OPEN 时会静默丢弃，
  // 如果首次被丢弃，后续重连必须能重新请求。用 projects/sessions 是否为空来判断是否需要加载。
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const loadRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRetryCountRef = useRef(0);

  useEffect(() => {
    if (activeNodeId && connected) {
      const needProjects = projectsRef.current.length === 0;
      const needSessions = sessionsRef.current.length === 0;

      if (needProjects || needSessions) {
        if (needProjects) send({ type: BrowserCommandType.ListProjects, nodeId: activeNodeId });
        if (needSessions) send({ type: BrowserCommandType.ListSessions, nodeId: activeNodeId });

        // 2 秒后如果数据还没到就重试，最多 3 次
        loadRetryCountRef.current = 0;
        const doRetry = () => {
          if (loadRetryCountRef.current >= 3) return;
          const stillNeedProjects = projectsRef.current.length === 0;
          const stillNeedSessions = sessionsRef.current.length === 0;
          if (!stillNeedProjects && !stillNeedSessions) return;
          loadRetryCountRef.current++;
          if (stillNeedProjects) send({ type: BrowserCommandType.ListProjects, nodeId: activeNodeId });
          if (stillNeedSessions) send({ type: BrowserCommandType.ListSessions, nodeId: activeNodeId });
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
  }, [activeNodeId, connected, send]);

  // 处理一条 WebSocket 原始消息
  const handleRawMessage = useCallback(
    (raw: string) => {
      const lines = raw.split("\n").filter((line) => line.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as BrowserEvent;
          dispatchBrowserEvent(event, {
            activeNodeId,
            activeSessionId,
            processStreamLine,
            hasReceivedInit,
            currentAssistantMessageRef,
            pendingSessionRef,
            creatingNewSessionRef,
            setNodes,
            setActiveNodeId,
            setProjects,
            setSessions,
            setActiveSessionId,
            setActiveProjectId,
            setMessages,
            setModel,
            setPermissionMode,
            setHasReceivedInit,
            setIsLoading,
            setTaskProgress,
            setPermissionDenials,
            setTokenUsage,
            setGitStatuses,
            setDiffState,
            setFileTrees,
            setFileTreeErrors,
            setFileTreeLoading,
            setFileViewState,
          });
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

  const handleSelectNode = useCallback(
    (nodeId: string) => {
      setActiveNodeId(nodeId);
      setActiveSessionId(null);
      setActiveProjectId(null);
      resetForSessionChange();
      setProjects([]);
      setSessions([]);

      // 加载该节点的项目和会话
      authFetch(`/api/projects?nodeId=${encodeURIComponent(nodeId)}`)
        .then((r) => r.json())
        .then((data) => setProjects(data as ProjectInfo[]))
        .catch(() => {});

      authFetch(`/api/sessions?nodeId=${encodeURIComponent(nodeId)}`)
        .then((r) => r.json())
        .then((data) => setSessions(data as SessionInfo[]))
        .catch(() => {});
    },
    [authFetch],
  );

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      send({ type: BrowserCommandType.DeleteSession, sessionId, nodeId: activeNodeId || undefined });
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
      creatingNewSessionRef.current = true;
      // acceptEdits: 自动批准文件读写，Bash 等操作仍需确认
      send({ type: BrowserCommandType.CreateSession, projectId, projectPath, permissionMode: "acceptEdits", nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId],
  );

  const handleSelectSession = useCallback(
    (sessionId: string, projectId: string) => {
      setActiveSessionId(sessionId);
      setActiveProjectId(projectId);
      pendingSessionRef.current = sessionId;
      resetForSessionChange();
      send({ type: BrowserCommandType.ListSessions, projectId, nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId],
  );

  const handleSwitchPermissionMode = useCallback(
    (newMode: string) => {
      if (!activeSessionId) return;
      if (newMode === permissionMode) return;
      // 不乐观更新——permissionMode 以后端回传的 SessionInfo 为准（dispatcher.handleSessionInfo）。
      // 后端可能 FORCE 锁定权限模式（CLAUDE_FORCE_PERMISSION_MODE），乐观值被覆盖会造成
      // UI 先跳到新模式再闪回的误导。
      send({
        type: BrowserCommandType.ChangePermissionMode,
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
          content: `已请求切换权限模式为: ${modeLabel} (${newMode})`,
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
      send({ type: BrowserCommandType.Chat, sessionId: activeSessionId || "", text, nodeId: activeNodeId || undefined });
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
        send({ type: BrowserCommandType.CreateSession, projectId: activeProjectId, projectPath, model: newModel, permissionMode: permissionMode || "acceptEdits", nodeId: activeNodeId || undefined });
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
      send({ type: BrowserCommandType.Chat, sessionId: activeSessionId, text, permissionMode: permissionMode || "acceptEdits", nodeId: activeNodeId || undefined });
      setIsLoading(true);
    },
    [activeSessionId, send, permissionMode, handleSlashCommand, activeNodeId, projects],
  );

  // 权限拒绝处理：批准并重试
  const handlePermissionApprove = useCallback(() => {
    if (!activeSessionId) return;
    // 发送重试指令：后端会移除被拒回复、用 bypassPermissions 重启 CLI、重放对话
    send({
      type: BrowserCommandType.RetryWithPermission,
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
      send({ type: BrowserCommandType.StopSession, sessionId: activeSessionId, nodeId: activeNodeId || undefined });
    }
    setIsLoading(false);
    currentAssistantMessageRef.current = null;
  }, [activeSessionId, send, activeNodeId]);

  // 未登录时显示登录表单
  if (!authed) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 dark:bg-slate-900">
        <div className="w-full max-w-sm p-8">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">cc-web</h1>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">请输入用户名和密码</p>
          </div>
          <div className="space-y-4">
            <input
              type="text"
              value={loginUsername}
              onChange={(e) => setLoginUsername(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleLogin()}
              placeholder="用户名"
              className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500 dark:focus:border-blue-400 dark:focus:ring-blue-400"
              autoFocus
              autoComplete="username"
            />
            <input
              type="password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleLogin()}
              placeholder="密码"
              className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500 dark:focus:border-blue-400 dark:focus:ring-blue-400"
              autoComplete="current-password"
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
        defaultProjectPath={nodes.find((n) => n.nodeId === activeNodeId)?.workspaceRoot || ""}
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
              {nodes[0].nodeId}
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
                  {n.nodeId} ({n.sessionCount} 会话)
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
          {/* admin 入口：仅 admin 可见（UX 隐藏；授权由 relay 侧 requireAdmin 强制） */}
          {currentUser?.role === "admin" && (
            <a
              href="/admin"
              className="ml-auto text-xs px-2 py-1 rounded-md text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700"
              title="用户管理"
            >
              管理
            </a>
          )}
        </div>
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

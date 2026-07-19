import { useState, useCallback, useRef } from "react";
import { BrowserCommandType } from "../types";
import type { BrowserCommand, SessionInfo, ProjectInfo, NodeInfo } from "../types";

// 会话实体域：节点列表 / 项目 / 会话 CRUD + 当前选中节点/项目/会话。
// nodes/activeNodeId 归此处（PR-5 决定，useNodeAuth 注释 L10-12 引用此处）。
// 与 useChat（当前对话流）分开 —— Session 是会话实体 CRUD，Chat 是当前对话流；
// 高耦合通过协调层解（见 ADR 0002）。
//
// 仅含纯 session 域 handler（零跨 chat/auth 域副作用）。跨域 handler
// （select/delete/create session + select node）留 ChatView 协调层，用
// chat.resetForSessionChange 与本 hook 暴露的 setter 组合。
export function useSession({
  send,
}: {
  send: (data: BrowserCommand) => void;
}) {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  // 业务语义 ref（协调层 + dispatcher 读写 .current）：
  // - pendingSessionRef: 待恢复历史消息的会话 id（HTTP/WS 异步路径都要读它）
  // - creatingNewSessionRef: 标记正在创建新会话（dispatcher 收到 SessionInfo 据此自动选中）
  // - restoredRef: 初始加载守卫，避免 saved view 与默认请求冲突
  // 不集中到技术 bridge hook —— 它们有业务语义，归各自的域（ADR 0002）。
  const pendingSessionRef = useRef<string | null>(null);
  const creatingNewSessionRef = useRef(false);
  const restoredRef = useRef(false);

  const handleSelectProject = useCallback(
    (projectId: string) => {
      setActiveProjectId(projectId);
      send({ type: BrowserCommandType.ListProjects, nodeId: activeNodeId || undefined });
      send({ type: BrowserCommandType.ListSessions, projectId, nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId],
  );

  const handleCreateProject = useCallback(
    (name: string, projectPath: string) => {
      send({ type: BrowserCommandType.CreateProject, name, path: projectPath, nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId],
  );

  const handleDeleteProject = useCallback(
    (projectId: string) => {
      send({ type: BrowserCommandType.DeleteProject, projectId, nodeId: activeNodeId || undefined });
    },
    [send, activeNodeId],
  );

  const handleStopSession = useCallback(
    (sessionId: string) => {
      send({ type: BrowserCommandType.StopSession, sessionId, nodeId: activeNodeId || undefined });
      setSessions((prev) =>
        prev.map((s) =>
          s.sessionId === sessionId ? { ...s, status: "idle" as const } : s,
        ),
      );
    },
    [send, activeNodeId],
  );

  return {
    nodes,
    setNodes,
    activeNodeId,
    setActiveNodeId,
    projects,
    setProjects,
    sessions,
    setSessions,
    activeSessionId,
    setActiveSessionId,
    activeProjectId,
    setActiveProjectId,
    pendingSessionRef,
    creatingNewSessionRef,
    restoredRef,
    handleSelectProject,
    handleCreateProject,
    handleDeleteProject,
    handleStopSession,
  };
}

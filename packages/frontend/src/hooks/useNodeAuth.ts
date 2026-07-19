import { useState, useCallback, useEffect, useRef } from "react";
import { BrowserCommandType } from "../types";
import type { BrowserCommand } from "../types";
import { loadNodePassword, saveNodePassword } from "../utils/localStorage";

// 节点层认证（每个远端节点各自的访问密码，走 WebSocket AuthNode 命令）。
// 与浏览器层认证（useBrowserAuth，httpOnly cookie）是两套独立 state，
// 不合 useAuth —— "auth" 是 overloaded 词，见 CONTEXT.md / ADR 0002。
//
// nodes / activeNodeId 不在此处：它们属 session/节点列表域（PR-6 的 useSession）。
// "自动选中后触发认证"（Effect 2）跨 nodes + activeNodeId + auth 三域，留 ChatView
// 协调层，消费本 hook 暴露的 tryAutoAuth / setPendingAuthNodeId（见 ADR 0002）。
export function useNodeAuth({
  send,
  connected,
}: {
  send: (data: BrowserCommand) => void;
  connected: boolean;
}) {
  const [authenticatedNodes, setAuthenticatedNodes] = useState<Set<string>>(new Set());
  const [pendingAuthNodeId, setPendingAuthNodeId] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [autoAuthInProgress, setAutoAuthInProgress] = useState(false);

  const autoAuthTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 当节点需要认证且 WebSocket 已连接时，尝试用本地保存的密码自动认证。
  // 注意：setAutoAuthInProgress(true) 会让本 effect 重跑（autoAuthInProgress 在依赖
  // 数组里），cleanup 会清掉刚设的 5s timeout —— 故超时回退实际不生效，认证
  // inProgress 的回退靠 dispatcher 收到 AuthResult 事件后 setAutoAuthInProgress(false)。
  // 此为既有行为，PR-5 纯搬迁不改。
  useEffect(() => {
    if (pendingAuthNodeId && connected && !autoAuthInProgress && !authenticatedNodes.has(pendingAuthNodeId)) {
      const savedPassword = loadNodePassword(pendingAuthNodeId);
      if (savedPassword) {
        if (autoAuthTimeoutRef.current) clearTimeout(autoAuthTimeoutRef.current);
        setAutoAuthInProgress(true);
        setAuthError(null);
        send({ type: BrowserCommandType.AuthNode, nodeId: pendingAuthNodeId, password: savedPassword });
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

  const tryAutoAuth = useCallback(
    (nodeId: string): boolean => {
      const savedPassword = loadNodePassword(nodeId);
      if (savedPassword && connected) {
        if (autoAuthTimeoutRef.current) clearTimeout(autoAuthTimeoutRef.current);
        setAutoAuthInProgress(true);
        setPendingAuthNodeId(nodeId);
        setAuthError(null);
        send({ type: BrowserCommandType.AuthNode, nodeId, password: savedPassword });
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

  const handleAuthNode = useCallback(
    (nodeId: string, password: string) => {
      setAuthError(null);
      saveNodePassword(nodeId, password);
      send({ type: BrowserCommandType.AuthNode, nodeId, password });
    },
    [send],
  );

  return {
    authenticatedNodes,
    setAuthenticatedNodes,
    pendingAuthNodeId,
    setPendingAuthNodeId,
    authError,
    setAuthError,
    autoAuthInProgress,
    setAutoAuthInProgress,
    autoAuthTimeoutRef,
    tryAutoAuth,
    handleAuthNode,
  };
}

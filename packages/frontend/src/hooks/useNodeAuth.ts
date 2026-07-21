import { useState, useCallback, useEffect, useRef } from "react";
import { BrowserCommandType } from "../types";
import type { BrowserCommand } from "../types";
import { loadNodePassword, saveNodePassword } from "../utils/localStorage";

// 跨公网（local 本地 ↔ relay 云主机）偶发丢包会让 relay 的 AuthNode 5s 超时，但那并
// 不代表密码错（见 dispatcher 的 AuthResult failure 分支 —— 仅"密码错误"才删密码）。
// 超时后 dispatcher 把 autoAuthInProgress 置 false，触发下方 Effect 重跑，在本上限
// 内自动重发；用尽则停在弹窗（authError 已是"认证超时"）等用户处理，避免无限重试。
const MAX_AUTO_AUTH_RETRIES = 2;

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
  const autoAuthRetryCountRef = useRef(0);

  // 当节点需要认证且 WebSocket 已连接时，尝试用本地保存的密码自动认证。
  // 超时重试：relay 报"认证超时"多为跨公网链路瞬时丢包（非密码错）。dispatcher 收到
  // AuthResult(success:false) 后 setAutoAuthInProgress(false)，本 effect 因此重跑，在
  // MAX_AUTO_AUTH_RETRIES 内自动重发，用尽则停在弹窗。
  // setAutoAuthInProgress(true) 触发重跑时 cleanup 清 5s timeout，前端 timeout 仅作
  // 兜底；真正的 inProgress 回退靠 dispatcher 的 AuthResult 事件（既有行为）。
  useEffect(() => {
    if (
      pendingAuthNodeId &&
      connected &&
      !autoAuthInProgress &&
      !authenticatedNodes.has(pendingAuthNodeId) &&
      autoAuthRetryCountRef.current < MAX_AUTO_AUTH_RETRIES
    ) {
      const savedPassword = loadNodePassword(pendingAuthNodeId);
      if (savedPassword) {
        if (autoAuthTimeoutRef.current) clearTimeout(autoAuthTimeoutRef.current);
        autoAuthRetryCountRef.current += 1;
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

  // 认证成功（节点进入 authenticatedNodes）→ 重置自动重试计数，为下次认证准备
  useEffect(() => {
    if (pendingAuthNodeId && authenticatedNodes.has(pendingAuthNodeId)) {
      autoAuthRetryCountRef.current = 0;
    }
  }, [pendingAuthNodeId, authenticatedNodes]);

  const tryAutoAuth = useCallback(
    (nodeId: string): boolean => {
      const savedPassword = loadNodePassword(nodeId);
      if (savedPassword && connected) {
        if (autoAuthTimeoutRef.current) clearTimeout(autoAuthTimeoutRef.current);
        // 新一轮认证（节点切换/初次）：本轮首次发送计为 1，与 Effect 路径对齐 ——
        // 总尝试上限 = MAX_AUTO_AUTH_RETRIES（首次 + Effect 重试直到用尽）
        autoAuthRetryCountRef.current = 1;
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
      // 用户手动提交是新的权威尝试，重置计数给后续 Effect 完整重试额度
      autoAuthRetryCountRef.current = 0;
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

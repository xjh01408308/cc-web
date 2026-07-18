import { useEffect, useRef, useCallback, useState } from "react";
import { getWsUrl } from "../config/ws";
import type { BrowserCommand } from "../types";

interface UseWebSocketReturn {
  connected: boolean;
  send: (data: BrowserCommand) => void;
  onRawMessage: (cb: (raw: string) => void) => void;
}

export function useWebSocket(authed: boolean): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(2000);
  const mounted = useRef(true);
  const rawMessageCb = useRef<((raw: string) => void) | null>(null);
  const pendingQueue = useRef<BrowserCommand[]>([]);

  const [connected, setConnected] = useState(false);

  const onRawMessage = useCallback((cb: (raw: string) => void) => {
    rawMessageCb.current = cb;
  }, []);

  const connect = useCallback(() => {
    if (!mounted.current) return;
    if (!authed) return; // 未登录时不连接，避免被拒后无限重连
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const url = getWsUrl();
    const ws = new WebSocket(url);

    ws.onopen = () => {
      if (!mounted.current) return;
      setConnected(true);
      reconnectDelay.current = 2000;
      // 发送积压在队列中的消息
      const queue = pendingQueue.current;
      pendingQueue.current = [];
      for (const msg of queue) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      }
    };

    ws.onmessage = (event) => {
      if (!mounted.current) return;
      const raw = event.data as string;
      rawMessageCb.current?.(raw);
    };

    ws.onclose = () => {
      if (!mounted.current) return;
      wsRef.current = null;
      setConnected(false);
      // 自动重连
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null;
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
        connect();
      }, reconnectDelay.current);
    };

    ws.onerror = () => {
      // 不调用 close()，浏览器在错误时会自动关闭 WebSocket
      // close 事件会自然触发 onclose 来完成清理和重连
    };

    wsRef.current = ws;
  }, [authed]);

  const send = useCallback((data: BrowserCommand) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    } else {
      // 未连接时入队，重连后自动发送（最多保留 20 条防止内存泄漏）
      if (pendingQueue.current.length < 20) {
        pendingQueue.current.push(data);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    connect();
    return () => {
      mounted.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      // StrictMode: cleanup 中只清理回调，CONNECTING 状态不 close（会触发报错）
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CLOSING) {
          wsRef.current.close();
        }
        wsRef.current = null;
      }
      pendingQueue.current = [];
    };
  }, [connect]);

  return { connected, send, onRawMessage };
}

import { WebSocket } from 'ws';
import { RELAY_URL, RELAY_TOKEN, NODE_ID, NODE_PASSWORD, RECONNECT_DELAY, MAX_RECONNECT_DELAY } from './config.js';

type MessageHandler = (msg: { type: string; [key: string]: unknown }) => void;

const READY_STATE_LABEL: Record<number, string> = {
  0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED',
};

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentDelay = RECONNECT_DELAY;
let reconnectAttempt = 0;       // 重连次数计数器
let connectTime: Date | null = null;  // 本次连接建立时间
let handlers: MessageHandler[] = [];

export function onMessage(handler: MessageHandler): void {
  handlers.push(handler);
}

export function send(data: unknown): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

export function isConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

function connect(): void {
  if (ws) {
    const oldState = READY_STATE_LABEL[ws.readyState] || ws.readyState;
    console.log(`[ws-client] 关闭旧连接 (readyState=${oldState}) 后重新连接`);
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }

  reconnectAttempt++;
  console.log(`[ws-client] 第 ${reconnectAttempt} 次连接尝试 → ${RELAY_URL}`);

  ws = new WebSocket(RELAY_URL);

  ws.on('open', () => {
    connectTime = new Date();
    console.log('[ws-client] 已连接到中转服务');
    currentDelay = RECONNECT_DELAY;
    reconnectAttempt = 0;  // 连接成功后重置重连计数

    // 注册
    send({ type: 'register', nodeId: NODE_ID, token: RELAY_TOKEN, passwordRequired: !!NODE_PASSWORD });
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') {
        send({ type: 'pong' });
        return;
      }
      for (const handler of handlers) {
        handler(msg);
      }
    } catch {
      // 忽略解析失败
    }
  });

  ws.on('close', (code, reason) => {
    const duration = connectTime ? `${Math.round((Date.now() - connectTime.getTime()) / 1000)}s` : '未知';
    const reasonStr = reason ? reason.toString('utf-8').substring(0, 100) : '(无)';
    console.log(`[ws-client] 连接已断开 | 本次持续: ${duration} | closeCode: ${code} | reason: ${reasonStr}`);
    ws = null;
    connectTime = null;
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    const label = READY_STATE_LABEL[ws?.readyState ?? -1] || 'unknown';
    console.error(`[ws-client] 连接错误 | ${err.message} | readyState=${label}`);
    // 兜底：某些异常场景下 error 后可能不触发 close，确保重连
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) {
    console.log(`[ws-client] 已有重连定时器等待中，跳过重复调度`);
    return;
  }
  console.log(`[ws-client] ${currentDelay / 1000}s 后开始第 ${reconnectAttempt + 1} 次重连...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    const prevDelay = currentDelay;
    currentDelay = Math.min(currentDelay * 2, MAX_RECONNECT_DELAY);
    console.log(`[ws-client] 重连定时器触发 (上次延迟 ${prevDelay / 1000}s, 下次延迟 ${currentDelay / 1000}s)`);
    connect();
  }, currentDelay);
}

export function start(): void {
  connect();
}

export function stop(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }
}

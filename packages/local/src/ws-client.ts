import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { RELAY_URL, NODE_ID, NODE_SECRET, NODE_PASSWORD, WORKSPACE_ROOT, RECONNECT_DELAY, MAX_RECONNECT_DELAY, RELAY_CA_CERT } from './config.js';
import type { LocalCommand, LocalControl, LocalEvent } from './types.js';
import { LocalEventType, LocalControlType } from './types.js';

type MessageHandler = (msg: LocalCommand | LocalControl) => void;

const READY_STATE_LABEL: Record<number, string> = {
  0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED',
};

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentDelay = RECONNECT_DELAY;
let reconnectAttempt = 0;       // 重连次数计数器
let connectTime: Date | null = null;  // 本次连接建立时间
let handlers: MessageHandler[] = [];
// 注册被中转拒绝（未预注册 / nodeSecret 错误）的致命错误。置位后不再重连——
// 凭证错误不会自愈，无限重连只会刷日志；需管理员修正配置（预注册 / 轮转 secret）后重启。
let fatalError: string | null = null;

export function onMessage(handler: MessageHandler): void {
  handlers.push(handler);
}

export function send(data: LocalEvent): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
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

  const opts: { ca?: Buffer } = {};
  if (RELAY_CA_CERT) {
    opts.ca = readFileSync(RELAY_CA_CERT);
  }
  ws = new WebSocket(RELAY_URL, opts);

  ws.on('open', () => {
    connectTime = new Date();
    console.log('[ws-client] 已连接到中转服务');
    currentDelay = RECONNECT_DELAY;
    reconnectAttempt = 0;  // 连接成功后重置重连计数

    // 注册：带预注册凭证（nodeId + nodeSecret），替代已废弃的全局 RELAY_TOKEN
    send({ type: LocalEventType.Register, nodeId: NODE_ID, nodeSecret: NODE_SECRET, passwordRequired: !!NODE_PASSWORD, workspaceRoot: WORKSPACE_ROOT });
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === LocalControlType.Ping) {
        send({ type: LocalEventType.Pong });
        return;
      }
      // relay→local 的顶层 error 仅在注册拒绝时发送（见 ws-relay Register 分支）。
      // 捕获后置位 fatalError：close 事件随后触发，因已置位不再重连，给管理员明确提示。
      if (msg.type === 'error') {
        fatalError = (msg as { error?: string }).error || '未知错误';
        console.error(`[ws-client] 注册被中转拒绝: ${fatalError}`);
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
    if (fatalError) {
      // 凭证错误不会自愈：停止重连，提示管理员修正 NODE_ID / NODE_SECRET 后重启
      console.error(`[ws-client] 注册认证失败，已停止重连 | 原因: ${fatalError}`);
      console.error('[ws-client] 请确认 NODE_ID 已在 /admin 预注册、NODE_SECRET 正确（或已轮转），修正后重启本服务');
      return;
    }
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

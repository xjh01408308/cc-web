export const NODE_ENV = process.env.NODE_ENV || 'development';
export const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:3001/ws/local';
// Node 注册凭证（每 Node 独立，由管理员预发生成）；替代已废弃的全局 RELAY_TOKEN（见 ADR-0004）。
// NODE_ID / NODE_SECRET 均为必填（管理员定义），index.ts 启动时校验非空。
export const NODE_ID = process.env.NODE_ID || '';
export const NODE_SECRET = process.env.NODE_SECRET || '';
export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '';
// 强制锁定权限模式，忽略前端传的值。不设或留空 = 以前端为准
export const FORCE_PERMISSION_MODE = process.env.CLAUDE_FORCE_PERMISSION_MODE || '';
export const RECONNECT_DELAY = Number(process.env.RECONNECT_DELAY) || 2000;
export const MAX_RECONNECT_DELAY = Number(process.env.MAX_RECONNECT_DELAY) || 30000;
// relay 链路假死监测（T7，#26）：local 侧超过此阈值未收到 relay 任何消息（Ping/命令）→ 主动断开走指数退避重连。
// 补齐双向监测的另一半（relay 单向监测 local 已有；local 监测 relay 新增）。
export const RELAY_IDLE_TIMEOUT_MS = Number(process.env.RELAY_IDLE_TIMEOUT_MS) || 90000;
// 中继服务 TLS CA 证书路径（wss 连接自签名证书时使用，留空则使用系统 CA）
export const RELAY_CA_CERT = process.env.RELAY_CA_CERT || '';

export function isDevMode(): boolean {
  return NODE_ENV !== 'production';
}

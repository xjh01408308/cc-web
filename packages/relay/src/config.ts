export const NODE_ENV = process.env.NODE_ENV || 'development';
export const RELAY_PORT = parseInt(process.env.RELAY_PORT || '3001');
export const RELAY_BROWSER_TOKEN = process.env.RELAY_BROWSER_TOKEN || '';
export const STATIC_DIR = process.env.STATIC_DIR || '../../frontend/dist';
// Node↔Relay 心跳保活（T7，#26）：relay→local Ping 间隔与 local 链路假死判定阈值。
// 跨公网链路可能 TCP 假死（两端 ws 仍 OPEN 但中间断），relay 据此主动关闭触发 local 重连重建。
export const RELAY_PING_INTERVAL_MS = Number(process.env.RELAY_PING_INTERVAL_MS) || 30000;
export const RELAY_LOCAL_IDLE_TIMEOUT_MS = Number(process.env.RELAY_LOCAL_IDLE_TIMEOUT_MS) || 90000;
// 首 admin 种子：Relay 首启 users 表为空时据此幂等创建首个管理员（见 ADR-0003）。
// 替代已废弃的 RELAY_PASSWORD（原单一全局访问密码）。
export const INITIAL_ADMIN_USER = process.env.INITIAL_ADMIN_USER || 'admin';
export const INITIAL_ADMIN_PASSWORD = process.env.INITIAL_ADMIN_PASSWORD || 'admin';

export function isDevMode(): boolean {
  return NODE_ENV !== 'production';
}

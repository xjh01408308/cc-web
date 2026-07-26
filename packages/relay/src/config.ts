export const NODE_ENV = process.env.NODE_ENV || 'development';
export const RELAY_PORT = parseInt(process.env.RELAY_PORT || '3001');
export const RELAY_BROWSER_TOKEN = process.env.RELAY_BROWSER_TOKEN || '';
export const STATIC_DIR = process.env.STATIC_DIR || '../../frontend/dist';
// Node↔Relay 心跳保活（T7，#26）：relay→local Ping 间隔与 local 链路假死判定阈值。
// 跨公网链路可能 TCP 假死（两端 ws 仍 OPEN 但中间断），relay 据此主动关闭触发 local 重连重建。
export const RELAY_PING_INTERVAL_MS = Number(process.env.RELAY_PING_INTERVAL_MS) || 30000;
export const RELAY_LOCAL_IDLE_TIMEOUT_MS = Number(process.env.RELAY_LOCAL_IDLE_TIMEOUT_MS) || 90000;
// WS 单条消息字节上限（index.ts 的 WebSocketServer.maxPayload）：ws 库在收到的帧累计字节超限时
// 直接关闭连接（close 1009），不把整帧交进内存——从根上防超大消息被 ws-relay.ts 的 JSON.parse
// 解析时吃光堆（OOM）。默认 64MB：FileTree 对大工作区（即便 file-utils.ts 已排除 node_modules/.git）
// 序列化后仍可能数十 MB，16MB 实测会误杀正常 FileTree（节点上线即被踢、循环重连）；64MB 单次 parse
// 约 1–300MB 堆，在 ~1GB old space 下安全；env 可调。治本＝限制 FileTree 体积（见 file-utils.ts）。
export const RELAY_WS_MAX_PAYLOAD = Number(process.env.RELAY_WS_MAX_PAYLOAD) || 64 * 1024 * 1024;
// 首 admin 种子：Relay 首启 users 表为空时据此幂等创建首个管理员（见 ADR-0003）。
// 替代已废弃的 RELAY_PASSWORD（原单一全局访问密码）。
export const INITIAL_ADMIN_USER = process.env.INITIAL_ADMIN_USER || 'admin';
export const INITIAL_ADMIN_PASSWORD = process.env.INITIAL_ADMIN_PASSWORD || 'admin';

export function isDevMode(): boolean {
  return NODE_ENV !== 'production';
}

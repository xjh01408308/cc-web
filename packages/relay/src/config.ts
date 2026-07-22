export const NODE_ENV = process.env.NODE_ENV || 'development';
export const RELAY_PORT = parseInt(process.env.RELAY_PORT || '3001');
export const RELAY_BROWSER_TOKEN = process.env.RELAY_BROWSER_TOKEN || '';
export const STATIC_DIR = process.env.STATIC_DIR || '../../frontend/dist';
// 首 admin 种子：Relay 首启 users 表为空时据此幂等创建首个管理员（见 ADR-0003）。
// 替代已废弃的 RELAY_PASSWORD（原单一全局访问密码）。
export const INITIAL_ADMIN_USER = process.env.INITIAL_ADMIN_USER || 'admin';
export const INITIAL_ADMIN_PASSWORD = process.env.INITIAL_ADMIN_PASSWORD || 'admin';

export function isDevMode(): boolean {
  return NODE_ENV !== 'production';
}

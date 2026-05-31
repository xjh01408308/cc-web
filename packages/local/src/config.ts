import { hostname } from 'node:os';

export const NODE_ENV = process.env.NODE_ENV || 'development';
export const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:3001/ws/local';
export const RELAY_TOKEN = process.env.RELAY_TOKEN || 'dev-token';
export const NODE_ID = process.env.NODE_ID || hostname();
export const NODE_PASSWORD = process.env.NODE_PASSWORD || '';
export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '';
// 强制锁定权限模式，忽略前端传的值。不设或留空 = 以前端为准
export const FORCE_PERMISSION_MODE = process.env.CLAUDE_FORCE_PERMISSION_MODE || '';
export const RECONNECT_DELAY = Number(process.env.RECONNECT_DELAY) || 2000;
export const MAX_RECONNECT_DELAY = Number(process.env.MAX_RECONNECT_DELAY) || 30000;

export function isDevMode(): boolean {
  return NODE_ENV !== 'production';
}

export function isNodePasswordEmpty(): boolean {
  return !NODE_PASSWORD;
}

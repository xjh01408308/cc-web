export const NODE_ENV = process.env.NODE_ENV || 'development';
export const RELAY_PORT = parseInt(process.env.RELAY_PORT || '3001');
export const RELAY_TOKEN = process.env.RELAY_TOKEN || 'dev-token';
export const RELAY_BROWSER_TOKEN = process.env.RELAY_BROWSER_TOKEN || '';
export const STATIC_DIR = process.env.STATIC_DIR || '../../frontend/dist';
export const RELAY_PASSWORD = process.env.RELAY_PASSWORD || '';

export function isDevMode(): boolean {
  return NODE_ENV !== 'production';
}

export function isUsingDefaultRelayToken(): boolean {
  return RELAY_TOKEN === 'dev-token' && !process.env.RELAY_TOKEN;
}

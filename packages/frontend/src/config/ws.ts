// 自动检测：根据页面协议选择 ws/wss，通过 nginx 反向代理时自动走同域
const host = window.location.hostname;
const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const baseUrl = import.meta.env.VITE_WS_URL || `${protocol}://${host}/ws/browser`;
const browserToken = import.meta.env.VITE_BROWSER_TOKEN || '';
export const WS_BROWSER_URL = browserToken
  ? `${baseUrl}?token=${encodeURIComponent(browserToken)}`
  : baseUrl;

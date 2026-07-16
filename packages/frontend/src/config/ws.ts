// 自动检测：根据页面协议选择 ws/wss，通过 nginx 反向代理时自动走同域
const host = window.location.hostname;
const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const baseUrl = import.meta.env.VITE_WS_URL || `${protocol}://${host}/ws/browser`;

export function getWsUrl(): string {
  // 认证走 httpOnly cookie：浏览器在 WS 握手时自动携带同站 cookie，URL 不再附带 token
  return baseUrl;
}

// 自动检测：根据页面协议选择 ws/wss，通过 nginx 反向代理时自动走同域
const host = window.location.hostname;
const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const baseUrl = import.meta.env.VITE_WS_URL || `${protocol}://${host}/ws/browser`;

export function getWsUrl(sessionToken: string | null): string {
  return sessionToken ? `${baseUrl}?token=${encodeURIComponent(sessionToken)}` : baseUrl;
}

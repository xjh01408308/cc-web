// 全局时间戳——所有 console 输出前自动加上时间，方便定位问题发生时刻
const _log = console.log.bind(console);
const _error = console.error.bind(console);
const _warn = console.warn.bind(console);
function ts(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
console.log = (...args: unknown[]) => _log(`[${ts()}]`, ...args);
console.error = (...args: unknown[]) => _error(`[${ts()}]`, ...args);
console.warn = (...args: unknown[]) => _warn(`[${ts()}]`, ...args);

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RELAY_PORT, RELAY_BROWSER_TOKEN, STATIC_DIR } from './config.js';
import { serveStatic } from './static.js';
import { handleBrowserConnection, handleLocalConnection, requestLocal, getOnlineNodes, isNodePasswordRequired } from './ws-relay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(__dirname, STATIC_DIR);

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  if (status >= 400) {
    console.warn(`HTTP ${status}: ${(data as { error?: string })?.error || 'unknown'}`);
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function getQueryParam(req: http.IncomingMessage, name: string): string | undefined {
  const url = req.url || '';
  const idx = url.indexOf('?');
  if (idx === -1) return undefined;
  const params = new URLSearchParams(url.slice(idx));
  return params.get(name) || undefined;
}

const server = http.createServer((req, res) => {
  // 节点列表 API
  if (req.url?.startsWith('/api/nodes') && req.method === 'GET') {
    jsonResponse(res, getOnlineNodes());
    return;
  }

  // 项目列表 API
  if (req.url?.startsWith('/api/projects') && req.method === 'GET') {
    const nodeId = getQueryParam(req, 'nodeId');
    // 指定节点需密码 → 拦截；未指定节点但首个在线节点需密码 → 也拦截
    const targetNodeId = nodeId || getOnlineNodes()[0]?.nodeId;
    if (targetNodeId && isNodePasswordRequired(targetNodeId)) {
      jsonResponse(res, { error: 'auth_required', message: '此节点需要密码认证' }, 401);
      return;
    }
    requestLocal({ type: 'list_projects' }, nodeId)
      .then((msg) => {
        const data = msg as { projects?: unknown };
        jsonResponse(res, data.projects || []);
      })
      .catch((err: Error) => jsonResponse(res, { error: err.message }, 503));
    return;
  }

  // 会话列表 API
  if (req.url?.startsWith('/api/sessions') && req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const projectId = url.searchParams.get('projectId') || undefined;
    const nodeId = url.searchParams.get('nodeId') || undefined;
    const targetNodeId = nodeId || getOnlineNodes()[0]?.nodeId;
    if (targetNodeId && isNodePasswordRequired(targetNodeId)) {
      jsonResponse(res, { error: 'auth_required', message: '此节点需要密码认证' }, 401);
      return;
    }
    requestLocal({ type: 'list_sessions', projectId }, nodeId)
      .then((msg) => {
        const data = msg as { sessions?: unknown };
        jsonResponse(res, data.sessions || []);
      })
      .catch((err: Error) => jsonResponse(res, { error: err.message }, 503));
    return;
  }

  serveStatic(staticDir, req, res);
});

// WebSocket: 浏览器连接 → /ws/browser
const browserWss = new WebSocketServer({ noServer: true });
// WebSocket: 本地服务连接 → /ws/local
const localWss = new WebSocketServer({ noServer: true });

function getClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'] as string | undefined;
  if (forwarded) return forwarded.split(',')[0].trim();
  const raw = req.socket.remoteAddress || 'unknown';
  // 去掉 IPv4-mapped IPv6 前缀
  return raw.replace(/^::ffff:/i, '');
}

server.on('upgrade', (req, socket, head) => {
  const ip = getClientIp(req);
  if (req.url?.startsWith('/ws/browser')) {
    if (RELAY_BROWSER_TOKEN) {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (token !== RELAY_BROWSER_TOKEN) {
        console.warn(`[relay] 浏览器 WebSocket 认证失败: token 不匹配 | IP: ${ip}`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    browserWss.handleUpgrade(req, socket, head, (ws) => {
      handleBrowserConnection(ws, ip);
    });
  } else if (req.url === '/ws/local') {
    localWss.handleUpgrade(req, socket, head, (ws) => {
      handleLocalConnection(ws, ip);
    });
  } else {
    socket.destroy();
  }
});

function shutdown() {
  console.log('\n正在关闭中转服务...');
  browserWss.close();
  localWss.close();
  server.close(() => {
    console.log('中转服务已停止');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(RELAY_PORT, () => {
  console.log(`cc-web relay 已启动: http://localhost:${RELAY_PORT}`);
  console.log(`  WebSocket (浏览器): ws://localhost:${RELAY_PORT}/ws/browser`);
  console.log(`  WebSocket (本地服务): ws://localhost:${RELAY_PORT}/ws/local`);
  console.log(`  静态文件目录: ${staticDir}`);
  if (!RELAY_BROWSER_TOKEN) {
    console.warn(`  [安全提示] 未设置 RELAY_BROWSER_TOKEN，浏览器 WebSocket 无需认证。`);
    console.warn(`  建议在生产环境中设置 RELAY_BROWSER_TOKEN 和 VITE_BROWSER_TOKEN。`);
  }
});

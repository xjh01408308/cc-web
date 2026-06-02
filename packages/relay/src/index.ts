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
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { RELAY_PORT, RELAY_BROWSER_TOKEN, RELAY_PASSWORD, STATIC_DIR, isDevMode, isUsingDefaultRelayToken } from './config.js';
import { serveStatic } from './static.js';
import { handleBrowserConnection, handleLocalConnection, requestLocal, getOnlineNodes, isNodePasswordRequired } from './ws-relay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(__dirname, STATIC_DIR);

// ---- Session Token 管理 ----
const sessionTokens = new Map<string, number>(); // token → createdAt
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 小时

setInterval(() => {
  const now = Date.now();
  for (const [token, created] of sessionTokens) {
    if (now - created > SESSION_TTL) sessionTokens.delete(token);
  }
}, 5 * 60 * 1000);

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  if (status >= 400) {
    console.warn(`HTTP ${status}: ${(data as { error?: string })?.error || 'unknown'}`);
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isDevMode()) {
    headers['Access-Control-Allow-Origin'] = '*';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function getQueryParam(req: http.IncomingMessage, name: string): string | undefined {
  const url = req.url || '';
  const idx = url.indexOf('?');
  if (idx === -1) return undefined;
  const params = new URLSearchParams(url.slice(idx));
  return params.get(name) || undefined;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // OPTIONS 预检
  if (req.method === 'OPTIONS') {
    const headers: Record<string, string> = { 'Access-Control-Max-Age': '86400' };
    if (isDevMode()) {
      headers['Access-Control-Allow-Origin'] = '*';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
    }
    res.writeHead(204, headers);
    res.end();
    return;
  }

  // 登录端点
  if (req.url?.startsWith('/api/login') && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { password } = JSON.parse(body || '{}');
      if (!RELAY_PASSWORD || password === RELAY_PASSWORD) {
        const token = randomBytes(32).toString('hex');
        sessionTokens.set(token, Date.now());
        jsonResponse(res, { token });
      } else {
        jsonResponse(res, { error: '密码错误' }, 401);
      }
    } catch {
      jsonResponse(res, { error: '请求格式错误' }, 400);
    }
    return;
  }

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
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    // session token 优先验证
    if (token && sessionTokens.has(token)) {
      browserWss.handleUpgrade(req, socket, head, (ws) => {
        handleBrowserConnection(ws, ip);
      });
      return;
    }
    // 回退到旧式 RELAY_BROWSER_TOKEN（向后兼容）
    if (RELAY_BROWSER_TOKEN && token === RELAY_BROWSER_TOKEN) {
      browserWss.handleUpgrade(req, socket, head, (ws) => {
        handleBrowserConnection(ws, ip);
      });
      return;
    }
    // 开发模式且无 RELAY_PASSWORD → 放行
    if (isDevMode() && !RELAY_PASSWORD) {
      browserWss.handleUpgrade(req, socket, head, (ws) => {
        handleBrowserConnection(ws, ip);
      });
      return;
    }
    console.warn(`[relay] 浏览器 WebSocket 认证失败: 无有效 token | IP: ${ip}`);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
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

server.listen(RELAY_PORT, '127.0.0.1', () => {
  console.log(`cc-web relay 已启动: http://localhost:${RELAY_PORT}`);
  console.log(`  WebSocket (浏览器): ws://localhost:${RELAY_PORT}/ws/browser`);
  console.log(`  WebSocket (本地服务): ws://localhost:${RELAY_PORT}/ws/local`);
  console.log(`  静态文件目录: ${staticDir}`);
  if (isDevMode()) {
    console.warn('════════════════════════════════════════════════════════');
    console.warn('  [DEV MODE] 开发模式 (NODE_ENV != "production")');
    if (!RELAY_PASSWORD) {
      console.warn('  [INSECURE] RELAY_PASSWORD 为空 — 浏览器登录无需密码');
    }
    if (isUsingDefaultRelayToken()) {
      console.warn('  [INSECURE] RELAY_TOKEN 使用默认值 "dev-token" — 节点注册不安全');
    }
    console.warn('  公网部署时请设置 NODE_ENV=production 并配置所有 token');
    console.warn('════════════════════════════════════════════════════════');
  }
});

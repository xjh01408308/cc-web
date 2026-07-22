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
import { RELAY_PORT, RELAY_BROWSER_TOKEN, STATIC_DIR, INITIAL_ADMIN_USER, INITIAL_ADMIN_PASSWORD, isDevMode, isUsingDefaultRelayToken } from './config.js';
import { serveStatic } from './static.js';
import { handleBrowserConnection, handleLocalConnection, requestLocal, getOnlineNodes, isNodePasswordRequired } from './ws-relay.js';
import { UserStore, DEFAULT_USER_DB_PATH, type UserRole } from './user-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(__dirname, STATIC_DIR);

// ---- 用户表（多用户登录）+ 首 admin seed ----
// 持久化到 packages/relay/data/cc-web.db（data/ 已 gitignore）。首启 users 表为空时幂等建首个 admin。
const userStore = new UserStore(DEFAULT_USER_DB_PATH);
const seedResult = userStore.seedInitialAdmin(INITIAL_ADMIN_USER, INITIAL_ADMIN_PASSWORD);
if (seedResult.seeded) console.log(`[relay] 已创建首个管理员账户: ${seedResult.username}`);

// ---- Session Token 管理 ----
// token → session。session 携带当前登录用户身份（userId / username / role），
// HTTP 校验与 WS 握手均经 getSession 读取（issue #21 验收点）。
interface Session {
  userId: string;
  username: string;
  role: UserRole;
  createdAt: number;
}
const sessionTokens = new Map<string, Session>(); // token → session
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 小时

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessionTokens) {
    if (now - session.createdAt > SESSION_TTL) sessionTokens.delete(token);
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

const SESSION_COOKIE = 'cc_web_session';

function readSessionCookie(req: http.IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
}

// 是否经 HTTPS 到达（直接 TLS 或 nginx TLS 终止）——决定 cookie 是否加 Secure
function isSecureRequest(req: http.IncomingMessage): boolean {
  if (String(req.headers['x-forwarded-proto'] || '').includes('https')) return true;
  // req.socket 在 TLS 下实为 TLSSocket，类型层面用 as 断言访问 encrypted
  return Boolean((req.socket as unknown as { encrypted?: boolean }).encrypted);
}

function setSessionCookie(res: http.ServerResponse, token: string, req: http.IncomingMessage): void {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL / 1000)}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res: http.ServerResponse, req: http.IncomingMessage): void {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecureRequest(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function getSession(req: http.IncomingMessage): Session | null {
  // dev 模式放行（本地开发免登录）：返回 synthetic admin 身份，HTTP/WS 均据此识别为已登录。
  if (isDevMode()) return { userId: 'dev', username: 'dev', role: 'admin', createdAt: Date.now() };
  // 优先 httpOnly cookie（浏览器路径，token 不暴露给 JS）
  const cookieToken = readSessionCookie(req);
  if (cookieToken) {
    const s = sessionTokens.get(cookieToken);
    if (s) return s;
  }
  // 兼容 Authorization Bearer（非浏览器客户端）
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) {
    const s = sessionTokens.get(auth.slice(7));
    if (s) return s;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  // OPTIONS 预检
  if (req.method === 'OPTIONS') {
    const headers: Record<string, string> = { 'Access-Control-Max-Age': '86400' };
    if (isDevMode()) {
      headers['Access-Control-Allow-Origin'] = '*';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    }
    res.writeHead(204, headers);
    res.end();
    return;
  }

  // 登录端点：用户名 + 密码查 users 表（scrypt 校验），通过后下发 httpOnly cookie。
  // dev 模式下 getSession 旁路放行，但本端点仍走真实查表，保证登录链路始终被覆盖。
  if (req.url?.startsWith('/api/login') && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body || '{}') as { username?: unknown; password?: unknown };
      const username = typeof parsed.username === 'string' ? parsed.username : '';
      const password = typeof parsed.password === 'string' ? parsed.password : '';
      const user = userStore.authenticate(username, password);
      if (user) {
        const token = randomBytes(32).toString('hex');
        sessionTokens.set(token, { userId: user.id, username: user.username, role: user.role, createdAt: Date.now() });
        setSessionCookie(res, token, req);
        jsonResponse(res, { ok: true });
      } else {
        jsonResponse(res, { error: '用户名或密码错误' }, 401);
      }
    } catch {
      jsonResponse(res, { error: '请求格式错误' }, 400);
    }
    return;
  }

  // 节点列表 API
  if (req.url?.startsWith('/api/nodes') && req.method === 'GET') {
    if (!getSession(req)) {
      jsonResponse(res, { error: '未认证' }, 401);
      return;
    }
    jsonResponse(res, getOnlineNodes());
    return;
  }

  // 项目列表 API
  if (req.url?.startsWith('/api/projects') && req.method === 'GET') {
    if (!getSession(req)) {
      jsonResponse(res, { error: '未认证' }, 401);
      return;
    }
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
    if (!getSession(req)) {
      jsonResponse(res, { error: '未认证' }, 401);
      return;
    }
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

  // 登出端点：作废 session 并过期 cookie
  if (req.url?.startsWith('/api/logout') && req.method === 'POST') {
    const token = readSessionCookie(req);
    if (token) sessionTokens.delete(token);
    clearSessionCookie(res, req);
    jsonResponse(res, { ok: true });
    return;
  }

  // 会话探测：前端据此判断 httpOnly cookie 是否仍有效（cookie 不可被 JS 读取）。
  // 同时回传当前登录用户身份（HTTP 校验可读到 userId/role，见 issue #21 验收点）。
  if (req.url?.startsWith('/api/session') && req.method === 'GET') {
    const session = getSession(req);
    if (!session) {
      jsonResponse(res, { error: '未认证' }, 401);
      return;
    }
    jsonResponse(res, { ok: true, user: { username: session.username, role: session.role } });
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
    // session 走 httpOnly cookie（浏览器在 WS 握手时自动携带同站 cookie）；getSession 统一判定
    // （dev 模式旁路放行）。握手处即可读到当前用户身份（userId/role）。
    if (getSession(req)) {
      browserWss.handleUpgrade(req, socket, head, (ws) => {
        handleBrowserConnection(ws, ip);
      });
      return;
    }
    // 回退到旧式 RELAY_BROWSER_TOKEN（非浏览器 / 旧式客户端，仍走 query）
    const queryToken = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (RELAY_BROWSER_TOKEN && queryToken === RELAY_BROWSER_TOKEN) {
      browserWss.handleUpgrade(req, socket, head, (ws) => {
        handleBrowserConnection(ws, ip);
      });
      return;
    }
    console.warn(`[relay] 浏览器 WebSocket 认证失败: 无有效 session | IP: ${ip}`);
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
    console.warn('  [DEV MODE] 浏览器登录已旁路（synthetic admin 身份）');
    if (isUsingDefaultRelayToken()) {
      console.warn('  [INSECURE] RELAY_TOKEN 使用默认值 "dev-token" — 节点注册不安全');
    }
    console.warn('  公网部署时请设置 NODE_ENV=production 并配置所有 token');
    console.warn('════════════════════════════════════════════════════════');
  }
});

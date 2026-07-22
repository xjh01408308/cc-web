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
import { RELAY_PORT, RELAY_BROWSER_TOKEN, STATIC_DIR, INITIAL_ADMIN_USER, INITIAL_ADMIN_PASSWORD, isDevMode } from './config.js';
import { serveStatic } from './static.js';
import { handleBrowserConnection, handleLocalConnection, requestLocal, getOnlineNodesForUser, initRelay } from './ws-relay.js';
import { UserStore, DEFAULT_USER_DB_PATH, type UserRole } from './user-store.js';
import { NodeStore, DEFAULT_NODE_DB_PATH } from './node-store.js';
import { AssignmentStore, DEFAULT_ASSIGNMENT_DB_PATH } from './assignment-store.js';
import { canOperateNode } from './authz.js';
import { handleAdminUsersRoute, handleAdminNodesRoute } from './admin-routes.js';
import { jsonResponse, readBody } from './http-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(__dirname, STATIC_DIR);

// ---- 用户表（多用户登录）+ 首 admin seed ----
// 持久化到 packages/relay/data/cc-web.db（data/ 已 gitignore）。首启 users 表为空时幂等建首个 admin。
const userStore = new UserStore(DEFAULT_USER_DB_PATH);
const seedResult = userStore.seedInitialAdmin(INITIAL_ADMIN_USER, INITIAL_ADMIN_PASSWORD);
if (seedResult.seeded) console.log(`[relay] 已创建首个管理员账户: ${seedResult.username}`);

// ---- Node 预注册表（local 注册凭证，见 ADR-0004）----
// 同库不同表（nodes）。管理员在 /admin 预注册 Node 生成 (nodeId, nodeSecret)；local register 据此校验。
const nodeStore = new NodeStore(DEFAULT_NODE_DB_PATH);

// ---- Assignment 授权表（relay 侧 user↔Node 多对多，见 ADR-0005）----
// 同库不同表（assignments）。唯一操作授权机制：被分配的 user 可完全操作该 Node。
const assignmentStore = new AssignmentStore(DEFAULT_ASSIGNMENT_DB_PATH);

// 把 nodeStore / assignmentStore 注入连接处理单例（必须在 server.listen / 任何 WS 连接前完成）。
initRelay(nodeStore, assignmentStore);

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

function getQueryParam(req: http.IncomingMessage, name: string): string | undefined {
  const url = req.url || '';
  const idx = url.indexOf('?');
  if (idx === -1) return undefined;
  const params = new URLSearchParams(url.slice(idx));
  return params.get(name) || undefined;
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

/**
 * 显式 nodeId 的 Assignment 访问控制（/api/projects /api/sessions 共用，见 ADR-0005）。
 * 复用 authz.canOperateNode 集中策略；admin 短路免 DB 查询。
 * 离线与否不在此判定（离线交由 requestLocal 报 503）。返回错误文案（拒绝）或 null（放行）。
 * nodeId 为空时放行（由调用方 fallback 到可见节点）。
 */
function checkNodeAccess(session: Session, nodeId: string | undefined, store: AssignmentStore): string | null {
  if (!nodeId || session.role === 'admin') return null;
  const assigned = new Set(store.assignedNodeIds(session.userId));
  return canOperateNode(session.role, nodeId, assigned) ? null : '无权访问此节点';
}

const server = http.createServer(async (req, res) => {
  // OPTIONS 预检
  if (req.method === 'OPTIONS') {
    const headers: Record<string, string> = { 'Access-Control-Max-Age': '86400' };
    if (isDevMode()) {
      headers['Access-Control-Allow-Origin'] = '*';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    }
    res.writeHead(204, headers);
    res.end();
    return;
  }

  // /api/admin/* —— 管理路由（issue #22 用户 / #23 Node）：解析 session 后依次委托，
  // 守卫（401/403）与 CRUD 逻辑均在 admin-routes 内。各处理器返回 true 表已处理。
  if (req.url?.startsWith('/api/admin/')) {
    const session = getSession(req);
    if (await handleAdminUsersRoute(req, res, { session, userStore, assignmentStore })) return;
    if (await handleAdminNodesRoute(req, res, { session, nodeStore, assignmentStore })) return;
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
        jsonResponse(res, { ok: true, user: { username: user.username, role: user.role } });
      } else {
        jsonResponse(res, { error: '用户名或密码错误' }, 401);
      }
    } catch {
      jsonResponse(res, { error: '请求格式错误' }, 400);
    }
    return;
  }

  // 节点列表 API（按登录用户过滤：admin 全部；user 仅 assigned ∩ online）
  if (req.url?.startsWith('/api/nodes') && req.method === 'GET') {
    const session = getSession(req);
    if (!session) {
      jsonResponse(res, { error: '未认证' }, 401);
      return;
    }
    jsonResponse(res, getOnlineNodesForUser(session.userId, session.role));
    return;
  }

  // 项目列表 API（Assignment 访问控制：user 只能访问被分配的节点）
  if (req.url?.startsWith('/api/projects') && req.method === 'GET') {
    const session = getSession(req);
    if (!session) {
      jsonResponse(res, { error: '未认证' }, 401);
      return;
    }
    const nodeId = getQueryParam(req, 'nodeId');
    const gateErr = checkNodeAccess(session, nodeId, assignmentStore);
    if (gateErr) { jsonResponse(res, { error: gateErr }, 403); return; }
    // 未指定节点 → 取该用户可见的首个在线节点（user 为 assigned ∩ online）
    const targetNodeId = nodeId || getOnlineNodesForUser(session.userId, session.role)[0]?.nodeId;
    if (!targetNodeId) {
      jsonResponse(res, { error: '没有可用的在线节点' }, 503);
      return;
    }
    requestLocal({ type: 'list_projects' }, targetNodeId)
      .then((msg) => {
        const data = msg as { projects?: unknown };
        jsonResponse(res, data.projects || []);
      })
      .catch((err: Error) => jsonResponse(res, { error: err.message }, 503));
    return;
  }

  // 会话列表 API（Assignment 访问控制：user 只能访问被分配的节点）
  if (req.url?.startsWith('/api/sessions') && req.method === 'GET') {
    const session = getSession(req);
    if (!session) {
      jsonResponse(res, { error: '未认证' }, 401);
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const projectId = url.searchParams.get('projectId') || undefined;
    const nodeId = url.searchParams.get('nodeId') || undefined;
    const gateErr = checkNodeAccess(session, nodeId, assignmentStore);
    if (gateErr) { jsonResponse(res, { error: gateErr }, 403); return; }
    const targetNodeId = nodeId || getOnlineNodesForUser(session.userId, session.role)[0]?.nodeId;
    if (!targetNodeId) {
      jsonResponse(res, { error: '没有可用的在线节点' }, 503);
      return;
    }
    requestLocal({ type: 'list_sessions', projectId }, targetNodeId)
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
    // （dev 模式旁路放行）。握手处即可读到当前用户身份（userId/role），透传给连接处理用于
    // 按用户过滤节点列表 + Assignment 操作授权（见 ADR-0005）。
    const session = getSession(req);
    if (session) {
      browserWss.handleUpgrade(req, socket, head, (ws) => {
        handleBrowserConnection(ws, ip, { userId: session.userId, username: session.username, role: session.role });
      });
      return;
    }
    // 回退到旧式 RELAY_BROWSER_TOKEN（非浏览器 / 旧式客户端，仍走 query）；无 session → 默认 admin 身份。
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
    console.warn('  [DEV MODE] local 注册需先在 /admin 预注册 Node 获得 nodeSecret');
    console.warn('  公网部署时请设置 NODE_ENV=production');
    console.warn('════════════════════════════════════════════════════════');
  }
});

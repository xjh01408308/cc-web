// HTTP 响应/请求体工具，供 index.ts 路由层与 admin-routes（及后续管理路由）共用，
// 避免每个处理器各自 fork 一份 jsonResponse/readBody（DRY）。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isDevMode } from './config.js';

/** 统一 JSON 响应：>=400 记录告警；dev 模式附带 CORS 头（供非同源调试客户端）。 */
export function jsonResponse(res: ServerResponse, data: unknown, status = 200): void {
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

/** 读取请求体为 UTF-8 字符串（收集所有 data 块后 resolve）。 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

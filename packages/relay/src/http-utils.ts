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

/** readBody 超过 maxBytes 时抛出；调用方 catch 后返回 413（防内存耗尽 DoS）。 */
export class PayloadTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`请求体超过 ${limit} 字节上限`);
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * 读取请求体为 UTF-8 字符串（收集所有 data 块后 resolve）。
 * 超过 maxBytes（默认 1MB）抛 PayloadTooLargeError——所有路由处理器（login/admin/me）
 * 共用本函数，默认上限对其一致生效；me-routes 识别后返回 413，其余处理器的 catch 兜底。
 */
export function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    req.on('data', (chunk: Buffer) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > maxBytes) {
        exceeded = true;
        reject(new PayloadTooLargeError(maxBytes));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!exceeded) resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', reject);
  });
}

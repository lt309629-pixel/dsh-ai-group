/**
 * AI 群 · Host 半侧：注册 /ai-group 前缀路由（页面 + JSON API），并把三家适配器接起来。
 *
 * 页面是普通 HTML/CSS/JS，经 DSH webServer 提供，由客户端插件用 iframe 嵌进 DSH 整页。
 * 浏览器自动化走本机 Edge 的 CDP，不依赖 Electron（Host 是 Node 模式的子进程）。
 * @module dsh-ai-group
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GroupChat } from './chat.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', 'assets');
const PREFIX = '/ai-group';

export const name = 'ai-group';
export const inject = ['webServer', 'llm', 'agentDefaultModel'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveAsset(res, file) {
  try {
    const data = await readFile(join(ASSETS, file));
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': data.length,
      'x-frame-options': 'SAMEORIGIN',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

export function apply(ctx) {
  const chat = new GroupChat(ctx);

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const rest = path.slice(PREFIX.length) || '/';
    try {
      if (req.method === 'GET' && (rest === '/' || rest === '/index.html')) {
        return await serveAsset(res, 'app.html');
      }
      if (req.method === 'GET' && rest === '/app.js') return await serveAsset(res, 'app.js');
      if (req.method === 'GET' && rest === '/app.css') return await serveAsset(res, 'app.css');
      if (req.method === 'GET' && rest === '/api/state') {
        return sendJson(res, 200, chat.snapshot());
      }
      if (req.method === 'GET' && rest === '/api/status') {
        const status = await chat.refreshStatus();
        return sendJson(res, 200, { ok: true, status });
      }
      if (req.method === 'POST' && rest === '/api/warm') {
        const status = await chat.warm();
        return sendJson(res, 200, { ok: true, status });
      }
      if (req.method === 'POST' && rest === '/api/send') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const result = await chat.send(body.text);
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && rest === '/api/login') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const result = await chat.openLogin(body.id);
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (req.method === 'POST' && rest === '/api/reset') {
        const result = await chat.reset();
        return sendJson(res, 200, result);
      }
      if (req.method === 'GET' && rest === '/api/ping') {
        return sendJson(res, 200, { ok: true, pid: process.pid });
      }
      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`[ai-group] ${req.method} ${path} 失败：${message}`);
      sendJson(res, 400, { ok: false, error: message });
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }),
    'ai-group: routes',
  );
  ctx.effect(() => () => chat.dispose(), 'ai-group: dispose');
}

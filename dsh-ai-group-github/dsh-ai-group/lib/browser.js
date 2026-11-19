/**
 * 浏览器驱动：自动找 Edge/Chrome，用独立配置目录 + CDP 驱动元宝和豆包网页。
 *
 * 设计要点：
 * - 不碰用户日常浏览器配置（独立 user-data-dir，登录态留在里面）；
 * - 端口自动选择并记忆，避免 9225 被占用时整个插件不可用；
 * - Host 是 Node 模式的子进程，拿不到 Electron 窗口，所以必须借系统浏览器。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 端口候选区间（避开 Chrome 常用的 9222）。 */
const PORT_RANGE = Array.from({ length: 10 }, (_, i) => 9225 + i);

/** 本进程当前使用的调试端口。 */
let activePort;
/** 并发调用 ensureBrowser 时共用同一次启动。 */
let ensuring;

/** 插件数据目录：日志、端口、浏览器配置都放这里。 */
export function dataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const dir = join(home, 'ai-group');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 专用浏览器配置目录（登录态长期保存在这里）。 */
export function browserProfileDir() {
  const dir = join(dataDir(), 'browser');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function portFile() {
  return join(dataDir(), 'browser-port.json');
}

function readSavedPort() {
  try {
    const data = JSON.parse(readFileSync(portFile(), 'utf8'));
    return Number.isInteger(data.port) ? data.port : undefined;
  } catch {
    return undefined;
  }
}

function saveSavedPort(port) {
  try {
    writeFileSync(portFile(), JSON.stringify({ port }), 'utf8');
  } catch {
    /* 写不了就每次重新探测，不影响使用 */
  }
}

/**
 * 找一个可用的 Chromium 浏览器：优先 Edge，其次是 Chrome；都没有再交给 PATH。
 * @returns {string} 可执行文件路径或命令名
 */
export function findBrowser() {
  const win = process.platform === 'win32';
  const mac = process.platform === 'darwin';
  const candidates = [];

  if (win) {
    const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      candidates.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    candidates.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    candidates.push('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
    candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  } else if (mac) {
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('microsoft-edge', 'microsoft-edge-stable', 'google-chrome', 'google-chrome-stable', 'chromium');
  }

  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate;
    } else {
      return candidate; // 交给 PATH 解析
    }
  }
  return win ? 'msedge.exe' : 'google-chrome';
}

async function fetchJson(port, path, method = 'GET', timeoutMs = 800) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: ctl.signal });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 端口上是否有活的 CDP；返回 /json/version。 */
export async function probePort(port) {
  try {
    return await fetchJson(port, '/json/version', 'GET', 700);
  } catch {
    return undefined;
  }
}

/** 端口上是不是本插件用的浏览器（有我们的聊天页面，或就是刚启动的空白页）。 */
async function looksLikeOurBrowser(port) {
  try {
    const pages = (await fetchJson(port, '/json/list', 'GET', 900)).filter((p) => p.type === 'page');
    return pages.some(
      (p) =>
        p.url.includes('doubao.com') ||
        p.url.includes('yuanbao.tencent.com') ||
        p.url === 'about:blank' ||
        p.url === '',
    );
  } catch {
    return false;
  }
}

/** 端口是否空闲（能 bind 成功）。 */
function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/** 启动浏览器并等调试端口就绪。 */
async function launchBrowser(port, log) {
  const exe = findBrowser();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${browserProfileDir()}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    'about:blank',
  ];
  log?.(`[ai-group] 启动浏览器 ${exe}（端口 ${port}）`);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {
    /* 下面用超时统一报告，避免未捕获 error 事件 */
  });
  child.unref();
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    if (await probePort(port)) return;
  }
  throw new Error(`浏览器启动超时：请确认已安装 Microsoft Edge 或 Google Chrome（当前尝试 ${exe}）`);
}

async function doEnsureBrowser(log) {
  if (activePort && (await probePort(activePort))) return activePort;

  const saved = readSavedPort();
  if (saved && (await probePort(saved))) {
    activePort = saved;
    return saved;
  }

  // 复用本插件之前拉起的实例（页面还在）
  for (const port of PORT_RANGE) {
    if ((await probePort(port)) && (await looksLikeOurBrowser(port))) {
      activePort = port;
      saveSavedPort(port);
      return port;
    }
  }

  // 找一个空闲端口启动
  for (const port of PORT_RANGE) {
    if (await probePort(port)) continue;
    if (!(await portFree(port))) continue;
    await launchBrowser(port, log);
    activePort = port;
    saveSavedPort(port);
    return port;
  }
  throw new Error('没有可用的本地调试端口（9225-9234 都被占用）');
}

/** 确保浏览器在跑，返回调试端口；并发调用共用同一次启动。 */
export function ensureBrowser(log) {
  if (!ensuring) {
    ensuring = doEnsureBrowser(log).finally(() => {
      ensuring = undefined;
    });
  }
  return ensuring;
}

/** 浏览器是否已经在跑（不主动拉起，用于状态探测）。 */
export async function browserRunning() {
  if (activePort && (await probePort(activePort))) return true;
  const saved = readSavedPort();
  if (saved && (await probePort(saved))) return true;
  for (const port of PORT_RANGE) {
    if ((await probePort(port)) && (await looksLikeOurBrowser(port))) return true;
  }
  return false;
}

/** 极简 CDP 连接。 */
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 8000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); }, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已断开'));
      this.pending.clear();
    });
  }

  async send(method, params = {}, timeoutMs = 15000) {
    await Promise.race([
      this.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('CDP 打开超时')), 8000)),
    ]);
    if (this.closed) throw new Error('CDP 连接已关闭');
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 12000) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      timeoutMs,
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面脚本出错');
    }
    return r.result.value;
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/** 一个站点标签页的连接；断线时自动重建一次。 */
export class SitePage {
  constructor(origin, url, log) {
    this.origin = origin;
    this.url = url;
    this.log = log;
    this.cdp = undefined;
    this.port = undefined;
    this.targetId = undefined;
  }

  async connect() {
    if (this.cdp) {
      try {
        await this.cdp.evaluate('1+1', 3000);
        return this.cdp;
      } catch {
        this.close();
      }
    }
    this.port = await ensureBrowser(this.log);
    let target;
    let pages = [];
    try {
      pages = (await fetchJson(this.port, '/json/list')).filter((p) => p.type === 'page');
    } catch {
      pages = [];
    }
    target = pages.find((p) => p.url.startsWith(this.origin));
    if (!target) {
      // 先建空页再显式导航：部分版本对 /json/new?url= 的加载时机不稳定
      target = await fetchJson(this.port, '/json/new?about:blank', 'PUT');
    }
    this.targetId = target.id;
    this.cdp = new CDP(target.webSocketDebuggerUrl);
    await this.cdp.ready;
    await this.cdp.send('Page.enable').catch(() => {});
    await this.cdp.send('Runtime.enable').catch(() => {});

    let href = '';
    for (let i = 0; i < 40; i += 1) {
      href = (await this.cdp.evaluate('location.href', 5000).catch(() => '')) || '';
      if (href.startsWith(this.origin)) break;
      await sleep(300);
    }
    if (!href.startsWith(this.origin)) {
      await this.cdp.send('Page.navigate', { url: this.url });
    }
    for (let i = 0; i < 60; i += 1) {
      const state = await this.cdp
        .evaluate('({ href: location.href, ready: document.readyState })', 5000)
        .catch(() => ({ href: '', ready: 'loading' }));
      if (state.href && state.href.startsWith(this.origin) && state.ready !== 'loading') break;
      await sleep(500);
    }
    return this.cdp;
  }

  async eval(expression, timeoutMs = 12000) {
    const cdp = await this.connect();
    try {
      return await cdp.evaluate(expression, timeoutMs);
    } catch (error) {
      // 页面被关掉/崩溃/连接卡死：重建一次
      this.log?.(`[ai-group] 页面重连：${error?.message || error}`);
      this.lastError = String(error?.message || error);
      this.close();
      const fresh = await this.connect();
      return fresh.evaluate(expression, timeoutMs);
    }
  }

  /** 关掉当前 CDP 连接，下次使用时重连。 */
  close() {
    try { this.cdp?.close(); } catch { /* ignore */ }
    this.cdp = undefined;
  }

  /** 把浏览器窗口拉到前台（登录用）。 */
  async focus() {
    try {
      const cdp = await this.connect();
      await cdp.send('Page.bringToFront');
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: this.targetId });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await cdp.send('Page.bringToFront');
      return true;
    } catch (error) {
      this.log?.(`[ai-group] 聚焦窗口失败：${error?.message || error}`);
      return false;
    }
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

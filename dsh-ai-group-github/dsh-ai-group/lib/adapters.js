/**
 * 三家 AI 的适配器：元宝 / 豆包走网页（CDP），DeepSeek 走 DSH 的 LLM 服务。
 *
 * 每个适配器只做三件事：确认可用（含登录）、把一句话发出去、把回复读回来。
 * 始终成立：回复以「新出现的消息节点」为准，绝不把历史消息当成这次回答。
 */
import { sleep } from './browser.js';

function tidy(text) {
  return String(text || '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从标题栏/正文里识别登录墙。 */
function looksLikeLoginWall(text) {
  return /未登录|扫码登录|登录后(才能|即可)|请先登录/.test(text || '');
}

/**
 * 等编辑器真正就绪（SPA 冷启动时 DOM 会先出现再被重挂载）。
 * @returns {Promise<boolean>}
 */
async function waitEditor(page, selector, timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await page.eval(`!!document.querySelector(${JSON.stringify(selector)})`, 6000).catch(() => false);
    if (ok) {
      await sleep(700);
      return true;
    }
    await sleep(500);
  }
  return false;
}

/**
 * 清空并写入编辑器内容（不依赖窗口焦点：在页面内用 execCommand 触发真实的 input 事件）。
 * 冷启动页面可能重挂载编辑器，所以写入后会复查一次，丢了就重试。
 * @returns {Promise<boolean>} 写入后编辑器里是否包含目标文本
 */
async function fillEditor(page, selector, text) {
  const snippet = text.slice(0, 8);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const filled = await page.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      document.execCommand('selectAll');
      document.execCommand('delete');
      const ok = document.execCommand('insertText', false, ${JSON.stringify(text)});
      return ok && (el.innerText || el.value || '').includes(${JSON.stringify(snippet)});
    })()`, 10000).catch(() => false);
    if (!filled) {
      await sleep(500);
      continue;
    }
    await sleep(400);
    const still = await page.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return !!el && (el.innerText || el.value || '').includes(${JSON.stringify(snippet)});
    })()`, 6000).catch(() => false);
    if (still) return true;
    await sleep(600);
  }
  return false;
}


/**
 * 轮询等待「新消息」出现并稳定。
 * @param {object} opts
 * @param {(page) => Promise<string>} opts.read 读取第 baseline 条之后的最新回复文本
 * @param {number} opts.baseline 发送前的消息条数
 */
/**
 * 轮询等待「新回复」出现并稳定：以最后一条 AI 消息的文本变化为准（列表会虚拟化，条数不可靠）。
 */
async function waitReply(page, { readExpr, baselineText, onUpdate, timeoutMs = 75000, quietMs = 1600 }) {
  const started = Date.now();
  let lastText = '';
  let stableSince = 0;
  let errors = 0;
  while (Date.now() - started < timeoutMs) {
    await sleep(500);
    try {
      const text = (await page.eval(readExpr, 8000)) || '';
      errors = 0;
      const clean = text.trim();
      const bodyText = clean.split('\u0001')[0].trim();
      const changed = bodyText !== '' && clean !== baselineText.trim();
      if (changed && clean !== lastText) {
        lastText = clean;
        stableSince = Date.now();
        onUpdate?.(clean);
      } else if (changed && Date.now() - stableSince > quietMs) {
        return clean;
      }
    } catch (error) {
      errors += 1;
      if (errors >= 4) throw new Error(`读取${page.origin} 失败：${error?.message || error}`);
      page.close?.();
    }
    if (Date.now() - started > 20000) {
      const body = await page.eval('document.body.innerText', 6000).catch(() => '');
      if (looksLikeLoginWall(body)) throw new Error('需要登录');
    }
  }
  const body = await page.eval('document.body.innerText', 6000).catch(() => '');
  if (looksLikeLoginWall(body)) throw new Error('需要登录');
  if (lastText) return lastText;
  throw new Error('等待回复超时');
}

/** 豆包（字节跳动）：游客可用，首次发送会新建会话。 */
export class Doubao {
  constructor(page, log) {
    this.id = 'doubao';
    this.page = page;
    this.log = log;
    this.editor = '.tiptap[contenteditable="true"], textarea[data-testid="chat_input_input"]';
    this.receive = '[data-testid="receive_message"]';
  }

  async status() {
    try {
      const r = await this.page.eval(`(() => ({
        ready: !!document.querySelector(${JSON.stringify(this.editor)}),
        login: /未登录|扫码登录/.test(document.body.innerText || ''),
        href: location.href,
      }))()`);
      return { ...r, online: r.ready };
    } catch (error) {
      return { ready: false, online: false, error: String(error?.message || error) };
    }
  }

  async focus() {
    return this.page.focus();
  }

  async send(text, onUpdate) {
    if (!(await waitEditor(this.page, this.editor))) throw new Error('豆包页面还没准备好，请稍后重试');
    // 给当前最后一条 AI 消息打标：新回复若是新节点，会以 "new" 区分；文本相同也能认出来
    const baselineText = (await this.page.eval(`(() => {
      const list = [...document.querySelectorAll(${JSON.stringify(this.receive)})];
      const last = list[list.length - 1];
      if (!last) return '';
      last.dataset.aiGroupSeen = '1';
      const box = last.querySelector('[data-testid="message_text_content"]');
      return ((box ? box.innerText : last.innerText) || '').trim() + '\\u0001old';
    })()`)) || '';
    const filled = await fillEditor(this.page, this.editor, text);
    if (!filled) throw new Error('没有找到豆包的输入框');
    const sent = await this.page.eval(`(() => {
      const btn = document.querySelector('[data-testid="chat_input_send_button"]');
      if (btn && !btn.disabled) { btn.click(); return 'click'; }
      const el = document.querySelector(${JSON.stringify(this.editor)});
      if (!el) return 'no-editor';
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      return 'enter';
    })()`);
    this.log?.(`[ai-group] 豆包发送方式：${sent}`);
    const composite = await waitReply(this.page, {
      readExpr: `(() => {
        const list = [...document.querySelectorAll(${JSON.stringify(this.receive)})];
        const last = list[list.length - 1];
        if (!last) return '';
        const box = last.querySelector('[data-testid="message_text_content"]');
        const text = ((box ? box.innerText : last.innerText) || '').trim();
        return text + '\\u0001' + (last.dataset.aiGroupSeen ? 'old' : 'new');
      })()`,
      baselineText,
      onUpdate: (value) => { const t = tidy(String(value).split('\u0001')[0]); if (t) onUpdate?.(t); },
    });
    return tidy(String(composite).split('\u0001')[0]);
  }
}

/** 元宝（腾讯）：需要登录；编辑器是 Quill，发送按钮是 div#yuanbao-send-btn。 */
export class Yuanbao {
  constructor(page, log) {
    this.id = 'yuanbao';
    this.page = page;
    this.log = log;
    this.editor = '.ql-editor';
    this.item = '.agent-chat__list__item--ai';
  }

  async status() {
    try {
      const r = await this.page.eval(`(() => {
        const body = document.body.innerText || '';
        return {
          ready: !!document.querySelector(${JSON.stringify(this.editor)}) && !/未登录/.test(body),
          login: /未登录|扫码登录/.test(body),
          href: location.href,
        };
      })()`);
      return { ...r, online: r.ready };
    } catch (error) {
      return { ready: false, online: false, error: String(error?.message || error) };
    }
  }

  async focus() {
    return this.page.focus();
  }

  async send(text, onUpdate) {
    if (!(await waitEditor(this.page, this.editor))) throw new Error('元宝页面还没准备好（可能未登录），请稍后重试');
    const baselineText = (await this.page.eval(`(() => {
      const list = [...document.querySelectorAll(${JSON.stringify(this.item)})];
      const last = list[list.length - 1];
      if (!last) return '';
      last.dataset.aiGroupSeen = '1';
      return (last.innerText || '').trim() + '\\u0001old';
    })()`)) || '';
    const filled = await fillEditor(this.page, this.editor, text);
    if (!filled) throw new Error('没有找到元宝的输入框（可能未登录）');
    const sent = await this.page.eval(`(() => {
      const b = document.querySelector('#yuanbao-send-btn');
      if (b) { b.click(); return 'click'; }
      const el = document.querySelector(${JSON.stringify(this.editor)});
      if (!el) return 'no-editor';
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      return 'enter';
    })()`);
    this.log?.(`[ai-group] 元宝发送方式：${sent}`);
    const composite = await waitReply(this.page, {
      readExpr: `(() => {
        const list = [...document.querySelectorAll(${JSON.stringify(this.item)})];
        const last = list[list.length - 1];
        if (!last) return '';
        return (last.innerText || '').trim() + '\\u0001' + (last.dataset.aiGroupSeen ? 'old' : 'new');
      })()`,
      baselineText,
      onUpdate: (value) => { const t = tidy(String(value).split('\u0001')[0]); if (t) onUpdate?.(t); },
    });
    return tidy(String(composite).split('\u0001')[0]);
  }
}

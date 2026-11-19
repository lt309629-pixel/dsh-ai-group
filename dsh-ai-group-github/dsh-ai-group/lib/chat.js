/**
 * 群聊编排：一条用户消息并发问三家，把三家的回复各自流式写回同一个消息列表。
 *
 * 不负责 HTTP 与页面渲染（那在 index.js 与 assets/），也不负责浏览器/CDP 细节（browser.js）。
 * 始终成立：同一时刻只跑一轮；单个成员失败只影响它自己的消息，不打断另外两家。
 */
import { BlockAssembler, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { Doubao, Yuanbao } from './adapters.js';
import { SitePage, browserRunning } from './browser.js';

const SYSTEM_PROMPT =
  '你是「AI 群」里的 DeepSeek 成员，群里还有元宝和豆包，用户会同时问三家。' +
  '请直接用中文回答用户的问题，简洁、准确、有信息量；除非用户问你是谁，否则不要自我介绍，也不要假装自己是元宝或豆包。';

/** 群里的三个固定成员。 */
export const MEMBERS = [
  { id: 'yuanbao', name: '元宝', color: '#3b82f6', kind: 'web' },
  { id: 'deepseek', name: 'DeepSeek', color: '#6366f1', kind: 'llm' },
  { id: 'doubao', name: '豆包', color: '#f97316', kind: 'web' },
];

export class GroupChat {
  constructor(ctx) {
    this.ctx = ctx;
    this.log = (msg) => {
      try { ctx.logger?.info?.(msg); } catch { /* ignore */ }
    };
    this.messages = [];
    this.seq = 0;
    this.busy = false;
    this.dsHistory = [];
    this.pages = {
      doubao: new SitePage('https://www.doubao.com', 'https://www.doubao.com/chat/', this.log),
      yuanbao: new SitePage('https://yuanbao.tencent.com', 'https://yuanbao.tencent.com/chat/', this.log),
    };
    this.adapters = {
      doubao: new Doubao(this.pages.doubao, this.log),
      yuanbao: new Yuanbao(this.pages.yuanbao, this.log),
    };
    this.status = {
      doubao: { state: 'unknown', label: '待连接' },
      yuanbao: { state: 'unknown', label: '待连接' },
      deepseek: { state: 'ready', label: 'DSH 模型' },
    };
    this.disposed = false;
  }

  snapshot() {
    return {
      messages: this.messages,
      busy: this.busy,
      members: MEMBERS,
      status: this.status,
    };
  }

  addMessage(member, role, text, status = 'done') {
    const msg = {
      id: ++this.seq,
      who: member ? member.id : 'user',
      name: member ? member.name : '你',
      role,
      text,
      status,
      ts: Date.now(),
    };
    this.messages.push(msg);
    if (this.messages.length > 400) this.messages.splice(0, this.messages.length - 400);
    return msg;
  }

  /** 预热：提前拉起浏览器并把两个网页加载好（打开面板时调用，首条消息就不用等冷启动）。 */
  async warm() {
    await Promise.all(
      ['doubao', 'yuanbao'].map(async (id) => {
        try {
          await this.pages[id].connect();
        } catch (error) {
          this.log(`[ai-group] 预热 ${id} 失败：${error?.message || error}`);
        }
      }),
    );
    await this.refreshStatus();
    return this.status;
  }

  async refreshStatus() {
    if (!(await browserRunning())) {
      for (const id of ['doubao', 'yuanbao']) {
        if (this.status[id].state !== 'ready') this.status[id] = { state: 'offline', label: '未启动' };
      }
      return this.status;
    }
    for (const id of ['doubao', 'yuanbao']) {
      try {
        const st = await this.adapters[id].status();
        if (st.online) this.status[id] = { state: 'ready', label: '已连接' };
        else if (st.login) this.status[id] = { state: 'login', label: '需登录' };
        else this.status[id] = { state: 'offline', label: '未连接', detail: st.error || '' };
      } catch (error) {
        this.status[id] = { state: 'offline', label: '未连接', detail: String(error?.message || error) };
      }
    }
    return this.status;
  }

  /** 打开某个成员的网页窗口（用于扫码登录）。 */
  async openLogin(id) {
    const page = this.pages[id];
    if (!page) throw new Error('这个成员不需要登录');
    await this.refreshStatus();
    // 顺手点掉页面上的「登录」按钮，把二维码弹出来
    try {
      await page.eval(`(() => {
        const btns = [...document.querySelectorAll('button,div[role="button"],a')].filter((b) => b.getClientRects().length > 0);
        const hit = btns.find((b) => (b.innerText || '').trim() === '登录' || (b.getAttribute('aria-label') || '') === '登录');
        if (hit) hit.click();
        return !!hit;
      })()`, 6000);
    } catch { /* 已登录或页面结构不同都无所谓 */ }
    const ok = await page.focus();
    return { ok, status: this.status[id] };
  }

  async reset() {
    if (this.busy) throw new Error('正在回答中，稍后再开新话题');
    this.messages = [];
    this.dsHistory = [];
    for (const page of Object.values(this.pages)) {
      try {
        const cdp = await page.connect();
        await cdp.send('Page.navigate', { url: page.url });
      } catch (error) {
        this.log(`[ai-group] 重置会话失败（${page.origin}）：${error?.message || error}`);
      }
    }
    return { ok: true };
  }

  /**
   * 一轮群聊：用户一句话，三家并发。
   * @returns {Promise<{ok: true, turn: number}>}
   */
  async send(text) {
    const content = String(text || '').trim();
    if (content === '') throw new Error('消息为空');
    if (this.busy) throw new Error('上一轮还在回答中');
    this.busy = true;
    const turn = this.seq + 1;
    this.addMessage(undefined, 'user', content);
    const jobs = MEMBERS.map(async (member) => {
      const msg = this.addMessage(member, 'ai', '', 'pending');
      const onUpdate = (partial) => {
        if (this.disposed) return;
        msg.text = partial;
      };
      try {
        let reply;
        if (member.id === 'deepseek') reply = await this.askDeepSeek(content, onUpdate);
        else reply = await this.adapters[member.id].send(content, onUpdate);
        msg.text = reply;
        msg.status = 'done';
        if (member.id === 'deepseek') this.remember(content, reply);
        if (member.id !== 'deepseek') {
          this.status[member.id] = { state: 'ready', label: '已连接' };
        }
      } catch (error) {
        const detail = String(error?.message || error);
        msg.status = /需要登录/.test(detail) ? 'login' : 'error';
        msg.text = /需要登录/.test(detail) ? '需要登录元宝后才能回答' : `出错了：${detail}`;
        if (member.id !== 'deepseek') {
          this.status[member.id] = /需要登录/.test(detail)
            ? { state: 'login', label: '需登录' }
            : { state: 'error', label: '连接失败', detail };
        }
        this.log(`[ai-group] ${member.id} 失败：${detail}`);
      }
    });
    try {
      await Promise.all(jobs);
    } finally {
      this.busy = false;
    }
    return { ok: true, turn };
  }

  remember(userText, reply) {
    this.dsHistory.push({ role: 'user', text: userText });
    this.dsHistory.push({ role: 'assistant', text: reply });
    if (this.dsHistory.length > 16) this.dsHistory.splice(0, this.dsHistory.length - 16);
  }

  async askDeepSeek(text, onUpdate) {
    const llm = this.ctx.llm;
    if (!llm || typeof llm.stream !== 'function') throw new Error('DSH 的 LLM 服务不可用');
    const sel = this.ctx.agentDefaultModel?.currentSelection?.();
    if (!sel || !sel.provider || !sel.model) throw new Error('当前会话没有配置模型');

    const history = this.dsHistory.map((m) =>
      m.role === 'user'
        ? createUserMessage({ content: [{ type: 'text', text: m.text }], source: { kind: 'user' } })
        : createAssistantMessage({
            content: [{ type: 'text', text: m.text }],
            source: { provider: sel.provider, model: sel.model },
          }),
    );
    const assembler = new BlockAssembler();
    const stream = llm.stream({
      provider: sel.provider,
      model: sel.model,
      sessionId: 'dsh-ai-group',
      messages: [
        ...history,
        createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      ],
      system: SYSTEM_PROMPT,
      temperature: 1,
      signal: AbortSignal.timeout(120000),
    });
    for await (const chunk of stream) {
      assembler.push(chunk);
      const partial = assembler
        .blocks()
        .filter((b) => b.type === 'text')
        .map((b) => b.text || '')
        .join('')
        .trim();
      if (partial) onUpdate?.(partial);
    }
    const finalText = assembler
      .blocks()
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('')
      .trim();
    if (!finalText) {
      const finish = assembler.finish;
      const reason = finish?.failure?.message || finish?.kind || '模型没有返回内容';
      throw new Error(reason);
    }
    return finalText;
  }

  dispose() {
    this.disposed = true;
    for (const page of Object.values(this.pages)) {
      try { page.close?.(); } catch { /* ignore */ }
    }
  }
}

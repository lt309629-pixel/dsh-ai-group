/* AI 群 · 前端（无框架）：轮询 /api/state，按 id 增量更新消息节点。 */
(() => {
  const $ = (id) => document.getElementById(id);
  const list = $('list');
  const empty = $('empty');
  const input = $('input');
  const sendBtn = $('send');
  const stream = $('stream');
  const membersEl = $('members');
  const banner = $('banner');
  const bannerText = $('banner-text');
  const bannerAction = $('banner-action');
  const busyHint = $('busy-hint');

  const nodes = new Map();
  let state = { messages: [], busy: false, members: [], status: {} };
  let lastCount = 0;
  let toastTimer = 0;

  const COLORS = { yuanbao: '#3b82f6', deepseek: '#6d7cff', doubao: '#f97316' };
  const SHORT = { yuanbao: '元', deepseek: 'DS', doubao: '豆' };

  function toast(text) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function timeOf(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function nearBottom() {
    return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
  }

  function ensureMemberEls() {
    membersEl.innerHTML = '';
    for (const m of state.members) {
      const st = state.status[m.id] || { state: 'unknown', label: '待连接' };
      const el = document.createElement('span');
      el.className = 'member';
      el.dataset.member = m.id;
      el.dataset.state = st.state;
      el.title = m.name + ' · ' + (st.label || '') + (st.detail ? '（' + st.detail + '）' : '');
      const mini = document.createElement('span');
      mini.className = 'mini';
      mini.textContent = SHORT[m.id] || m.name.slice(0, 1);
      mini.style.setProperty('--c', COLORS[m.id] || '#64748b');
      const name = document.createElement('span');
      name.textContent = m.name;
      const dot = document.createElement('span');
      dot.className = 'dot';
      el.append(mini, name, dot);
      membersEl.appendChild(el);
    }
  }

  function updateMembers() {
    for (const m of state.members) {
      const el = membersEl.querySelector('[data-member="' + m.id + '"]');
      const st = state.status[m.id] || { state: 'unknown', label: '待连接' };
      if (!el) continue;
      el.dataset.state = st.state;
      el.title = m.name + ' · ' + (st.label || '') + (st.detail ? '（' + st.detail + '）' : '');
    }
  }

  function makeNode(msg) {
    const root = document.createElement('div');
    root.className = 'msg ' + (msg.role === 'user' ? 'user' : 'ai');
    root.dataset.id = String(msg.id);

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = msg.role === 'user' ? '你' : SHORT[msg.who] || msg.name.slice(0, 1);
    if (msg.who) avatar.style.setProperty('--c', COLORS[msg.who] || '#64748b');

    const body = document.createElement('div');
    body.className = 'body';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = msg.name;
    const stateEl = document.createElement('span');
    stateEl.className = 'state';
    const time = document.createElement('span');
    time.className = 'state';
    time.textContent = timeOf(msg.ts);
    meta.append(name, stateEl, time);

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    body.append(meta, bubble);
    root.append(avatar, body);
    list.appendChild(root);
    const node = { root, bubble, stateEl, status: '' };
    nodes.set(String(msg.id), node);
    return node;
  }

  function paint(node, msg) {
    const isPending = msg.status === 'pending';
    const isLogin = msg.status === 'login';
    const isError = msg.status === 'error';
    node.bubble.classList.toggle('error', isError);
    node.bubble.classList.toggle('login', isLogin);

    if (isPending && !msg.text) {
      if (!node.bubble.querySelector('.typing')) {
        node.bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
      }
      node.stateEl.className = 'state live';
      node.stateEl.textContent = '正在思考';
      return;
    }
    node.stateEl.className = 'state';
    node.stateEl.textContent = isPending ? '正在回答' : isError ? '失败' : isLogin ? '需登录' : '';

    const text = msg.text || '';
    if (isLogin) {
      if (node.bubble.dataset.mode !== 'login:' + text) {
        node.bubble.dataset.mode = 'login:' + text;
        node.bubble.textContent = '';
        const span = document.createElement('span');
        span.textContent = text;
        const btn = document.createElement('button');
        btn.className = 'primary small';
        btn.style.marginLeft = '10px';
        btn.textContent = '去登录';
        btn.addEventListener('click', () => login(msg.who));
        node.bubble.append(span, btn);
      }
      return;
    }
    node.bubble.dataset.mode = '';
    if (node.bubble.textContent !== text) node.bubble.textContent = text;
  }

  function render() {
    ensureMemberEls();
    updateMembers();

    const seen = new Set();
    for (const msg of state.messages) {
      seen.add(String(msg.id));
      const node = nodes.get(String(msg.id)) || makeNode(msg);
      paint(node, msg);
    }
    for (const [id, node] of nodes) {
      if (!seen.has(id)) {
        node.root.remove();
        nodes.delete(id);
      }
    }

    empty.hidden = state.messages.length > 0;
    list.hidden = state.messages.length === 0;
    busyHint.hidden = !state.busy;
    sendBtn.disabled = state.busy || input.value.trim() === '';

    // 有新消息或原本就在底部时跟随到底部
    if (state.messages.length !== lastCount) {
      lastCount = state.messages.length;
      if (nearBottom() || state.messages.length > 0) stream.scrollTop = stream.scrollHeight;
    } else if (nearBottom()) {
      stream.scrollTop = stream.scrollHeight;
    }

    // 登录提示条：优先级 元宝 > 豆包
    const need = state.members.find((m) => (state.status[m.id] || {}).state === 'login');
    if (need) {
      banner.hidden = false;
      bannerText.textContent = need.name + ' 还没登录，登录后三家的回答才完整。';
      bannerAction.textContent = '打开' + need.name + '登录';
      bannerAction.onclick = () => login(need.id);
    } else {
      banner.hidden = true;
    }
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || '请求失败');
    return data;
  }

  async function poll() {
    try {
      state = await api('./api/state');
      render();
    } catch (error) {
      // DSH 重启/路由未就绪时静默重试
    }
  }

  async function send() {
    const text = input.value.trim();
    if (!text || state.busy) return;
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    try {
      await api('./api/send', { text });
      await poll();
    } catch (error) {
      toast(error.message || '发送失败');
      input.value = text;
    }
  }

  async function login(id) {
    try {
      await api('./api/login', { id: id || 'yuanbao' });
      toast('已把登录窗口拉到前台，扫码完成后直接发消息即可');
      setTimeout(poll, 1200);
    } catch (error) {
      toast('打不开登录窗口：' + (error.message || ''));
    }
  }

  async function reset() {
    if (state.busy) return toast('等这一轮回答完再开新话题');
    if (!confirm('清空群聊，并让三家都开一个新对话？')) return;
    try {
      await api('./api/reset', {});
      nodes.clear();
      list.innerHTML = '';
      lastCount = 0;
      state = await api('./api/state');
      render();
      toast('新话题已开始');
    } catch (error) {
      toast('重置失败：' + (error.message || ''));
    }
  }

  async function refresh() {
    try {
      const data = await api('./api/status');
      state.status = data.status;
      updateMembers();
      toast('状态已刷新');
    } catch (error) {
      toast('刷新失败：' + (error.message || ''));
    }
  }

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    sendBtn.disabled = state.busy || input.value.trim() === '';
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', send);
  $('reset').addEventListener('click', reset);
  $('refresh').addEventListener('click', refresh);
  $('samples').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-q]');
    if (!btn) return;
    input.value = btn.dataset.q;
    input.dispatchEvent(new Event('input'));
    send();
  });

  poll();
  setInterval(poll, 900);

  // 打开面板就预热：提前拉起浏览器、加载两个网页，首条消息不用等冷启动
  fetch('./api/warm', { method: 'POST' })
    .then((r) => r.json())
    .then((data) => {
      if (data && data.status) {
        state.status = data.status;
        updateMembers();
      }
    })
    .catch(() => {});
})();

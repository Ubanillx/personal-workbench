(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  const LS_KEY = 'wb_share_token';
  let token = '';
  let tasks = [];
  let now = Date.now();
  let filter = 'all';
  let me = { role: 'owner' };   // { role: 'owner' } | { role: 'assistant', id, name } | { role: 'viewer', id, name }
  let assistants = [];
  const expanded = new Map(); // taskId -> true
  let firstLoad = true;

  // ---------- token ----------
  function initToken() {
    const q = new URLSearchParams(location.search);
    const t = (q.get('token') || '').trim();
    if (t) {
      token = t;
      localStorage.setItem(LS_KEY, t);
      history.replaceState(null, '', location.pathname);
    } else {
      token = localStorage.getItem(LS_KEY) || '';
    }
    if (!token) {
      $('#loginMask').hidden = false;
      $('#tokenInput').focus();
    }
  }

  $('#loginBtn').addEventListener('click', async () => {
    const t = $('#tokenInput').value.trim();
    if (!t) return;
    $('#loginErr').hidden = true;
    $('#loginBtn').disabled = true;
    token = t;
    const tasksOk = await fetchTasks(true);
    const identityOk = tasksOk && await fetchMe();
    $('#loginBtn').disabled = false;
    if (tasksOk && identityOk) {
      localStorage.setItem(LS_KEY, t);
      $('#loginMask').hidden = true;
      startPolling();
    } else {
      $('#loginErr').hidden = false;
      $('#loginErr').textContent = '令牌无效或服务未启动，请确认后重试';
    }
  });
  $('#tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#loginBtn').click(); });

  // ---------- 身份 ----------
  async function fetchMe() {
    try {
      const r = await fetch('/api/share/me?token=' + encodeURIComponent(token), { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) return false;
      me = j.who;
      assistants = j.assistants || [];
      const box = $('#whoBox');
      if (me.role === 'owner') {
        box.innerHTML = '<b>主人视图</b> · 全部任务可见，可指派给任意助理';
      } else if (me.role === 'viewer') {
        box.innerHTML = '你是 <b>「' + esc(me.name) + '」</b> · 团队查看者 · 可查看各位助理的任务并<b>留言反馈</b>，看不到主人的私人任务';
      } else {
        box.innerHTML = '你是助理 <b>「' + esc(me.name) + '」</b> · 只显示指派给你的任务';
      }
      box.hidden = false;
      const nb = $('#newTaskBtn');
      const as = $('#ntAssignee');
      if (me.role === 'owner') {
        nb.hidden = false;
        as.hidden = false;
        as.innerHTML = '<option value="me">负责人：我</option>' + assistants.map(a => `<option value="assistant:${esc(a.id)}">负责人：${esc(a.name)}</option>`).join('');
      } else {
        nb.hidden = true;
        as.hidden = true;
      }
      return true;
    } catch (e) { return false; }
  }

  $('#newTaskBtn').addEventListener('click', () => {
    const box = $('#newTaskBox');
    box.hidden = !box.hidden;
    if (!box.hidden) $('#ntTitle').focus();
  });
  $('#ntSubmit').addEventListener('click', async () => {
    const title = $('#ntTitle').value.trim();
    if (!title) { toast('请填写任务标题'); return; }
    const payload = {
      token,
      title,
      priority: $('#ntPriority').value,
      due: $('#ntDue').value || null
    };
    if (me.role === 'owner') payload.assignee = $('#ntAssignee').value || 'me';
    try {
      const r = await fetch('/api/share/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const j = await r.json();
      if (j.ok) {
        $('#ntTitle').value = '';
        $('#ntDue').value = '';
        $('#newTaskBox').hidden = true;
        $('#updated').textContent = '已发布';
        await fetchTasks(true);
        toast('任务已发布');
      } else {
        toast(j.error || '发布失败');
      }
    } catch (e) { toast('网络异常，发布失败'); }
  });

  function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) { alert(msg); return; }
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.hidden = true, 1800);
  }
  let toastTimer;

  // ---------- 数据 ----------
  async function fetchTasks(silent) {
    try {
      const r = await fetch('/api/share/tasks?token=' + encodeURIComponent(token), { cache: 'no-store' });
      if (r.status === 401) {
        if (!silent) {
          localStorage.removeItem(LS_KEY);
          location.reload();
        }
        return false;
      }
      const j = await r.json();
      if (!j.ok) return false;
      tasks = j.tasks || [];
      now = j.now || Date.now();
      render();
      firstLoad = false;
      return true;
    } catch (e) {
      if (!silent) { /* 网络异常静默，轮询会自动重试 */ }
      return false;
    }
  }

  // ---------- 工具函数 ----------
  function fmtAgo(ts) {
    const diff = Math.max(0, now - ts);
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    const d = Math.floor(h / 24);
    if (d === 1) return '昨天';
    if (d < 7) return d + ' 天前';
    const dt = new Date(ts);
    return (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
  }

  function fmtDue(due) {
    if (!due) return null;
    const d = new Date(due + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((d - today) / 86400000);
    const label = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    if (diffDays < 0) return { text: '已逾期 · ' + label, cls: 'over' };
    if (diffDays === 0) return { text: '今天截止', cls: 'today' };
    if (diffDays === 1) return { text: '明天截止', cls: '' };
    return { text: label + '截止', cls: '' };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ---------- 渲染 ----------
  function filtered() {
    if (filter === 'doing') return tasks.filter(t => t.status !== 'done');
    if (filter === 'done') return tasks.filter(t => t.status === 'done');
    return tasks;
  }

  function render() {
    // 统计
    const doing = tasks.filter(t => t.status !== 'done').length;
    const done = tasks.filter(t => t.status === 'done').length;
    const overdue = tasks.filter(t => t.status !== 'done' && t.due && new Date(t.due + 'T00:00:00') < new Date()).length;
    $('#statDoing').textContent = doing;
    $('#statDone').textContent = done;
    $('#statOverdue').textContent = overdue;
    $('#updated').textContent = firstLoad ? '同步中…' : fmtAgo(now) + '更新';

    const list = filtered();
    const box = $('#list');
    if (!list.length) {
      box.innerHTML = '<div class="empty" style="text-align:center;color:#c2c7d4;padding:48px 0;font-size:14px">暂无任务 🎉</div>';
      return;
    }
    const sorted = [...list].sort((a, b) => {
      const w = t => ({ P0: 0, P1: 1, P2: 2 }[t.priority] ?? 3);
      if ((a.status === 'done') !== (b.status === 'done')) return a.status === 'done' ? 1 : -1;
      return w(a) - w(b);
    });
    box.innerHTML = sorted.map(t => cardHtml(t)).join('');

    // 绑定交互
    $$('.card-head').forEach(h => h.addEventListener('click', () => {
      const id = h.dataset.id;
      const open = !expanded.get(id);
      expanded.set(id, open);
      render();
    }));
    $$('.f').forEach(b => b.addEventListener('click', () => {
      filter = b.dataset.f;
      $$('.f').forEach(x => x.classList.toggle('active', x === b));
      render();
    }));
    $$('.pfill').forEach(p => {
      p.addEventListener('click', e => e.stopPropagation());
    });
    $$('input[type=range].pg').forEach(sl => {
      const id = sl.dataset.id;
      const pct = sl.closest('.card').querySelector('.slider-row .pct');
      sl.addEventListener('input', () => {
        pct.textContent = sl.value + '%';
        const bar = sl.closest('.card').querySelector('.pfill');
        bar.style.width = sl.value + '%';
        bar.classList.toggle('done', +sl.value >= 100);
      });
      sl.addEventListener('change', () => submitProgress(id, +sl.value));
    });
    $$('.add-log form:not(.add-cmt)').forEach(f => {
      f.addEventListener('submit', e => {
        e.preventDefault();
        const ta = f.querySelector('textarea');
        const text = ta.value.trim();
        if (!text) return;
        const btn = f.querySelector('button');
        btn.disabled = true;
        submitLog(f.dataset.id, text).finally(() => { btn.disabled = false; });
      });
    });
    $$('.add-log textarea').forEach(ta => {
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          ta.closest('form').requestSubmit();
        }
      });
    });
    $$('.add-cmt').forEach(f => {
      f.addEventListener('submit', e => {
        e.preventDefault();
        const ta = f.querySelector('textarea');
        const text = ta.value.trim();
        if (!text) return;
        const btn = f.querySelector('button');
        btn.disabled = true;
        submitComment(f.dataset.id, text).finally(() => { btn.disabled = false; });
      });
    });
  }

  function assigneeTag(t) {
    const a = t.assignee || 'me';
    if (a === 'me') return '<span class="tag" style="background:#eef1f6;color:#5a6172">负责人：我</span>';
    const aid = a.replace('assistant:', '');
    const name = (assistants.find(x => x.id === aid) || {}).name || '助理';
    return `<span class="tag" style="background:#e8f7ef;color:var(--green)">负责人：${esc(name)}</span>`;
  }

  function commentHtml(c) {
    const by = c.by || '我';
    let label, cls;
    if (c.role === 'viewer') { label = '👁 ' + by; cls = 'v'; }
    else if (c.role === 'assistant') { label = by; cls = 'a'; }
    else { label = by; cls = 'o'; }   // owner（主人 / 我）
    return `
      <li>
        <span class="log-dot cmt-dot"></span>
        <div class="log-main">
          <div class="log-text">${esc(c.text)}</div>
          <div class="log-meta"><span class="log-by ${cls}">${esc(label)}</span>${fmtAgo(c.t)}</div>
        </div>
      </li>`;
  }

  function cardHtml(t) {
    const d = fmtDue(t.due);
    const open = !!expanded.get(t.id);
    const logs = (t.logs || []).slice().sort((a, b) => a.t - b.t);
    const logHtml = logs.length
      ? logs.map(l => `
          <li>
            <span class="log-dot"></span>
            <div class="log-main">
              <div class="log-text">${esc(l.text)}</div>
              <div class="log-meta"><span class="log-by ${l.by === '助理' ? '' : 'me'}">${esc(l.by || '我')}</span>${fmtAgo(l.t)}</div>
            </div>
          </li>`).join('')
      : '<div class="log-empty">还没有进展记录</div>';

    const cmts = (t.comments || []).slice().sort((a, b) => a.t - b.t);
    const cmtHtml = cmts.length
      ? cmts.map(commentHtml).join('')
      : '<div class="log-empty">还没有评论</div>';

    const body = open ? `
      <div class="card-body">
        <div class="logs-title">📌 进展日志</div>
        <ul class="logs">${logHtml}</ul>
        ${me.role === 'viewer'
          ? '<div style="font-size:12px;color:var(--sub);margin-top:10px;padding:8px 10px;background:#f4f6fa;border-radius:8px">👁 查看者只读 · 进展由负责人更新（可在下方留言反馈）</div>'
          : `<form class="add-log" data-id="${t.id}">
              <textarea placeholder="记录一条进展…（Ctrl+Enter 发送）"></textarea>
              <button type="submit" class="btn primary">记录</button>
            </form>
            <div class="slider-row">
              <span>完成度</span>
              <input type="range" class="pg" data-id="${t.id}" min="0" max="100" step="5" value="${t.progress}">
              <span class="pct">${t.progress}%</span>
            </div>`}
        <div class="cmt-title">💬 评论 / 反馈</div>
        <ul class="logs cmts">${cmtHtml}</ul>
        <form class="add-log add-cmt" data-id="${t.id}">
          <textarea placeholder="写下评论 / 反馈…（Ctrl+Enter 发送）"></textarea>
          <button type="submit" class="btn primary">发送</button>
        </form>
      </div>` : '';

    return `
      <div class="card ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}">
        <div class="card-head" data-id="${t.id}">
          <div class="pri-bar pri-${t.priority || 'P1'}"></div>
          <div class="card-main">
            <div class="card-title">${esc(t.title)}</div>
            ${t.desc ? `<div class="card-desc">${esc(t.desc)}</div>` : ''}
            <div class="card-meta">
              <span class="tag by-share">${t.priority || 'P1'}</span>
              ${me.role !== 'assistant' ? assigneeTag(t) : ''}
              ${d ? `<span class="due ${d.cls}">${d.text}</span>` : ''}
              ${t.source === 'wecom' ? '<span class="tag" style="background:#fff3e0;color:#f08c2e">企微</span>' : ''}
              ${t.source === 'assistant' ? '<span class="tag" style="background:#e8f7ef;color:var(--green)">助理发布</span>' : ''}
              <span style="font-size:11px;color:var(--sub)">${open ? '收起 ▲' : '展开 ▼'}</span>
            </div>
            <div class="progress-row">
              <div class="pbar ${t.status === 'done' ? 'done' : ''}"><div class="pfill ${t.status === 'done' ? 'done' : ''}" style="width:${t.progress}%"></div></div>
              <span class="pct">${t.progress}%</span>
            </div>
          </div>
        </div>
        ${body}
      </div>`;
  }

  // ---------- 提交 ----------
  async function submitProgress(id, progress) {
    try {
      await fetch('/api/share/tasks/' + encodeURIComponent(id) + '/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, progress })
      });
    } catch (e) { /* 忽略，下轮同步 */ }
  }

  async function submitLog(id, text) {
    try {
      const r = await fetch('/api/share/tasks/' + encodeURIComponent(id) + '/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, log: text })
      });
      const j = await r.json();
      if (j.ok) {
        $('#updated').textContent = '已同步';
        await fetchTasks(true);
      }
    } catch (e) { /* 忽略 */ }
  }

  async function submitComment(id, text) {
    try {
      const r = await fetch('/api/share/tasks/' + encodeURIComponent(id) + '/comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, text })
      });
      const j = await r.json();
      if (j.ok) {
        $('#updated').textContent = '已同步';
        await fetchTasks(true);
      } else {
        toast(j.error || '评论失败');
      }
    } catch (e) { toast('网络异常，评论失败'); }
  }

  // ---------- 轮询 ----------
  function startPolling() {
    setInterval(() => {
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'TEXTAREA' || ae.type === 'range' || ae.tagName === 'INPUT')) return; // 正在输入/拖动时跳过
      fetchTasks(true);
    }, 10000);
  }

  // ---------- 启动 ----------
  initToken();
  if (token) {
    fetchTasks().then(async tasksOk => {
      const identityOk = tasksOk && await fetchMe();
      if (tasksOk && identityOk) {
        $('#loginMask').hidden = true;
        startPolling();
      } else {
        localStorage.removeItem(LS_KEY);
        token = '';
        $('#loginMask').hidden = false;
        $('#tokenInput').focus();
      }
    });
  }
})();

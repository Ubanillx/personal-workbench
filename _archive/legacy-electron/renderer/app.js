/* 个人工作台 - 渲染进程 */

let db = { tasks: [], todos: [], notes: [], files: [], settings: {} };
let currentView = 'dashboard';
let expandedTask = null;
let taskFilter = 'all';
let inboxParsed = null;

const $ = (sel) => document.querySelector(sel);
const main = $('#main');

/* ---------- 工具 ---------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayStr = () => fmtDate(new Date());
function fmtDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.hidden = true, 1800);
}

function confirmDlg(text) {
  return new Promise(resolve => {
    $('#confirmText').textContent = text;
    const m = $('#confirmModal');
    m.hidden = false;
    const yes = $('#confirmYes');
    const done = (v) => { m.hidden = true; yes.onclick = null; resolve(v); };
    yes.onclick = () => done(true);
    m.querySelectorAll('[data-close]').forEach(b => b.onclick = () => done(false));
  });
}

const save = debounce(() => window.api.writeDb(db), 250);

/* ---------- 日期推导 ---------- */
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeek(d) { const x = new Date(d); const wd = (x.getDay() + 6) % 7; return addDays(x, -wd); } // 周一开头
const WEEK_CN = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };

function guessDueFromText(text) {
  const t = todayStr();
  const now = new Date();
  if (text.includes('今天')) return t;
  if (text.includes('明天')) return fmtDate(addDays(now, 1));
  if (text.includes('后天')) return fmtDate(addDays(now, 2));
  if (text.includes('本周末') || text.includes('周末')) {
    const fri = startOfWeek(now);
    return fmtDate(addDays(fri, 4));
  }
  if (text.includes('月底')) return fmtDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  let m = text.match(/(\d{1,2})月(\d{1,2})[日号]?/);
  if (m) return `${now.getFullYear()}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = text.match(/下周[一二三四五六日天]/);
  if (m) {
    const target = WEEK_CN[m[0].slice(2)];
    const nextMon = addDays(startOfWeek(now), 7);
    return fmtDate(addDays(nextMon, (target + 6) % 7));
  }
  m = text.match(/(?:本周)?周[一二三四五六日天]/);
  if (m) {
    const target = WEEK_CN[m[0].slice(-1)];
    const thisWd = (now.getDay() + 6) % 7;
    let diff = (target + 6) % 7 - thisWd;
    if (diff < 0) diff += 7; // 本周已过 → 下周
    return fmtDate(addDays(now, diff));
  }
  return null;
}

/* ---------- 企微消息解析 ---------- */
function parseWecomMessage(raw) {
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const senderRe = /^([^\s:：]{1,16})\s*(?:上午|下午|晚上)?\s*\d{1,2}:\d{2}(?::\d{2})?$/;
  const drafts = [];
  let sender = '';
  for (const line of lines) {
    if (senderRe.test(line)) { sender = line.replace(/\s*(上午|下午|晚上)?\s*\d{1,2}:\d{2}(?::\d{2})?$/, '').trim(); continue; }
    if (/^\[文件\]|^\[图片\]|^\[链接\]|^——以上是|^――以上是/.test(line)) continue;
    if (line.length < 4) continue;
    const due = guessDueFromText(line);
    // 去掉常见的 @某人 前缀噪音
    const title = line.replace(/@\S+\s*/g, '').slice(0, 80);
    drafts.push({ id: uid(), title, due, sender, checked: true });
  }
  return drafts;
}

/* ---------- 渲染入口 ---------- */
const views = { dashboard: renderDashboard, tasks: renderTasks, todos: renderTodos, notes: renderNotes, inbox: renderInbox, files: renderFiles, assistants: renderAssistants, review: renderReview };

function render() {
  views[currentView]();
  const pending = db.todos.filter(t => !t.done).length;
  $('#todoBadge').textContent = pending || '';
}

document.getElementById('nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (!btn) return;
  currentView = btn.dataset.view;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b === btn));
  render();
});

/* ================= 每日概览 ================= */
function renderDashboard() {
  const now = new Date();
  const hour = now.getHours();
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  const t = todayStr();
  const todayTodos = db.todos.filter(x => x.date === t);
  const pendingTodos = todayTodos.filter(x => !x.done).length;
  const doingTasks = db.tasks.filter(x => x.status !== 'done');
  const weekStart = startOfWeek(now).getTime();
  const weekDone = db.tasks.filter(x => x.doneAt && x.doneAt >= weekStart).length
    + db.todos.filter(x => x.done && x.doneAt && x.doneAt >= weekStart).length;

  const doingList = doingTasks.slice().sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || b.createdAt - a.createdAt);
  const recentNotes = db.notes.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);
  const overdue = doingTasks.filter(x => x.due && x.due < t);

  main.innerHTML = `
    <div class="page-title">${greet}，今天也要稳稳推进 👋</div>
    <div class="page-sub">${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]}</div>
    <div class="stat-grid">
      <div class="stat-card c-blue"><div class="stat-num">${pendingTodos}<span style="font-size:14px;color:var(--muted)"> / ${todayTodos.length}</span></div><div class="stat-label">今日待办（未完成）</div></div>
      <div class="stat-card c-purple"><div class="stat-num">${doingTasks.length}</div><div class="stat-label">进行中任务</div></div>
      <div class="stat-card c-green"><div class="stat-num">${weekDone}</div><div class="stat-label">本周已完成</div></div>
      <div class="stat-card c-orange"><div class="stat-num">${db.notes.length}</div><div class="stat-label">随手记</div></div>
    </div>
    ${overdue.length ? `<div class="card" style="border-color:var(--red);background:var(--red-weak)">
      <div class="card-title" style="color:var(--red)">⏰ 有 ${overdue.length} 项任务已逾期</div>
      <div class="list">${overdue.map(x => `<div class="review-row"><span class="review-date">${esc(x.due)}</span><span>${esc(x.title)}</span></div>`).join('')}</div>
    </div>` : ''}
    <div class="dash-grid">
      <div>
        <div class="card">
          <div class="card-title">进行中的任务<span class="more" data-goto="tasks">查看全部 →</span></div>
          ${doingList.length ? doingList.slice(0, 6).map(taskCardMini).join('') : '<div class="empty">没有进行中的任务，去创建一个吧</div>'}
        </div>
        <div class="card">
          <div class="card-title">最近随手记<span class="more" data-goto="notes">全部 →</span></div>
          ${recentNotes.length ? recentNotes.map(n => `
            <div class="review-row" style="align-items:flex-start">
              <span class="review-date" style="width:76px;padding-top:2px">${fmtTime(n.createdAt).slice(5, 10)}</span>
              <span style="flex:1;white-space:pre-wrap">${esc(n.text.length > 60 ? n.text.slice(0, 60) + '…' : n.text)}</span>
            </div>`).join('') : '<div class="empty">还没有记录</div>'}
        </div>
      </div>
      <div class="card">
        <div class="card-title">今日待办<span class="more" data-goto="todos">管理 →</span></div>
        <div class="add-row"><input type="text" id="dashTodoInput" placeholder="加一条今日待办，回车保存" /></div>
        <div class="list">${todayTodos.length ? todayTodos.map(todoRow).join('') : '<div class="empty">今天还没有待办</div>'}</div>
      </div>
    </div>`;

  $('#dashTodoInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      db.todos.push({ id: uid(), text: e.target.value.trim(), done: false, date: todayStr(), createdAt: Date.now(), doneAt: null });
      save(); render();
    }
  });
  bindTodoRows();
  bindGoto();
}

function taskCardMini(x) {
  const overdue = x.due && x.due < todayStr() && x.status !== 'done';
  const lastLog = x.logs && x.logs.length ? x.logs[x.logs.length - 1] : null;
  return `
    <div class="task-card" data-id="${x.id}" style="padding:10px 14px">
      <div class="task-head">
        <span class="task-title">${esc(x.title)}</span>
        ${assigneeTagHtml(x)}
        ${x.source === 'wecom' ? '<span class="tag wecom">企微</span>' : ''}
        ${x.source === 'assistant' ? '<span class="tag" style="background:var(--green-weak);color:var(--green)">助理发布</span>' : ''}
        <span class="tag ${x.priority.toLowerCase()}">${x.priority}</span>
        ${x.due ? `<span class="tag ${overdue ? 'overdue' : 'todo'}">${overdue ? '逾期 ' : ''}${x.due.slice(5)}</span>` : ''}
      </div>
      <div class="progress-wrap">
        <div class="progress-bar"><div class="progress-fill" style="width:${x.progress}%"></div></div>
        <span class="progress-num">${x.progress}%</span>
      </div>
      ${lastLog ? `<div style="font-size:11.5px;color:var(--muted);margin-top:6px">最近：${esc(lastLog.text.length > 40 ? lastLog.text.slice(0, 40) + '…' : lastLog.text)}</div>` : ''}
    </div>`;
}

function bindGoto() {
  main.querySelectorAll('[data-goto]').forEach(el => el.onclick = () => {
    const v = el.dataset.goto;
    document.querySelector(`.nav-item[data-view="${v}"]`).click();
  });
}

/* ================= 任务进展 ================= */
function renderTasks() {
  const groups = { all: db.tasks, todo: db.tasks.filter(x => x.status === 'todo'), doing: db.tasks.filter(x => x.status === 'doing'), done: db.tasks.filter(x => x.status === 'done') };
  const list = (groups[taskFilter] || groups.all).slice().sort((a, b) => {
    if ((a.status === 'done') !== (b.status === 'done')) return a.status === 'done' ? 1 : -1;
    return (a.due || '9999').localeCompare(b.due || '9999') || b.createdAt - a.createdAt;
  });

  main.innerHTML = `
    <div class="page-title">任务进展</div>
    <div class="page-sub">跟踪每项任务的完成度与进展日志，支持从企微收件箱导入</div>
    <div class="card">
      <div class="add-row">
        <input type="text" id="ntTitle" placeholder="新任务标题" style="flex:2" />
        <select id="ntPriority"><option value="P0">P0 高</option><option value="P1" selected>P1 中</option><option value="P2">P2 低</option></select>
        <input type="date" id="ntDue" />
        <select id="ntAssignee">${assigneeOptionsHtml('me')}</select>
        <button class="btn primary" id="ntAdd">创建任务</button>
      </div>
      <div class="task-filter">
        <span class="chip ${taskFilter === 'all' ? 'active' : ''}" data-f="all">全部 ${db.tasks.length}</span>
        <span class="chip ${taskFilter === 'todo' ? 'active' : ''}" data-f="todo">待办 ${groups.todo.length}</span>
        <span class="chip ${taskFilter === 'doing' ? 'active' : ''}" data-f="doing">进行中 ${groups.doing.length}</span>
        <span class="chip ${taskFilter === 'done' ? 'active' : ''}" data-f="done">已完成 ${groups.done.length}</span>
      </div>
      ${list.length ? list.map(taskCardFull).join('') : '<div class="empty">暂无任务</div>'}
    </div>`;

  $('#ntAdd').onclick = () => {
    const title = $('#ntTitle').value.trim();
    if (!title) return toast('请填写任务标题');
    db.tasks.push({ id: uid(), title, desc: '', priority: $('#ntPriority').value, status: 'todo', progress: 0, due: $('#ntDue').value || null, assignee: $('#ntAssignee').value, logs: [], source: 'manual', createdAt: Date.now(), doneAt: null });
    save(); render();
    toast($('#ntAssignee').value === 'me' ? '已创建' : '已创建并指派给 ' + assistantName($('#ntAssignee').value.replace('assistant:', '')));
  };
  main.querySelectorAll('.chip').forEach(c => c.onclick = () => { taskFilter = c.dataset.f; render(); });
  bindTaskCards();
}

function taskCardFull(x) {
  const open = expandedTask === x.id;
  const overdue = x.due && x.due < todayStr() && x.status !== 'done';
  return `
    <div class="task-card ${x.status === 'done' ? 'done' : ''}" data-id="${x.id}">
      <div class="task-head">
        <span class="task-title">${esc(x.title)}</span>
        ${assigneeTagHtml(x)}
        ${x.source === 'wecom' ? '<span class="tag wecom">企微</span>' : ''}
        ${x.source === 'assistant' ? '<span class="tag" style="background:var(--green-weak);color:var(--green)">助理发布</span>' : ''}
        <span class="tag ${x.priority.toLowerCase()}">${x.priority}</span>
        <span class="tag ${x.status}">${{ todo: '待办', doing: '进行中', done: '已完成' }[x.status]}</span>
        ${x.due ? `<span class="tag ${overdue ? 'overdue' : 'todo'}">${overdue ? '逾期 ' : ''}${x.due}</span>` : ''}
        <span style="color:var(--muted);font-size:11px">${open ? '▲' : '▼'}</span>
      </div>
      <div class="progress-wrap">
        <div class="progress-bar"><div class="progress-fill" style="width:${x.progress}%"></div></div>
        <span class="progress-num">${x.progress}%</span>
      </div>
      ${open ? `
      <div class="task-body">
        <div class="log-input">
          <input type="text" placeholder="记录一条进展，回车保存…" data-loginput />
          <button class="btn small primary" data-addlog>添加</button>
        </div>
        <div class="log-list">${(x.logs || []).slice().reverse().map(l => `<div class="log-item"><span class="log-time">${fmtTime(l.t)}</span><span style="flex:1">${esc(l.text)}</span></div>`).join('') || '<div class="empty" style="padding:8px 0">还没有进展记录</div>'}</div>
        <div style="display:flex;align-items:center;gap:10px;margin:6px 0 10px">
          <span style="font-size:12.5px;color:var(--muted)">完成度</span>
          <input type="range" min="0" max="100" step="5" value="${x.progress}" data-progress style="flex:1" />
          <span style="font-size:12.5px;width:36px;text-align:right" data-progressnum>${x.progress}%</span>
        </div>
        <div class="log-actions">
          ${x.status !== 'doing' && x.status !== 'done' ? `<button class="btn small" data-start>▶ 开始</button>` : ''}
          ${x.status !== 'done' ? `<button class="btn small" data-finish style="background:var(--green-weak);color:var(--green)">✔ 完成</button>` : `<button class="btn small" data-reopen>↩ 重新打开</button>`}
          <span style="flex:1"></span>
          <button class="btn small ghost" data-del style="color:var(--red)">删除</button>
        </div>
        <div class="cmt-section">
          <div class="cmt-title">💬 评论 / 反馈 <span style="font-weight:400">（助理与团队查看者的留言会显示在这里）</span></div>
          <div class="cmt-list">${(x.comments || []).slice().reverse().map(commentItemHtml).join('') || '<div class="empty" style="padding:8px 0">还没有评论</div>'}</div>
          <div class="cmt-input">
            <input type="text" placeholder="写下评论 / 反馈，回车发送…" data-cmtinput />
            <button class="btn small primary" data-addcmt>发送</button>
          </div>
        </div>
      </div>` : ''}
    </div>`;
}

function commentItemHtml(c) {
  let label, cls;
  if (c.role === 'viewer') { label = '👁 ' + (c.by || '查看者'); cls = 'cmt-v'; }
  else if (c.role === 'assistant') { label = (c.by || '助理'); cls = 'cmt-a'; }
  else { label = (c.by || '我'); cls = 'cmt-o'; }
  return `<div class="cmt-item"><span class="cmt-by ${cls}">${esc(label)}</span><span style="flex:1;word-break:break-word">${esc(c.text)}</span><span class="cmt-time">${fmtTime(c.t)}</span></div>`;
}

function bindTaskCards() {
  main.querySelectorAll('.task-card').forEach(card => {
    const x = db.tasks.find(t => t.id === card.dataset.id);
    if (!x) return;
    card.querySelector('.task-head').onclick = () => { expandedTask = expandedTask === x.id ? null : x.id; render(); };
    const logInput = card.querySelector('[data-loginput]');
    const addLog = () => {
      const v = logInput.value.trim();
      if (!v) return;
      x.logs.push({ t: Date.now(), text: v });
      if (x.status === 'todo') x.status = 'doing';
      save(); render();
    };
    logInput?.addEventListener('keydown', e => { if (e.key === 'Enter') addLog(); });
    card.querySelector('[data-addlog]')?.addEventListener('click', addLog);
    card.querySelector('[data-progress]')?.addEventListener('input', e => {
      x.progress = +e.target.value;
      card.querySelector('[data-progressnum]').textContent = x.progress + '%';
      card.querySelector('.progress-fill').style.width = x.progress + '%';
      if (x.progress === 100) finishTask(x, false);
      else if (x.progress > 0 && x.status === 'todo') x.status = 'doing';
      save();
    });
    card.querySelector('[data-start]')?.addEventListener('click', () => { x.status = 'doing'; save(); render(); });
    card.querySelector('[data-finish]')?.addEventListener('click', () => { finishTask(x); render(); });
    card.querySelector('[data-reopen]')?.addEventListener('click', () => { x.status = 'doing'; x.progress = Math.min(x.progress, 90); x.doneAt = null; save(); render(); });
    card.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (await confirmDlg(`确定删除任务「${x.title}」吗？`)) {
        db.tasks = db.tasks.filter(t => t.id !== x.id);
        save(); render();
      }
    });
    const cmtInput = card.querySelector('[data-cmtinput]');
    const addCmt = () => {
      const v = cmtInput.value.trim();
      if (!v) return;
      x.comments = x.comments || [];
      x.comments.push({ t: Date.now(), text: v, by: '我', role: 'owner' });
      save(); render();
    };
    cmtInput?.addEventListener('keydown', e => { if (e.key === 'Enter') addCmt(); });
    card.querySelector('[data-addcmt]')?.addEventListener('click', addCmt);
  });
}

function finishTask(x, rerender = true) {
  x.status = 'done'; x.progress = 100; x.doneAt = Date.now();
  save();
  if (rerender) render();
}

/* ================= 待办清单 ================= */
function todoRow(x) {
  return `
    <div class="todo-row ${x.done ? 'done' : ''}" data-id="${x.id}">
      <div class="todo-check" data-check>${x.done ? '✔' : ''}</div>
      <span class="todo-text">${esc(x.text)}</span>
      <button class="todo-del" data-del>✕</button>
    </div>`;
}

function bindTodoRows() {
  main.querySelectorAll('.todo-row').forEach(row => {
    const x = db.todos.find(t => t.id === row.dataset.id);
    if (!x) return;
    row.querySelector('[data-check]').onclick = () => { x.done = !x.done; x.doneAt = x.done ? Date.now() : null; save(); render(); };
    row.querySelector('[data-del]').onclick = () => { db.todos = db.todos.filter(t => t.id !== x.id); save(); render(); };
  });
}

function renderTodos() {
  const t = todayStr();
  const today = db.todos.filter(x => x.date === t && !x.done);
  const todayDone = db.todos.filter(x => x.date === t && x.done);
  const older = db.todos.filter(x => x.date < t && !x.done).sort((a, b) => a.date.localeCompare(b.date));

  main.innerHTML = `
    <div class="page-title">待办清单</div>
    <div class="page-sub">轻量勾选清单，只管今天和未完成的</div>
    <div class="card">
      <div class="card-title">今天 · ${today.length + todayDone.length} 项（未完成 ${today.length}）${todayDone.length ? '<span class="more" id="clearDone">清除已完成 →</span>' : ''}</div>
      <div class="add-row"><input type="text" id="todoInput" placeholder="要做什么？回车添加" /></div>
      <div class="list">${today.map(todoRow).join('') || '<div class="empty">今天清爽，暂无待办</div>'}</div>
      ${todayDone.length ? `<div style="margin-top:10px;font-size:12px;color:var(--muted)">已完成</div><div class="list">${todayDone.map(todoRow).join('')}</div>` : ''}
    </div>
    ${older.length ? `<div class="card" style="border-color:#f0c96b">
      <div class="card-title">⏰ 往日未完成（${older.length}）</div>
      <div class="list">${older.map(x => `<div class="review-row"><span class="review-date">${x.date.slice(5)}</span><span style="flex:1">${esc(x.text)}</span><button class="btn small" data-move="${x.id}">挪到今天</button><button class="todo-del" data-delold="${x.id}" style="border:none;background:none;color:#c3c8d4;cursor:pointer">✕</button></div>`).join('')}</div>
    </div>` : ''}`;

  $('#todoInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      db.todos.push({ id: uid(), text: e.target.value.trim(), done: false, date: todayStr(), createdAt: Date.now(), doneAt: null });
      save(); render();
    }
  });
  $('#clearDone')?.addEventListener('click', () => {
    db.todos = db.todos.filter(x => !(x.date === t && x.done));
    save(); render();
  });
  main.querySelectorAll('[data-move]').forEach(b => b.onclick = () => {
    const x = db.todos.find(t2 => t2.id === b.dataset.move); if (x) x.date = t; save(); render();
  });
  main.querySelectorAll('[data-delold]').forEach(b => b.onclick = () => {
    db.todos = db.todos.filter(t2 => t2.id !== b.dataset.delold); save(); render();
  });
  bindTodoRows();
}

/* ================= 随手记 ================= */
function renderNotes() {
  const list = db.notes.slice().sort((a, b) => (b.pinned - a.pinned) || (b.createdAt - a.createdAt));
  main.innerHTML = `
    <div class="page-title">随手记</div>
    <div class="page-sub">灵感、想法、临时信息 —— 记下来就放心了</div>
    <div class="card">
      <div class="add-row"><textarea id="noteInput" class="inbox-textarea" style="min-height:70px" placeholder="写点什么… Ctrl+Enter 保存"></textarea></div>
      <div style="display:flex;justify-content:flex-end"><button class="btn primary" id="noteAdd">保存随手记</button></div>
    </div>
    <div class="note-grid">
      ${list.map(n => `
        <div class="note-card ${n.pinned ? 'pinned' : ''}">
          <div class="note-text">${esc(n.text)}</div>
          <div class="note-time">
            ${fmtTime(n.createdAt)}
            <span class="note-ops">
              <button data-pin="${n.id}" title="${n.pinned ? '取消置顶' : '置顶'}">${n.pinned ? '★' : '☆'}</button>
              <button data-del="${n.id}" title="删除">🗑</button>
            </span>
          </div>
        </div>`).join('') || '<div class="empty" style="grid-column:1/-1">还没有随手记，想到什么先记下来</div>'}
    </div>`;

  const add = () => {
    const v = $('#noteInput').value.trim();
    if (!v) return;
    db.notes.push({ id: uid(), text: v, pinned: false, createdAt: Date.now() });
    save(); render();
  };
  $('#noteAdd').onclick = add;
  $('#noteInput').addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) add(); });
  main.querySelectorAll('[data-pin]').forEach(b => b.onclick = () => {
    const n = db.notes.find(x => x.id === b.dataset.pin); n.pinned = !n.pinned; save(); render();
  });
  main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (await confirmDlg('删除这条随手记？')) {
      db.notes = db.notes.filter(x => x.id !== b.dataset.del); save(); render();
    }
  });
}

/* ================= 企微收件箱 ================= */
function renderInbox() {
  main.innerHTML = `
    <div class="page-title">企微任务收件箱</div>
    <div class="page-sub">把企业微信里收到 / 发布的任务消息粘贴到这里，自动解析成任务草稿</div>
    <div class="card">
      <div class="card-title">粘贴企微消息</div>
      <textarea id="inboxText" class="inbox-textarea" placeholder="例如：&#10;张三 10:23&#10;请在本周五前完成季度报告初稿，发我一份&#10;李四 14:05&#10;记得明天上午同步一下客户反馈"></textarea>
      <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end">
        <button class="btn ghost" id="inboxClear">清空</button>
        <button class="btn primary" id="inboxParse">解析消息</button>
      </div>
      <div class="parsed-list" id="parsedList"></div>
      ${inboxParsed ? '<div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="btn primary" id="inboxImport">导入选中的任务</button></div>' : ''}
    </div>
    <div class="card">
      <div class="card-title">🔌 自动化接口（预留）</div>
      <div class="api-box">
        工作台在本地运行了一个接收接口，未来接通企业微信机器人后，可直接把消息自动推成任务：<br />
        <code>POST http://127.0.0.1:17500/api/tasks</code><br />
        请求体：<code>{"token":"${esc(db.settings.apiToken || '尚未生成')}","title":"任务标题","due":"2026-09-05","priority":"P1"}</code><br />
        推送成功后，任务会自动出现在「任务进展」中，并标记为「企微」来源。
      </div>
    </div>`;

  const textEl = $('#inboxText');
  $('#inboxClear').onclick = () => { textEl.value = ''; inboxParsed = null; render(); };
  $('#inboxParse').onclick = () => {
    const raw = textEl.value.trim();
    if (!raw) return toast('先粘贴一段企微消息');
    inboxParsed = parseWecomMessage(raw);
    if (!inboxParsed.length) return toast('没有解析出任务，请检查内容');
    render();
  };
  $('#inboxImport')?.addEventListener('click', () => {
    const picked = inboxParsed.filter(p => p.checked);
    if (!picked.length) return toast('请至少勾选一条');
    for (const p of picked) {
      db.tasks.push({
        id: uid(), title: p.title, desc: p.sender ? `来自企微：${p.sender}` : '来自企微消息导入',
        priority: 'P1', status: 'todo', progress: 0, due: p.due, assignee: 'me',
        logs: p.sender ? [{ t: Date.now(), text: `从企微消息导入（发送人：${p.sender}）` }] : [{ t: Date.now(), text: '从企微消息导入' }],
        source: 'wecom', createdAt: Date.now(), doneAt: null
      });
    }
    inboxParsed = null;
    textEl.value = '';
    save();
    toast(`已导入 ${picked.length} 条任务`);
    render();
  });
  if (inboxParsed) renderParsedList();

  function renderParsedList() {
    const box = $('#parsedList');
    box.innerHTML = inboxParsed.map((p, i) => `
      <div class="parsed-item">
        <input type="checkbox" data-ck="${i}" ${p.checked ? 'checked' : ''} />
        <input type="text" data-title="${i}" value="${esc(p.title)}" />
        <input type="date" data-due="${i}" value="${p.due || ''}" />
        ${p.sender ? `<span class="tag wecom">${esc(p.sender)}</span>` : ''}
      </div>`).join('');
    box.querySelectorAll('[data-ck]').forEach(c => c.onchange = () => { inboxParsed[+c.dataset.ck].checked = c.checked; });
    box.querySelectorAll('[data-title]').forEach(c => c.oninput = () => { inboxParsed[+c.dataset.title].title = c.value; });
    box.querySelectorAll('[data-due]').forEach(c => c.onchange = () => { inboxParsed[+c.dataset.due].due = c.value; });
  }
}

/* ================= 重要文件 ================= */
function renderFiles() {
  main.innerHTML = `
    <div class="page-title">重要文件</div>
    <div class="page-sub">把常用的文件固定在这里，一点就开</div>
    <div class="card" style="margin-bottom:14px">
      <button class="btn primary" id="fileAdd">＋ 添加文件</button>
    </div>
    <div class="file-grid">
      ${db.files.map(f => {
        const ext = (f.name.split('.').pop() || '文件').slice(0, 4);
        return `
        <div class="file-card" data-id="${f.id}">
          <div class="file-ext">${esc(ext)}</div>
          <div class="file-name">${esc(f.name)}</div>
          <div class="file-path">${esc(f.path)}</div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn small" data-open="${f.id}">打开</button>
            <button class="btn small ghost" data-folder="${f.id}">所在目录</button>
            <span style="flex:1"></span>
            <button class="btn small ghost" data-remove="${f.id}" style="color:var(--red)">移除</button>
          </div>
        </div>`;
      }).join('') || '<div class="empty" style="grid-column:1/-1">还没有固定文件</div>'}
    </div>`;

  $('#fileAdd').onclick = async () => {
    const paths = await window.api.pickFiles();
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop();
      if (db.files.some(f => f.path === p)) continue;
      db.files.push({ id: uid(), name, path: p, createdAt: Date.now() });
    }
    if (paths.length) { save(); render(); }
  };
  main.querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
    const f = db.files.find(x => x.id === b.dataset.open);
    window.api.openPath(f.path).then(r => { if (r && r.ok === false) toast('打开失败，文件可能已被移动'); });
  });
  main.querySelectorAll('[data-folder]').forEach(b => b.onclick = () => {
    const f = db.files.find(x => x.id === b.dataset.folder);
    window.api.showInFolder(f.path);
  });
  main.querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => {
    if (await confirmDlg('从工作台移除该文件？（不会删除原文件）')) {
      db.files = db.files.filter(x => x.id !== b.dataset.remove); save(); render();
    }
  });
}

/* ================= 回顾统计 ================= */
function renderReview() {
  const now = new Date();
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(addDays(now, -i));
  const weekStart = startOfWeek(now).getTime();

  const stats = days.map(d => {
    const ds = fmtDate(d);
    return {
      ds,
      tasks: db.tasks.filter(x => x.doneAt && fmtDate(new Date(x.doneAt)) === ds).length,
      todos: db.todos.filter(x => x.done && x.doneAt && fmtDate(new Date(x.doneAt)) === ds).length,
      notes: db.notes.filter(x => fmtDate(new Date(x.createdAt)) === ds).length
    };
  });
  const max = Math.max(1, ...stats.map(s => s.tasks + s.todos + s.notes));

  const weekDoneTasks = db.tasks.filter(x => x.doneAt && x.doneAt >= weekStart).sort((a, b) => b.doneAt - a.doneAt);
  const weekNotes = db.notes.filter(x => x.createdAt >= weekStart);
  const totalDone = stats.reduce((s, x) => s + x.tasks + x.todos, 0);

  const wd = ['一', '二', '三', '四', '五', '六', '日'];
  main.innerHTML = `
    <div class="page-title">回顾统计</div>
    <div class="page-sub">最近 7 天 · 共完成 ${totalDone} 项 · 新增随手记 ${weekNotes.length} 条</div>
    <div class="card">
      <div class="card-title">本周活跃度</div>
      <div class="week-chart">
        ${stats.map(s => `
          <div class="day-col">
            <div class="day-bars">
              <div class="day-bar b-task" style="height:${Math.round(s.tasks / max * 100)}px" title="完成任务 ${s.tasks}"></div>
              <div class="day-bar b-todo" style="height:${Math.round(s.todos / max * 100)}px" title="完成待办 ${s.todos}"></div>
              <div class="day-bar b-note" style="height:${Math.round(s.notes / max * 100)}px" title="随手记 ${s.notes}"></div>
            </div>
            <div class="day-label ${s.ds === todayStr() ? 'today' : ''}">${s.ds === todayStr() ? '今天' : '周' + wd[(new Date(s.ds).getDay() + 6) % 7]}</div>
          </div>`).join('')}
      </div>
      <div class="legend">
        <span><i style="background:var(--accent)"></i>完成任务</span>
        <span><i style="background:var(--green)"></i>完成待办</span>
        <span><i style="background:#f0c96b"></i>随手记</span>
      </div>
    </div>
    <div class="dash-grid">
      <div class="card">
        <div class="card-title">本周完成的任务（${weekDoneTasks.length}）</div>
        ${weekDoneTasks.length ? weekDoneTasks.map(x => `
          <div class="review-row"><span class="review-date">${fmtTime(x.doneAt).slice(0, 5)}</span><span style="flex:1">${esc(x.title)}</span>${x.source === 'wecom' ? '<span class="tag wecom">企微</span>' : ''}</div>`).join('') : '<div class="empty">本周还没有完成任务</div>'}
      </div>
      <div class="card">
        <div class="card-title">本周随手记（${weekNotes.length}）</div>
        ${weekNotes.length ? weekNotes.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 10).map(n => `
          <div class="review-row" style="align-items:flex-start"><span class="review-date" style="width:76px;padding-top:2px">${fmtTime(n.createdAt).slice(0, 5)}</span><span style="flex:1">${esc(n.text.length > 50 ? n.text.slice(0, 50) + '…' : n.text)}</span></div>`).join('') : '<div class="empty">本周没有记录</div>'}
      </div>
    </div>`;
}

/* ================= 快速记录 ================= */
let quickType = 'note';
$('#quickBtn').onclick = openQuick;
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openQuick(); }
});
function openQuick() {
  $('#quickModal').hidden = false;
  const input = $('#quickInput');
  input.value = '';
  setTimeout(() => input.focus(), 50);
}
$('#quickModal').querySelectorAll('[data-close]').forEach(b => b.onclick = () => $('#quickModal').hidden = true);
$('#quickType').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn'); if (!b) return;
  quickType = b.dataset.type;
  $('#quickType').querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
});
$('#quickInput').addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) $('#quickSave').click(); });
$('#quickSave').onclick = () => {
  const v = $('#quickInput').value.trim();
  if (!v) return;
  if (quickType === 'note') {
    db.notes.push({ id: uid(), text: v, pinned: false, createdAt: Date.now() });
  } else if (quickType === 'todo') {
    db.todos.push({ id: uid(), text: v, done: false, date: todayStr(), createdAt: Date.now(), doneAt: null });
  } else {
    // 任务：支持 /P0 /明天 等标记
    let priority = 'P1', due = null;
    let title = v.replace(/\/(P[012])/gi, m => { priority = m.toUpperCase().slice(1); return ''; });
    const dueGuess = guessDueFromText(title);
    title = title.replace(/\/(今天|明天|后天|本周末|周末|月底|下周[一二三四五六日天]|本周[一二三四五六日天]|周[一二三四五六日天]|\d{1,2}月\d{1,2}[日号])/g, m => { if (!due) due = guessDueFromText(m) || dueGuess; return ''; }).trim();
    if (!due) due = dueGuess;
    db.tasks.push({ id: uid(), title: title || v, desc: '', priority, status: 'todo', progress: 0, due, assignee: 'me', logs: [], source: 'manual', createdAt: Date.now(), doneAt: null });
  }
  save();
  $('#quickModal').hidden = true;
  toast('已保存');
  render();
};

/* ================= 助理管理 ================= */
function genToken() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
function assistantName(id) {
  const a = (db.settings.assistants || []).find(x => x.id === id);
  return a ? a.name : '助理';
}
function assigneeTagHtml(x) {
  const a = x.assignee || 'me';
  if (a === 'me') return '';
  return `<span class="tag" style="background:var(--green-weak);color:var(--green)">👥 ${esc(assistantName(a.replace('assistant:', '')))}</span>`;
}
function assigneeOptionsHtml(sel) {
  const cur = sel || 'me';
  let html = `<option value="me">负责人：我</option>`;
  for (const a of db.settings.assistants || []) {
    html += `<option value="assistant:${esc(a.id)}" ${cur === 'assistant:' + a.id ? 'selected' : ''}>负责人：${esc(a.name)}</option>`;
  }
  return html;
}

async function renderAssistants() {
  const assistants = db.settings.assistants || [];
  const viewers = db.settings.viewers || [];
  const lanIp = await window.api.getLanIp();
  const base = `http://${lanIp}:17500/`;

  main.innerHTML = `
    <div class="page-title">助理与查看者管理</div>
    <div class="page-sub">助理用独立链接跟进自己名下的任务；查看者（团队/老板视角）只读浏览各位助理的任务，看不到你的私人任务</div>

    <div class="card">
      <div class="card-title">📌 可见性规则</div>
      <div class="api-box">
        <div>• <b>你（主人）</b>：能看到全部任务（含助理发布），并跟踪进度与反馈</div>
        <div>• <b>助理 A</b>：只能看到「负责人 = A」的任务（你派给她的 + 她自己发布的），可记录进展</div>
        <div>• <b>团队查看者</b>：只读浏览所有「负责人为助理」的任务（谁发布的都能看），<b>看不到你的私人任务</b>，不能发布/修改</div>
        <div>• 你给自己发布的任务（负责人=我）：助理和查看者都看不到</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">👑 我的共享链接（主人）</div>
      <div class="api-box">
        <code id="ownerUrl">${base}?token=${esc(db.settings.ownerToken || '')}</code>
        <button class="btn small primary" data-copy="${base}?token=${esc(db.settings.ownerToken || '')}">复制</button>
        <div style="font-size:12px;color:var(--muted);margin-top:6px">用这个链接，你在浏览器/手机也能看到全部任务（和桌面端同一份数据）</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">👥 我的助理（${assistants.length}）</div>
      <div class="add-row">
        <input type="text" id="astName" placeholder="助理名字（如：小A、小林）" style="flex:1" />
        <button class="btn primary" id="astAdd">＋ 添加助理</button>
      </div>
      <div class="list">
        ${assistants.length ? assistants.map(a => {
          const cnt = db.tasks.filter(t => (t.assignee || 'me') === 'assistant:' + a.id).length;
          return `
          <div class="ast-row" style="border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-top:10px">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <b style="font-size:15px">👤 ${esc(a.name)}</b>
              <span class="tag" style="background:var(--green-weak);color:var(--green)">${cnt} 项任务</span>
              <span style="flex:1"></span>
              <button class="btn small ghost" data-copy="${base}?token=${esc(a.token)}">复制她的链接</button>
              <button class="btn small ghost" data-delast="${esc(a.id)}" style="color:var(--red)">移除</button>
            </div>
            <div style="font-size:12px;color:var(--muted);margin-top:8px;word-break:break-all">${base}?token=${esc(a.token)}</div>
          </div>`;
        }).join('') : '<div class="empty">还没有助理。添加一位，把她的专属链接发给她即可</div>'}
      </div>
    </div>

    <div class="card">
      <div class="card-title">👁 团队查看者（${viewers.length}）</div>
      <div class="page-sub" style="margin:0 0 10px">查看者可看到<b>所有助理</b>的任务与进度（只读），看不到你的私人任务。适合放给 2-3 位需要旁观团队进展的人</div>
      <div class="add-row">
        <input type="text" id="viewerName" placeholder="查看者名字（如：王经理、李总）" style="flex:1" />
        <button class="btn primary" id="viewerAdd">＋ 添加查看者</button>
      </div>
      <div class="list">
        ${viewers.length ? viewers.map(v => `
          <div class="ast-row" style="border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-top:10px">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <b style="font-size:15px">👁 ${esc(v.name)}</b>
              <span class="tag" style="background:#eef1f6;color:#5a6172">只读</span>
              <span style="flex:1"></span>
              <button class="btn small ghost" data-copy="${base}?token=${esc(v.token)}">复制他的链接</button>
              <button class="btn small ghost" data-delview="${esc(v.id)}" style="color:var(--red)">移除</button>
            </div>
            <div style="font-size:12px;color:var(--muted);margin-top:8px;word-break:break-all">${base}?token=${esc(v.token)}</div>
          </div>`).join('') : '<div class="empty">还没有查看者。添加一位，把链接发给他即可（他看到的是各位助理的任务总览）</div>'}
      </div>
    </div>`;

  $('#astAdd').onclick = () => {
    const name = $('#astName').value.trim();
    if (!name) return toast('请填写助理名字');
    if (assistants.some(a => a.name === name)) return toast('已存在同名助理');
    db.settings.assistants.push({ id: uid(), name, token: genToken(), createdAt: Date.now() });
    save(); render();
    toast(`已添加助理「${name}」，链接已生成`);
  };
  $('#astName').addEventListener('keydown', e => { if (e.key === 'Enter') $('#astAdd').click(); });
  $('#viewerAdd').onclick = () => {
    const name = $('#viewerName').value.trim();
    if (!name) return toast('请填写查看者名字');
    if (viewers.some(v => v.name === name)) return toast('已存在同名查看者');
    db.settings.viewers.push({ id: uid(), name, token: genToken(), createdAt: Date.now() });
    save(); render();
    toast(`已添加查看者「${name}」，链接已生成`);
  };
  $('#viewerName').addEventListener('keydown', e => { if (e.key === 'Enter') $('#viewerAdd').click(); });
  main.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => {
    navigator.clipboard.writeText(b.dataset.copy).then(() => toast('链接已复制，可直接发给对方'));
  });
  main.querySelectorAll('[data-delast]').forEach(b => b.onclick = async () => {
    const a = assistants.find(x => x.id === b.dataset.delast);
    if (!a) return;
    if (await confirmDlg(`移除助理「${a.name}」？\n她的链接将立即失效，名下任务保留但不再显示负责人`)) {
      db.settings.assistants = db.settings.assistants.filter(x => x.id !== a.id);
      save(); render();
    }
  });
  main.querySelectorAll('[data-delview]').forEach(b => b.onclick = async () => {
    const v = viewers.find(x => x.id === b.dataset.delview);
    if (!v) return;
    if (await confirmDlg(`移除查看者「${v.name}」？\n他的链接将立即失效`)) {
      db.settings.viewers = db.settings.viewers.filter(x => x.id !== v.id);
      save(); render();
    }
  });
}

/* ---------- 外部接口推送后刷新 ---------- */
window.api.onChanged(async () => {
  db = await window.api.readDb();
  render();
  toast('收到外部推送的新任务');
});

/* ---------- 启动 ---------- */
(async function init() {
  db = await window.api.readDb();
  const now = new Date();
  $('#todayLabel').textContent = `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 周${['日', '一', '二', '三', '四', '五', '六'][now.getDay()]}`;
  render();
})();

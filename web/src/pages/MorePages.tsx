import type React from "react";
import { useEffect, useMemo, useState } from "react";
import type { Task, UserRole } from "../../../shared/types/domain";
import { createFile, createUser, deleteFile, getAccessInfo, getFiles, getMe, getReview, getUsers, importInbox, logout, previewInbox, rotateUserToken, updateUser, markFileUsed, type AccessInfo, type Collaborator, type ImportantFile, type InboxDraft, type ReviewData } from "../services/apiClient";

type Draft = InboxDraft & { id: string; ownerId: string; priority: "P0" | "P1" | "P2"; sender: string; messageAt: string; fingerprint: string; selected: boolean; duplicate: boolean };
const roleLabel: Record<UserRole, string> = { owner: "主人", assistant: "助理", viewer: "查看者" };

export function InboxPage(): React.ReactElement {
  const [raw, setRaw] = useState(""); const [drafts, setDrafts] = useState<Draft[]>([]); const [members, setMembers] = useState<Collaborator[]>([]); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { void getUsers().then(setMembers).catch(() => setMembers([])); }, []);
  const parse = (): void => { const initial = parseInbox(raw); if (!initial.length) { setNotice("没有识别出任务，请检查聊天记录格式"); setDrafts([]); return; } setBusy(true); void previewInbox(initial).then((items) => { setDrafts(initial.map((draft, index) => { const preview = items[index]; return { ...draft, fingerprint: preview?.fingerprint ?? draft.fingerprint, duplicate: Boolean(preview?.duplicate), selected: !preview?.duplicate }; })); setNotice(`识别出 ${initial.length} 条消息，请逐条确认后导入`); }).catch((e: unknown) => setNotice(e instanceof Error ? e.message : "重复检查失败")).finally(() => setBusy(false)); };
  const submit = (): void => { const chosen = drafts.filter((draft) => draft.selected); if (!chosen.length) { setNotice("请至少选择一条任务"); return; } setBusy(true); void importInbox(chosen).then((result) => { setNotice(`导入成功 ${result.created.length} 条；跳过 ${result.skipped.length} 条疑似重复`); setDrafts([]); setRaw(""); }).catch((e: unknown) => setNotice(e instanceof Error ? e.message : "导入失败")).finally(() => setBusy(false)); };
  const change = (id: string, patch: Partial<Draft>): void => setDrafts((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  return <section className="page-section"><div className="eyebrow">WECHAT WORK</div><h1>企微收件箱</h1><p className="page-subtitle">粘贴聊天记录，逐条编辑标题、负责人、优先级与截止日期。系统会标记疑似重复任务。</p><textarea className="inbox-input" value={raw} onChange={(e) => setRaw(e.target.value)} placeholder={"张三 10:23\n请在本周五前完成季度报告初稿，发我一份\n李四 14:05\n记得明天上午同步一下客户反馈"} /><div className="toolbar"><button disabled={!raw.trim() || busy} onClick={parse}>{busy ? "处理中…" : "解析消息"}</button>{drafts.length > 0 && <button className="secondary" disabled={busy} onClick={submit}>导入选中任务</button>}</div>{notice && <p className="notice">{notice}</p>}<div className="collection">{drafts.map((draft) => <article className={`item-card inbox-draft ${draft.duplicate ? "duplicate-card" : ""}`} key={draft.id}><label className="check-row"><input type="checkbox" checked={draft.selected} onChange={(e) => change(draft.id, { selected: e.target.checked })} /><input className="inline-input" value={draft.title} onChange={(e) => change(draft.id, { title: e.target.value })} /></label>{draft.duplicate && <span className="warning-tag">疑似重复</span>}<div className="inbox-fields"><select value={draft.ownerId} onChange={(e) => change(draft.id, { ownerId: e.target.value })}><option value="">未分配</option><option value="owner">主人</option>{members.filter((m) => m.role === "assistant" && m.isActive).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select><select value={draft.priority} onChange={(e) => change(draft.id, { priority: e.target.value as Draft["priority"] })}><option>P0</option><option>P1</option><option>P2</option></select><input type="date" value={draft.dueDate ?? ""} onChange={(e) => change(draft.id, { dueDate: e.target.value || null })} /></div><small className="muted">发送人：{draft.sender || "未识别"}</small></article>)}</div></section>;
}

export function FilesPage(): React.ReactElement {
  const [files, setFiles] = useState<ImportantFile[]>([]); const [name, setName] = useState(""); const [filePath, setFilePath] = useState(""); const [category, setCategory] = useState(""); const [search, setSearch] = useState(""); const [filter, setFilter] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const load = (): void => { setError(""); void getFiles(search, filter).then(setFiles).catch((e: unknown) => setError(e instanceof Error ? e.message : "文件加载失败")); }; useEffect(load, []); const categories = useMemo(() => [...new Set(files.map((file) => file.category).filter(Boolean))], [files]);
  const copy = (file: ImportantFile): void => { if (!navigator.clipboard) { window.prompt("请复制以下路径", file.filePath); return; } void navigator.clipboard.writeText(file.filePath).then(() => markFileUsed(file.id)).then((updated) => setFiles((items) => items.map((item) => item.id === updated.id ? updated : item))).catch(() => window.prompt("请复制以下路径", file.filePath)); };
  return <section className="page-section"><div className="eyebrow">REFERENCE</div><h1>重要文件</h1><p className="page-subtitle">只保存本机或共享盘路径索引，不上传文件内容。</p><form className="create-row file-form" onSubmit={(e) => { e.preventDefault(); if (!name.trim() || !filePath.trim() || busy) return; setBusy(true); void createFile({ name: name.trim(), filePath: filePath.trim(), category }).then((file) => { setFiles((items) => [file, ...items]); setName(""); setFilePath(""); setCategory(""); }).catch((err: unknown) => setError(err instanceof Error ? err.message : "添加失败")).finally(() => setBusy(false)); }}><input value={name} onChange={(e) => setName(e.target.value)} placeholder="文件名称" /><input value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="文件路径" /><input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="分类" /><button disabled={busy}>{busy ? "保存中…" : "添加"}</button></form><div className="toolbar"><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索名称或路径" /><button className="secondary" onClick={load}>搜索</button></div>{categories.length > 0 && <div className="tag-row"><button className={!filter ? "filter active" : "filter"} onClick={() => { setFilter(""); }}>全部</button>{categories.map((item) => <button key={item} className={filter === item ? "filter active" : "filter"} onClick={() => { setFilter(item); }}>#{item}</button>)}</div>}{error && <div className="error-panel">{error}<button className="secondary" onClick={load}>重试</button></div>}<div className="collection">{files.length ? files.map((file) => <article className="item-card" key={file.id}><div><strong>{file.name}</strong><p className="path-text">{file.category ? `[${file.category}] ` : ""}{file.filePath}</p><small className="muted">最近使用：{file.lastUsedAt ? new Date(file.lastUsedAt).toLocaleString() : "尚未记录"}</small></div><div className="item-actions"><button className="secondary" onClick={() => copy(file)}>复制路径</button><button className="icon-button danger" onClick={() => { if (window.confirm("确定删除文件索引吗？")) void deleteFile(file.id).then(() => setFiles((items) => items.filter((item) => item.id !== file.id))); }}>×</button></div></article>) : <div className="empty-panel"><strong>暂无已登记文件</strong><p>添加报价单、客户资料或模板路径。</p></div>}</div></section>;
}

export function CollaborationPage(): React.ReactElement {
  const [users, setUsers] = useState<Collaborator[]>([]);
  const [currentUser, setCurrentUser] = useState<{ id: string; name: string; role: UserRole } | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"assistant" | "viewer">("assistant");
  const [token, setToken] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [accessInfo, setAccessInfo] = useState<AccessInfo | null>(null);
  const [accessLoading, setAccessLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = (): void => {
    setError("");
    setNotice("");
    setAccessLoading(true);
    void getMe().then(async ({ user }) => {
      setCurrentUser(user);
      if (user.role !== "owner") {
        setUsers([]);
        setAccessInfo(null);
        setError(`当前登录身份为${roleLabel[user.role]}，只有主人可以管理成员。`);
        return;
      }
      const [members, access] = await Promise.all([getUsers(), getAccessInfo()]);
      setUsers(members);
      setAccessInfo(access);
    }).catch((reason: unknown) => {
      setCurrentUser(null);
      setError(reason instanceof Error ? reason.message : "无法读取当前账户，请使用主人令牌重新登录。");
    }).finally(() => setAccessLoading(false));
  };

  useEffect(load, []);

  const copy = (value: string, label: string): void => {
    const fallback = (): void => { window.prompt(`请复制${label}`, value); };
    if (!navigator.clipboard) {
      fallback();
      return;
    }
    void navigator.clipboard.writeText(value).then(() => setNotice(`${label}已复制`)).catch(fallback);
  };

  const logoutForOwner = (): void => {
    setBusy(true);
    void logout().finally(() => window.location.assign("/"));
  };

  if (accessLoading) return <section className="page-section"><div className="loading-inline">正在检查协作管理权限…</div></section>;

  if (!currentUser || currentUser.role !== "owner") {
    return <section className="page-section"><div className="eyebrow">COLLABORATION</div><h1>协作管理</h1><div className="error-panel"><div><strong>当前账户没有成员管理权限</strong><p>{error || "请退出当前账户，并使用主人令牌重新登录。"}</p></div><button className="secondary" disabled={busy} onClick={logoutForOwner}>退出并重新登录</button></div></section>;
  }

  const create = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    void createUser({ name: name.trim(), role }).then((result) => {
      setUsers((items) => [...items, result.user]);
      setToken(result.token);
      setName("");
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "新增成员失败")).finally(() => setBusy(false));
  };

  const toggleMember = (user: Collaborator): void => {
    if (!window.confirm(`${user.isActive ? "停用" : "启用"}${user.name}？`)) return;
    setBusy(true);
    setError("");
    void updateUser(user.id, !user.isActive).then(() => {
      setUsers((items) => items.map((item) => item.id === user.id ? { ...item, isActive: !item.isActive } : item));
      setNotice(`${user.name}已${user.isActive ? "停用" : "启用"}`);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "成员状态更新失败")).finally(() => setBusy(false));
  };

  const rotateToken = (user: Collaborator): void => {
    if (!window.confirm(`重新生成 ${user.name} 的令牌会使旧令牌失效，继续吗？`)) return;
    setBusy(true);
    setError("");
    setNotice("");
    void rotateUserToken(user.id).then((result) => setToken(result.token)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "令牌生成失败")).finally(() => setBusy(false));
  };

  return <section className="page-section"><div className="eyebrow">COLLABORATION</div><h1>协作管理</h1><p className="page-subtitle">停用成员会立即让会话和长期令牌失效；启用后请重新生成令牌。</p>{error && <div className="error-panel">{error}<button className="secondary" onClick={load}>重试</button></div>}{notice && <p className="notice">{notice}</p>}<form className="create-row" onSubmit={create}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="成员名称" /><select value={role} onChange={(event) => setRole(event.target.value as "assistant" | "viewer")}><option value="assistant">助理</option><option value="viewer">查看者</option></select><button disabled={!name.trim() || busy}>{busy ? "创建中…" : "新增成员"}</button></form><div className="access-address"><strong>助理访问地址</strong>{accessInfo?.lanUrls.length ? <div className="lan-address-list">{accessInfo.lanUrls.map((url) => <div className="copy-row" key={url}><code>{url}</code><button className="secondary" onClick={() => copy(url, "访问地址")}>复制</button></div>)}</div> : <p className="muted">未检测到局域网地址，请确认正式服务使用 <code>HOST=0.0.0.0</code> 启动。</p>}<p>{accessInfo?.warning ?? "仅允许同一局域网的助理访问；不要发送 127.0.0.1、0.0.0.0 或带令牌的链接。"}</p></div>{token && <div className="token-panel"><strong>长期令牌（仅显示一次）</strong><code>{token}</code><div className="item-actions"><button className="secondary" onClick={() => copy(token, "长期令牌")}>复制令牌</button><button className="secondary" onClick={() => setToken(null)}>已安全保存</button></div></div>}<div className="collection">{users.map((user) => <article className="item-card" key={user.id}><div><strong>{user.name}</strong><p>{roleLabel[user.role]} · {user.isActive ? "启用中" : "已停用"}</p></div>{user.role !== "owner" && <div className="item-actions"><button className="secondary" disabled={busy} onClick={() => toggleMember(user)}>{user.isActive ? "停用" : "启用"}</button><button className="secondary" disabled={busy || !user.isActive} onClick={() => rotateToken(user)}>重发令牌</button></div>}</article>)}</div></section>;
}

export function ReviewPage(): React.ReactElement {
  const [data, setData] = useState<ReviewData | null>(null); const [members, setMembers] = useState<Collaborator[]>([]); const [range, setRange] = useState("month"); const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [ownerId, setOwnerId] = useState(""); const [status, setStatus] = useState(""); const [error, setError] = useState("");
  const load = (): void => { const end = new Date(); const start = new Date(); if (range === "week") start.setDate(end.getDate() - 7); if (range === "month") start.setDate(end.getDate() - 30); const filters = { from: range === "custom" ? from : range === "all" ? "" : formatDate(start), to: range === "custom" ? to : range === "all" ? "" : formatDate(end), ownerId, status }; setError(""); void getReview(filters).then(setData).catch((e: unknown) => setError(e instanceof Error ? e.message : "加载统计失败")); };
  useEffect(() => { void getUsers().then(setMembers).catch(() => setMembers([])); }, []); useEffect(load, [range, ownerId, status]);
  return <section className="page-section"><div className="eyebrow">REVIEW</div><h1>回顾统计</h1><div className="filter-row"><select value={range} onChange={(e) => setRange(e.target.value)}><option value="week">最近 7 天</option><option value="month">最近 30 天</option><option value="all">全部时间</option><option value="custom">自定义范围</option></select>{range === "custom" && <><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></>}<select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}><option value="">全部负责人</option><option value="unassigned">未分配</option>{members.filter((m) => m.role !== "viewer").map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">全部状态</option><option value="todo">待办</option><option value="in_progress">进行中</option><option value="pending_review">待验收</option><option value="completed">已完成</option></select><button className="secondary" onClick={load}>刷新</button></div>{error && <div className="error-panel">{error}<button className="secondary" onClick={load}>重试</button></div>}{data && <><div className="dashboard-grid"><div className="stat-card"><strong>{data.summary.completionRate}%</strong><span>完成率</span></div><div className="stat-card"><strong>{data.summary.overdue}</strong><span>逾期</span></div><div className="stat-card"><strong>{data.tasks.filter((task) => task.status === "pending_review").length}</strong><span>待验收</span></div></div><div className="data-panel"><h2>任务明细</h2>{data.tasks.length ? data.tasks.map((task) => <div className="data-row" key={task.id}><span>{task.title}</span><small>{task.ownerName ?? "未分配"} · {labelsFor(task.status)} · {task.progress}%</small></div>) : <p className="muted">当前条件下没有任务。</p>}</div></>}</section>;
}

export function AccessPage({ onLogout }: { onLogout: () => void }): React.ReactElement { return <section className="page-section"><div className="eyebrow">ACCOUNT</div><h1>访问验证</h1><p className="page-subtitle">当前浏览器已通过 Cookie 会话验证。</p><button className="secondary" onClick={() => void logout().then(onLogout)}>退出当前账户</button></section>; }

function parseInbox(raw: string): Draft[] { const lines = raw.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean); let sender = ""; let messageAt = ""; const drafts: Draft[] = []; for (const line of lines) { const header = line.match(/^(.{1,24}?)(?:\s+|\s*[:：]\s*)(上午|下午|晚上)?\s*(\d{1,2}:\d{2}(?::\d{2})?)$/u); if (header) { sender = header[1]?.trim() ?? ""; messageAt = header[3] ?? ""; continue; } if (/^\[(文件|图片|链接|语音)\]/u.test(line) || line.length < 4) continue; const title = line.replace(/@\S+\s*/gu, "").slice(0, 240); const dueDate = guessDue(title); drafts.push({ id: `${Date.now()}-${drafts.length}`, title, dueDate, ownerId: "", priority: "P1", sender, messageAt, fingerprint: `${sender}\n${title}\n${messageAt || dueDate || ""}`, selected: true, duplicate: false }); } return drafts; }
function guessDue(text: string): string | null { const today = new Date(); if (text.includes("今天")) return formatDate(today); if (text.includes("明天")) { today.setDate(today.getDate() + 1); return formatDate(today); } if (text.includes("后天")) { today.setDate(today.getDate() + 2); return formatDate(today); } const match = text.match(/(\d{1,2})月(\d{1,2})[日号]?/u); return match ? `${today.getFullYear()}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}` : null; }
function formatDate(value: Date): string { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; }
function labelsFor(status: Task["status"]): string { return ({ todo: "待办", in_progress: "进行中", pending_review: "待验收", completed: "已完成" })[status]; }

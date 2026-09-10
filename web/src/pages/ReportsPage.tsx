import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { approveReport, getMe, getReports, getUsers, reportFileUrl, returnReport, uploadReport, uploadReportVersion, type Collaborator, type Report, type ReportDocType } from "../services/apiClient";

const docTypeLabels: Record<ReportDocType, string> = { weekly_report: "周报", summary: "总结", other: "其他" };
const statusLabels: Record<Report["status"], string> = { submitted: "已提交", approved: "已通过", returned: "已退回" };

export function ReportsPage(): React.ReactElement {
  const [reports, setReports] = useState<Report[]>([]);
  const [members, setMembers] = useState<Collaborator[]>([]);
  const [me, setMe] = useState<{ id: string; role: "owner" | "assistant" | "viewer" } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const [owner, setOwner] = useState("all");

  const load = (): void => {
    setLoading(true);
    setError("");
    void Promise.all([getReports(), getMe(), getUsers().catch(() => [] as Collaborator[])]).then(([items, current, users]) => {
      setReports(items);
      setMe(current.user);
      setMembers(users);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "周报加载失败")).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const assistants = useMemo(() => members.filter((member) => member.role === "assistant" && member.isActive), [members]);
  const filtered = useMemo(() => reports.filter((report) => (type === "all" || report.docType === type) && (status === "all" || report.status === status) && (owner === "all" || report.ownerId === owner)), [reports, type, status, owner]);

  if (loading) return <section className="page-section"><div className="loading-inline">正在加载周报…</div></section>;

  return (
    <section className="page-section">
      <div className="eyebrow">WEEKLY REPORTS</div>
      <h1>周报 / 总结</h1>
      <p className="page-subtitle">存放助理或实习生的每周周报与总结文档（Excel / Word），上传后提交主人审核。</p>
      {error && <div className="error-panel">{error}<button className="secondary" onClick={load}>重试</button></div>}
      {notice && <p className="notice">{notice}</p>}
      {me && <UploadForm me={me} assistants={assistants} onDone={(next) => { setReports((items) => [next, ...items.filter((item) => item.id !== next.id)]); setNotice(me.role === "owner" ? "已上传并提交审核" : "已提交审核"); }} onError={setError} />}
      <div className="filter-row">
        <select value={type} onChange={(event) => setType(event.target.value)}><option value="all">全部类型</option><option value="weekly_report">周报</option><option value="summary">总结</option><option value="other">其他</option></select>
        <select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option><option value="submitted">已提交</option><option value="approved">已通过</option><option value="returned">已退回</option></select>
        {me?.role === "owner" && <select value={owner} onChange={(event) => setOwner(event.target.value)}><option value="all">全部成员</option>{assistants.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select>}
      </div>
      <div className="collection">
        {filtered.length ? filtered.map((report) => <ReportCard key={report.id} report={report} me={me!} onChanged={(updated) => setReports((items) => items.map((item) => item.id === updated.id ? updated : item))} onError={setError} onNotice={setNotice} />) : <div className="empty-panel"><strong>暂无周报</strong><p>上传第一份周报或总结开始使用。</p></div>}
      </div>
    </section>
  );
}

function UploadForm({ me, assistants, onDone, onError }: { me: { id: string; role: string }; assistants: Collaborator[]; onDone: (report: Report) => void; onError: (message: string) => void }): React.ReactElement {
  const [ownerId, setOwnerId] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [docType, setDocType] = useState<ReportDocType>("weekly_report");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const isOwner = me.role === "owner";

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!file || !periodStart || !periodEnd || busy) return;
    if (isOwner && !ownerId) { onError("请选择归属人"); return; }
    setBusy(true);
    const nextOwnerId = isOwner ? ownerId : me.id;
    void uploadReport({ file, ownerId: nextOwnerId, periodStart, periodEnd, docType, note: note.trim() }).then((report) => {
      onDone(report);
      setOwnerId(""); setPeriodStart(""); setPeriodEnd(""); setDocType("weekly_report"); setNote(""); setFile(null);
    }).catch((reason: unknown) => onError(reason instanceof Error ? reason.message : "上传失败")).finally(() => setBusy(false));
  };

  return (
    <form className="report-form" onSubmit={submit}>
      {isOwner && <select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}><option value="">选择归属人（助理）</option>{assistants.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select>}
      <input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} aria-label="周期开始" />
      <input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} aria-label="周期结束" />
      <select value={docType} onChange={(event) => setDocType(event.target.value as ReportDocType)}><option value="weekly_report">周报</option><option value="summary">总结</option><option value="other">其他</option></select>
      <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="备注（可选）" />
      <input type="file" accept=".xlsx,.xls,.docx,.doc" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      <button disabled={!file || !periodStart || !periodEnd || busy || (isOwner && !ownerId)}>{busy ? "上传中…" : "上传并提交"}</button>
    </form>
  );
}

function ReportCard({ report, me, onChanged, onError, onNotice }: { report: Report; me: { id: string; role: string }; onChanged: (report: Report) => void; onError: (message: string) => void; onNotice: (message: string) => void }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const isOwner = me.role === "owner";
  const isOwnerOfReport = report.ownerId === me.id;
  const canResubmit = !isOwner && isOwnerOfReport && report.status === "returned";
  const latest = report.files[report.files.length - 1];

  const run = (fn: () => Promise<Report>): void => {
    if (busy) return;
    setBusy(true);
    void fn().then((updated) => onChanged(updated)).catch((reason: unknown) => onError(reason instanceof Error ? reason.message : "操作失败")).finally(() => setBusy(false));
  };

  return (
    <article className="item-card report-card">
      <div className="report-main">
        <div className="report-title"><strong>{report.ownerName ?? "未分配"} · {docTypeLabels[report.docType]}</strong><span className={`report-status status-${report.status}`}>{statusLabels[report.status]}</span></div>
        <p>{report.periodStart} ~ {report.periodEnd}{report.note ? ` · ${report.note}` : ""}</p>
        {report.reviewNote && <p className="review-note">主人批注：{report.reviewNote}</p>}
        <div className="report-files">
          {report.files.map((file) => <a key={file.id} href={reportFileUrl(report.id, file.version)}>v{file.version} · {file.originalName}</a>)}
        </div>
      </div>
      <div className="item-actions">
        {isOwner && report.status === "submitted" && <>
          <button className="secondary" disabled={busy} onClick={() => run(() => approveReport(report.id))}>通过</button>
          <button className="secondary" disabled={busy} onClick={() => { const note = window.prompt("请填写退回原因"); if (note && note.trim()) run(() => returnReport(report.id, note.trim())); }}>退回</button>
        </>}
        {canResubmit && <ResubmitControl report={report} onChanged={onChanged} onError={onError} onNotice={onNotice} />}
        {latest && <a className="secondary" href={reportFileUrl(report.id, latest.version)}>下载</a>}
      </div>
    </article>
  );
}

function ResubmitControl({ report, onChanged, onError, onNotice }: { report: Report; onChanged: (report: Report) => void; onError: (message: string) => void; onNotice: (message: string) => void }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const choose = (file: File | null): void => {
    if (!file) return;
    setBusy(true);
    void uploadReportVersion(report.id, file).then((updated) => { onChanged(updated); onNotice("已重新提交"); }).catch((reason: unknown) => onError(reason instanceof Error ? reason.message : "重新上传失败")).finally(() => setBusy(false));
  };
  return <label className="secondary">{busy ? "上传中…" : "重新上传"}<input type="file" hidden accept=".xlsx,.xls,.docx,.doc" disabled={busy} onChange={(event) => choose(event.target.files?.[0] ?? null)} /></label>;
}

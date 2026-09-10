import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ReportRepository, type ReportDocType, type ReportRecord } from "../../server/src/db/repositories/report-repository";
import { appConfig } from "./context.server";
import { db, now, one, rows, run, type User } from "./db.server";
import { fail } from "./http.server";
import { requireAuth } from "./session.server";

/**
 * 周报域共享逻辑：逐条对应旧 server/src/routes/report.ts 的实现，
 * 包括状态码、错误码与中文文案。契约快照会逐字校验这些字符串，不要"顺手优化"。
 */

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_EXTS = new Set([".xlsx", ".xls", ".docx", ".doc"]);

export type Upload = { fields: Record<string, string>; file: { filename: string; mimetype: string; buffer: Buffer } };

/** 上传相关的可预期错误：携带旧实现映射出的状态码与错误码 */
export class UploadError extends Error {
  public constructor(
    message: string,
    private readonly status: number,
    private readonly code: string,
  ) {
    super(message);
  }

  public toResponse(): Response {
    return fail(this.code, this.message, this.status);
  }
}

export function reportRepository(): ReportRepository {
  return new ReportRepository(db());
}

export function toView(report: ReportRecord, repo: ReportRepository): Record<string, unknown> {
  return { ...report, files: repo.listFiles(report.id) };
}

/**
 * 周报列表：主人看全部，助理只看自己的。
 * 页面 loader 与 GET /api/reports 共用这一份实现（调用方负责各自的 viewer 处理）。
 */
export function listReportsFor(user: User): Record<string, unknown>[] {
  const repo = reportRepository();
  const reports = user.role === "owner" ? repo.findAll() : repo.findByOwner(user.id);
  return reports.map((report) => toView(report, repo));
}

/** 上传表单里"归属人"下拉的数据源：启用中的助理（与旧 UI 过滤 getUsers() 的结果一致） */
export function listActiveAssistants(): Array<{ id: string; name: string }> {
  return rows<{ id: string; name: string }>(db(), "SELECT id,name FROM users WHERE role='assistant' AND is_active=1 ORDER BY name");
}

/**
 * 旧实现由 @fastify/multipart 读流：只取第一个文件，其余读完丢弃；缺文件抛"缺少上传文件"。
 * 这里用 Web 标准 FormData 复刻同样的可观察行为。
 */
export async function readUpload(request: Request): Promise<Upload> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new UploadError("上传内容无法解析", 400, "BAD_REQUEST");
  }
  const fields: Record<string, string> = {};
  let file: Upload["file"] | undefined;
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      fields[name] = value;
      continue;
    }
    if (file) continue;
    const buffer = Buffer.from(await value.arrayBuffer());
    // 旧实现由 multipart 的 fileSize 限制抛 FST_REQ_FILE_TOO_LARGE → 413 FILE_TOO_LARGE
    if (buffer.length > MAX_FILE_BYTES) throw new UploadError("文件超过 20MB 大小限制", 413, "FILE_TOO_LARGE");
    // 无 Content-Type 的分片在旧实现里被报成 application/octet-stream，这里保持一致
    file = { filename: value.name, mimetype: value.type || "application/octet-stream", buffer };
  }
  if (!file) throw new UploadError("缺少上传文件", 400, "BAD_REQUEST");
  return { fields, file };
}

export function handleUploadError(error: unknown): Response {
  if (error instanceof UploadError) return error.toResponse();
  return fail("BAD_REQUEST", "上传内容无法解析", 400);
}

export async function persistFile(
  uploadsDir: string,
  reportId: string,
  version: number,
  upload: Upload,
  ext: string,
): Promise<{ storedName: string; size: number }> {
  const dir = path.join(uploadsDir, reportId);
  await fsp.mkdir(dir, { recursive: true });
  const storedName = `v${version}${ext}`;
  const targetPath = path.join(dir, storedName);
  if (upload.file.buffer.length > MAX_FILE_BYTES) {
    throw new UploadError("文件超过 20MB 大小限制", 413, "FILE_TOO_LARGE");
  }
  await fsp.writeFile(targetPath, upload.file.buffer, { flag: "wx" });
  return { storedName, size: upload.file.buffer.length };
}

export function validateAssistant(
  database: DatabaseSync,
  id: string | null,
): { valid: true; id: string; name: string } | { valid: false; message: string } {
  if (!id) return { valid: false, message: "请选择归属人" };
  const row = one(database, "SELECT id,name,role,is_active AS isActive FROM users WHERE id=?", id);
  if (!row) return { valid: false, message: "归属人不存在" };
  if (Number(row.isActive) !== 1) return { valid: false, message: "归属人已停用" };
  if (row.role !== "assistant") return { valid: false, message: "周报只能归属助理" };
  return { valid: true, id: String(row.id), name: String(row.name) };
}

export function resolveOwnerId(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed || null;
}

export function normalizeDocType(value: string | undefined): ReportDocType | null {
  return value === "weekly_report" || value === "summary" || value === "other" ? value : null;
}

export function isAllowedExt(ext: string): boolean {
  return ALLOWED_EXTS.has(ext);
}

export function extensionOf(filename: string): string {
  const base = path.basename(filename ?? "");
  const index = base.lastIndexOf(".");
  return index > 0 ? base.slice(index).toLowerCase() : "";
}

// 文件名来自外部上传，必须剔除控制字符与路径分隔符，因此这里刻意匹配控制字符
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f/\\]/gu;
export function sanitizeName(filename: string): string {
  return (
    path
      .basename(filename ?? "")
      .replace(CONTROL_CHARS, "")
      .slice(0, 200) || "未命名文件"
  );
}

export function extFromStoredName(storedName: string): string {
  return path.extname(storedName).toLowerCase();
}

export function mimeFor(ext: string): string {
  const map: Record<string, string> = {
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
  };
  return map[ext] ?? "application/octet-stream";
}

export function notifyReport(
  database: DatabaseSync,
  recipientId: string,
  actorId: string,
  reportId: string,
  type: string,
  title: string,
  message: string,
): void {
  if (!recipientId || recipientId === actorId) return;
  run(
    database,
    "INSERT INTO notifications(id,recipient_id,actor_id,task_id,report_id,event_type,title,message,is_read,created_at,read_at) VALUES(?,?,?,NULL,?,?,?,?,0,?,NULL)",
    randomUUID(),
    recipientId,
    actorId,
    reportId,
    type,
    title,
    message,
    now(),
  );
}

/**
 * 注意：旧 report.ts 的 owner 文案是"只有主人可以执行此操作"，
 * 与 app/lib/session.server.ts 的 requireOwner（"只有主人可以访问此功能"）不同，
 * 因此这里不能复用后者，否则周报域用例会因文案不一致而失败。
 */
export function requireOwnerForReports(request: Request): { ok: true; user: User } | { ok: false; response: Response } {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth;
  if (auth.user.role !== "owner") return { ok: false, response: fail("FORBIDDEN", "只有主人可以执行此操作", 403) };
  return { ok: true, user: auth.user };
}

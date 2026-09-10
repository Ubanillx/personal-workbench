import { createHash, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseClient } from "../db/client";
import type { AppConfig } from "../config/env";
import { ReportRepository, type ReportDocType, type ReportRecord, type ReportStatus } from "../db/repositories/report-repository";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_EXTS = new Set([".xlsx", ".xls", ".docx", ".doc"]);

type User = { id: string; name: string; role: "owner" | "assistant" | "viewer"; isActive: boolean };
type Db = any;
type Options = { config: AppConfig; database: DatabaseClient; uploadsDir: string };

export async function registerReportRoutes(app: FastifyInstance, options: Options): Promise<void> {
  const db = options.database.getDatabase();
  const cookie = options.config.sessionCookieName;
  const repo = new ReportRepository(db);

  app.get("/api/reports", async (request, reply) => {
    const user = requireAuth(request, reply, db, cookie);
    if (!user) return;
    if (user.role === "viewer") return reply.code(403).send(fail("FORBIDDEN", "查看者不能访问周报"));
    const reports = user.role === "owner" ? repo.findAll() : repo.findByOwner(user.id);
    return reply.send(ok(reports.map((report) => toView(report, repo))));
  });

  app.get("/api/reports/:id", async (request, reply) => {
    const user = requireAuth(request, reply, db, cookie);
    if (!user) return;
    if (user.role === "viewer") return reply.code(403).send(fail("FORBIDDEN", "查看者不能访问周报"));
    const report = repo.findById(idOf(request));
    if (!report) return reply.code(404).send(fail("NOT_FOUND", "周报不存在"));
    if (user.role === "assistant" && report.ownerId !== user.id) return reply.code(403).send(fail("FORBIDDEN", "无权查看该周报"));
    return reply.send(ok(toView(report, repo)));
  });

  app.post("/api/reports", async (request, reply) => {
    const user = requireAuth(request, reply, db, cookie);
    if (!user) return;
    if (user.role === "viewer") return reply.code(403).send(fail("FORBIDDEN", "查看者不能上传周报"));
    let upload: Upload;
    try {
      upload = await readUpload(request);
    } catch (error) {
      return handleUploadError(reply, error);
    }
    const fields = upload.fields;
    const periodStart = dateValue(fields.periodStart);
    const periodEnd = dateValue(fields.periodEnd);
    if (!periodStart || !periodEnd) return reply.code(400).send(fail("VALIDATION_ERROR", "请填写周期开始和结束日期"));
    if (periodStart > periodEnd) return reply.code(400).send(fail("VALIDATION_ERROR", "周期开始日期不能晚于结束日期"));
    const docType = normalizeDocType(fields.docType);
    if (!docType) return reply.code(400).send(fail("VALIDATION_ERROR", "请选择文档类型"));
    const ext = extensionOf(upload.file.filename);
    if (!ALLOWED_EXTS.has(ext)) return reply.code(400).send(fail("VALIDATION_ERROR", "仅支持 .xlsx / .xls / .docx / .doc 文件"));
    const ownerId = user.role === "assistant" ? user.id : resolveOwnerId(db, fields.ownerId);
    const owner = validateAssistant(db, ownerId);
    if (!owner.valid) return reply.code(400).send(fail("VALIDATION_ERROR", owner.message));

    const id = randomUUID();
    const stamp = now();
    const report: ReportRecord = {
      id, ownerId: owner.id!, ownerName: owner.name!, periodStart, periodEnd, docType,
      note: String(fields.note ?? "").trim().slice(0, 2000),
      status: "submitted", currentVersion: 1, uploadedBy: user.id, reviewNote: null,
      createdAt: stamp, updatedAt: stamp, submittedAt: stamp, reviewedAt: null, returnedAt: null
    };
    const file = await persistFile(options.uploadsDir, id, 1, upload, ext);
    repo.create(report);
    repo.addFile({ id: randomUUID(), reportId: id, version: 1, originalName: sanitizeName(upload.file.filename), storedName: file.storedName, sizeBytes: file.size, ext, mimeType: upload.file.mimetype || null, uploadedBy: user.id, uploadedAt: stamp });
    if (user.role === "assistant") notifyReport(db, "owner", user.id, id, "report_submitted", "收到新周报", `${user.name} 提交了 ${periodStart}~${periodEnd} 的周报`);
    return reply.code(201).send(ok(toView(repo.findById(id)!, repo)));
  });

  app.post("/api/reports/:id/file", async (request, reply) => {
    const user = requireAuth(request, reply, db, cookie);
    if (!user) return;
    if (user.role === "viewer") return reply.code(403).send(fail("FORBIDDEN", "查看者不能上传周报"));
    const report = repo.findById(idOf(request));
    if (!report) return reply.code(404).send(fail("NOT_FOUND", "周报不存在"));
    if (user.role !== "owner" && report.ownerId !== user.id) return reply.code(403).send(fail("FORBIDDEN", "无权操作该周报"));
    if (report.status !== "returned") return reply.code(400).send(fail("INVALID_STATE", "只有被退回的周报才能重新上传"));
    let upload: Upload;
    try {
      upload = await readUpload(request);
    } catch (error) {
      return handleUploadError(reply, error);
    }
    const ext = extensionOf(upload.file.filename);
    if (!ALLOWED_EXTS.has(ext)) return reply.code(400).send(fail("VALIDATION_ERROR", "仅支持 .xlsx / .xls / .docx / .doc 文件"));
    const version = report.currentVersion + 1;
    const stamp = now();
    const file = await persistFile(options.uploadsDir, report.id, version, upload, ext);
    repo.update(report.id, { status: "submitted", currentVersion: version, reviewNote: null, submittedAt: stamp, returnedAt: null, reviewedAt: null });
    repo.addFile({ id: randomUUID(), reportId: report.id, version, originalName: sanitizeName(upload.file.filename), storedName: file.storedName, sizeBytes: file.size, ext, mimeType: upload.file.mimetype || null, uploadedBy: user.id, uploadedAt: stamp });
    if (user.role === "assistant") notifyReport(db, "owner", user.id, report.id, "report_submitted", "周报已重新提交", `${user.name} 重新提交了 ${report.periodStart}~${report.periodEnd} 的周报`);
    return reply.code(201).send(ok(toView(repo.findById(report.id)!, repo)));
  });

  app.post("/api/reports/:id/approve", async (request, reply) => {
    const user = requireOwner(request, reply, db, cookie);
    if (!user) return;
    const report = repo.findById(idOf(request));
    if (!report) return reply.code(404).send(fail("NOT_FOUND", "周报不存在"));
    if (report.status !== "submitted") return reply.code(400).send(fail("INVALID_STATE", "只有已提交的周报才能通过"));
    const body = (request.body ?? {}) as Record<string, unknown>;
    const note = String(body.note ?? "").trim().slice(0, 2000);
    const stamp = now();
    repo.update(report.id, { status: "approved", reviewNote: note || null, reviewedAt: stamp });
    notifyReport(db, report.ownerId, user.id, report.id, "report_approved", "周报已通过", `你的周报（${report.periodStart}~${report.periodEnd}）已通过`);
    return reply.send(ok(toView(repo.findById(report.id)!, repo)));
  });

  app.post("/api/reports/:id/return", async (request, reply) => {
    const user = requireOwner(request, reply, db, cookie);
    if (!user) return;
    const report = repo.findById(idOf(request));
    if (!report) return reply.code(404).send(fail("NOT_FOUND", "周报不存在"));
    if (report.status !== "submitted") return reply.code(400).send(fail("INVALID_STATE", "只有已提交的周报才能退回"));
    const body = (request.body ?? {}) as Record<string, unknown>;
    const note = String(body.note ?? "").trim();
    if (!note) return reply.code(400).send(fail("VALIDATION_ERROR", "退回时请填写原因"));
    const stamp = now();
    repo.update(report.id, { status: "returned", reviewNote: note.slice(0, 2000), returnedAt: stamp });
    notifyReport(db, report.ownerId, user.id, report.id, "report_returned", "周报已退回", `你的周报（${report.periodStart}~${report.periodEnd}）已退回：${note.slice(0, 2000)}`);
    return reply.send(ok(toView(repo.findById(report.id)!, repo)));
  });

  app.get("/api/reports/:id/file/:version", async (request, reply) => {
    const user = requireAuth(request, reply, db, cookie);
    if (!user) return;
    if (user.role === "viewer") return reply.code(403).send(fail("FORBIDDEN", "查看者不能下载周报"));
    const report = repo.findById(idOf(request));
    if (!report) return reply.code(404).send(fail("NOT_FOUND", "周报不存在"));
    if (user.role === "assistant" && report.ownerId !== user.id) return reply.code(403).send(fail("FORBIDDEN", "无权下载该周报"));
    const version = Number((request.params as { version: string }).version);
    const file = Number.isInteger(version) && version > 0 ? repo.findFile(report.id, version) : null;
    if (!file) return reply.code(404).send(fail("NOT_FOUND", "文件版本不存在"));
    const filePath = path.join(options.uploadsDir, report.id, file.storedName);
    try {
      await fsp.access(filePath);
    } catch {
      return reply.code(404).send(fail("NOT_FOUND", "文件已丢失"));
    }
    return reply
      .header("Content-Type", file.mimeType ?? mimeFor(extFromStoredName(file.storedName)))
      .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`)
      .header("Content-Length", file.sizeBytes)
      .send(await fsp.readFile(filePath));
  });
}

function toView(report: ReportRecord, repo: ReportRepository): Record<string, unknown> {
  return { ...report, files: repo.listFiles(report.id) };
}

type Upload = { fields: Record<string, string>; file: { filename: string; mimetype: string; buffer: Buffer } };

async function readUpload(request: FastifyRequest): Promise<Upload> {
  const fields: Record<string, string> = {};
  let file: Upload["file"] | undefined;
  for await (const part of request.parts()) {
    if (part.type === "field") {
      if (part.fieldname) fields[part.fieldname] = String(part.value ?? "");
    } else if (part.type === "file") {
      if (file) {
        await part.toBuffer();
        continue;
      }
      file = { filename: part.filename, mimetype: part.mimetype, buffer: await part.toBuffer() };
    }
  }
  if (!file) throw new UploadError("缺少上传文件");
  return { fields, file };
}

class UploadError extends Error {}

async function persistFile(uploadsDir: string, reportId: string, version: number, upload: Upload, ext: string): Promise<{ storedName: string; size: number }> {
  const dir = path.join(uploadsDir, reportId);
  await fsp.mkdir(dir, { recursive: true });
  const storedName = `v${version}${ext}`;
  const targetPath = path.join(dir, storedName);
  if (upload.file.buffer.length > MAX_FILE_BYTES) {
    throw new UploadError("文件超过 20MB 大小限制");
  }
  await fsp.writeFile(targetPath, upload.file.buffer, { flag: "wx" });
  return { storedName, size: upload.file.buffer.length };
}

function handleUploadError(reply: FastifyReply, error: unknown): void {
  if (error instanceof UploadError) {
    const tooLarge = error.message.includes("大小限制");
    void reply.code(tooLarge ? 413 : 400).send(fail(tooLarge ? "FILE_TOO_LARGE" : "BAD_REQUEST", error.message));
    return;
  }
  if (error instanceof Error && "code" in error && error.code === "FST_REQ_FILE_TOO_LARGE") {
    void reply.code(413).send(fail("FILE_TOO_LARGE", "文件超过 20MB 大小限制"));
    return;
  }
  void reply.code(400).send(fail("BAD_REQUEST", "上传内容无法解析"));
}

function validateAssistant(db: Db, id: string | null): { valid: true; id: string; name: string } | { valid: false; message: string } {
  if (!id) return { valid: false, message: "请选择归属人" };
  const row = one(db, "SELECT id,name,role,is_active AS isActive FROM users WHERE id=?", id);
  if (!row) return { valid: false, message: "归属人不存在" };
  if (Number(row.isActive) !== 1) return { valid: false, message: "归属人已停用" };
  if (row.role !== "assistant") return { valid: false, message: "周报只能归属助理" };
  return { valid: true, id: String(row.id), name: String(row.name) };
}

function resolveOwnerId(db: Db, value: string | undefined): string | null {
  const v = (value ?? "").trim();
  return v || null;
}

function auth(request: FastifyRequest, db: Db, cookie: string): User | null {
  const raw = request.cookies[cookie];
  if (!raw) return null;
  const row = one(db, "SELECT u.id,u.name,u.role,u.is_active AS isActive FROM access_sessions s JOIN users u ON u.id=s.user_id WHERE s.session_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.is_active=1", hash(raw), now());
  return row ? toUser(row) : null;
}
function requireAuth(request: FastifyRequest, reply: FastifyReply, db: Db, cookie: string): User | null {
  const user = auth(request, db, cookie);
  if (!user) { void reply.code(401).send(fail("UNAUTHENTICATED", "请先完成访问验证")); return null; }
  return user;
}
function requireOwner(request: FastifyRequest, reply: FastifyReply, db: Db, cookie: string): User | null {
  const user = requireAuth(request, reply, db, cookie);
  if (!user) return null;
  if (user.role !== "owner") { void reply.code(403).send(fail("FORBIDDEN", "只有主人可以执行此操作")); return null; }
  return user;
}

function dateValue(value: string | undefined): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null;
}
function normalizeDocType(value: string | undefined): ReportDocType | null {
  return value === "weekly_report" || value === "summary" || value === "other" ? value : null;
}
function extensionOf(filename: string): string {
  const base = path.basename(filename ?? "");
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx).toLowerCase() : "";
}
function sanitizeName(filename: string): string {
  return path.basename(filename ?? "").replace(/[\u0000-\u001f/\\]/gu, "").slice(0, 200) || "未命名文件";
}
function extFromStoredName(storedName: string): string {
  return path.extname(storedName).toLowerCase();
}
function mimeFor(ext: string): string {
  const map: Record<string, string> = { ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".doc": "application/msword" };
  return map[ext] ?? "application/octet-stream";
}
function idOf(request: FastifyRequest): string { return String((request.params as { id: string }).id); }
function toUser(row: Record<string, unknown>): User { return { id: String(row.id), name: String(row.name), role: String(row.role) as User["role"], isActive: Number(row.isActive ?? row.is_active) === 1 }; }
function now(): string { return new Date().toISOString(); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function one(db: Db, sql: string, ...params: unknown[]): any { return db.prepare(sql).get(...params) ?? null; }
function run(db: Db, sql: string, ...params: unknown[]): any { return db.prepare(sql).run(...params); }
function notifyReport(db: Db, recipientId: string, actorId: string, reportId: string, type: string, title: string, message: string): void {
  if (!recipientId || recipientId === actorId) return;
  run(db, "INSERT INTO notifications(id,recipient_id,actor_id,task_id,report_id,event_type,title,message,is_read,created_at,read_at) VALUES(?,?,?,NULL,?,?,?,?,0,?,NULL)", randomUUID(), recipientId, actorId, reportId, type, title, message, now());
}
function ok<T>(data: T): { ok: true; data: T } { return { ok: true, data }; }
function fail(code: string, message: string): { ok: false; error: { code: string; message: string } } { return { ok: false, error: { code, message } }; }

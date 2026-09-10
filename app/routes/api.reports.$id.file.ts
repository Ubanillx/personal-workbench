import { randomUUID } from "node:crypto";
import { appConfig } from "../lib/context.server";
import { db, now } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import {
  extensionOf,
  handleUploadError,
  isAllowedExt,
  notifyReport,
  persistFile,
  readUpload,
  reportRepository,
  sanitizeName,
  toView,
  type Upload,
} from "../lib/reports.server";
import { requireAuth } from "../lib/session.server";

/**
 * POST /api/reports/:id/file —— 重新上传（仅"已退回"状态）。
 * 分支顺序与旧实现一致：先状态校验再读上传体，因此状态不符时不会解析 multipart。
 */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  if (user.role === "viewer") return fail("FORBIDDEN", "查看者不能上传周报", 403);

  const repo = reportRepository();
  const report = repo.findById(String(params.id));
  if (!report) return fail("NOT_FOUND", "周报不存在", 404);
  if (user.role !== "owner" && report.ownerId !== user.id) return fail("FORBIDDEN", "无权操作该周报", 403);
  if (report.status !== "returned") return fail("INVALID_STATE", "只有被退回的周报才能重新上传", 400);

  let upload: Upload;
  try {
    upload = await readUpload(request);
  } catch (error) {
    return handleUploadError(error);
  }
  const ext = extensionOf(upload.file.filename);
  if (!isAllowedExt(ext)) return fail("VALIDATION_ERROR", "仅支持 .xlsx / .xls / .docx / .doc 文件", 400);

  const version = report.currentVersion + 1;
  const stamp = now();
  const file = await persistFile(appConfig().uploadsDir, report.id, version, upload, ext);
  repo.update(report.id, {
    status: "submitted",
    currentVersion: version,
    reviewNote: null,
    submittedAt: stamp,
    returnedAt: null,
    reviewedAt: null,
  });
  repo.addFile({
    id: randomUUID(),
    reportId: report.id,
    version,
    originalName: sanitizeName(upload.file.filename),
    storedName: file.storedName,
    sizeBytes: file.size,
    ext,
    mimeType: upload.file.mimetype || null,
    uploadedBy: user.id,
    uploadedAt: stamp,
  });
  if (user.role === "assistant") {
    notifyReport(
      db(),
      "owner",
      user.id,
      report.id,
      "report_submitted",
      "周报已重新提交",
      `${user.name} 重新提交了 ${report.periodStart}~${report.periodEnd} 的周报`,
    );
  }
  const updated = repo.findById(report.id);
  if (!updated) throw new Error("Report not found");
  return ok(toView(updated, repo), 201);
}

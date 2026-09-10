import { promises as fsp } from "node:fs";
import path from "node:path";
import { appConfig } from "../lib/context.server";
import { fail, withSecurityHeaders } from "../lib/http.server";
import { extFromStoredName, mimeFor, reportRepository } from "../lib/reports.server";
import { requireAuth } from "../lib/session.server";

/**
 * GET /api/reports/:id/file/:version —— 下载指定版本。
 * 响应体是二进制，必须用 withSecurityHeaders 补上 CSP/nosniff（旧实现经由 helmet 也带了这些头）。
 */
export async function loader({ request, params }: { request: Request; params: { id?: string; version?: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  if (user.role === "viewer") return fail("FORBIDDEN", "查看者不能下载周报", 403);

  const repo = reportRepository();
  const report = repo.findById(String(params.id));
  if (!report) return fail("NOT_FOUND", "周报不存在", 404);
  if (user.role === "assistant" && report.ownerId !== user.id) return fail("FORBIDDEN", "无权下载该周报", 403);

  const version = Number(params.version);
  const file = Number.isInteger(version) && version > 0 ? repo.findFile(report.id, version) : null;
  if (!file) return fail("NOT_FOUND", "文件版本不存在", 404);

  const filePath = path.join(appConfig().uploadsDir, report.id, file.storedName);
  try {
    await fsp.access(filePath);
  } catch {
    return fail("NOT_FOUND", "文件已丢失", 404);
  }
  const content = await fsp.readFile(filePath);
  return withSecurityHeaders(
    new Response(new Uint8Array(content), {
      status: 200,
      headers: {
        "content-type": file.mimeType ?? mimeFor(extFromStoredName(file.storedName)),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
        "content-length": String(file.sizeBytes),
      },
    }),
  );
}

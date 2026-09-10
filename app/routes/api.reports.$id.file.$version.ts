import { promises as fsp } from "node:fs";
import path from "node:path";
import { appConfig } from "../lib/context.server";
import { fail, withSecurityHeaders } from "../lib/http.server";
import { extFromStoredName, getReportFile, mimeFor } from "../lib/reports.server";
import { requireAuth } from "../lib/session.server";

/**
 * GET /api/reports/:id/file/:version —— 下载指定版本。
 * 文件经 `report_id` 关联到周报，必须先过周报的组织边界：跨组织一律 404（§4 不变式 1）。
 * 响应体是二进制，必须用 withSecurityHeaders 补上 CSP/nosniff（旧实现经由 helmet 也带了这些头）。
 */
export async function loader({ request, params }: { request: Request; params: { id?: string; version?: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;

  const result = getReportFile(auth.user, String(params.id), Number(params.version));
  if (!result.ok) return fail(result.code, result.message, result.status);
  const file = result.data;

  const filePath = path.join(appConfig().uploadsDir, file.reportId, file.storedName);
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

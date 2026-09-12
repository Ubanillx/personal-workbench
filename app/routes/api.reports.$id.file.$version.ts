import { appConfig } from "../lib/context.server";
import { fail, withSecurityHeaders } from "../lib/http.server";
import { extFromStoredName, getReportFile, mimeFor, openReportFile } from "../lib/reports.server";
import { reportStorageCode, reportStorageMessage, reportStorageStatus } from "../lib/report-storage.server";
import { requireAuth } from "../lib/session.server";

/**
 * GET /api/reports/:id/file/:version —— 下载指定版本。
 *
 * 文件经 `report_id` 关联到周报，必须先过周报的组织边界：跨组织一律 404（§4 不变式 1）。
 *
 * 正文自 D-46 起**存在 NAS 上**（`stored_name` = `webdav:<远端路径>`），所以这里是
 * **流式代理**：浏览器 → 本服务 → NAS。走代理而不是 302 直链，是为了让组织隔离与登录校验
 * 继续生效、并且 NAS 凭据不出服务器（见 docs/harness/REPORTS_WEBDAV.md §5.2）。
 * 还没搬走的老记录（`stored_name` 无前缀）仍读本地目录，兼容分支在 `openReportFile` 里。
 *
 * 响应体是二进制，必须用 withSecurityHeaders 补上 CSP/nosniff（旧实现经由 helmet 也带了这些头）。
 */
export async function loader({ request, params }: { request: Request; params: { id?: string; version?: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;

  const result = getReportFile(auth.user, String(params.id), Number(params.version));
  if (!result.ok) return fail(result.code, result.message, result.status);
  const file = result.data;

  let opened: Awaited<ReturnType<typeof openReportFile>>;
  try {
    opened = await openReportFile(file.storedName, file.reportId, appConfig().uploadsDir);
  } catch (error) {
    // NAS 连不上 / 未配置 / 认证失败：给 502/503 + 一句人话，而不是 500
    return fail(reportStorageCode(error), reportStorageMessage(error), reportStorageStatus(error));
  }
  if (!opened) return fail("NOT_FOUND", "文件已丢失", 404);

  const headers: Record<string, string> = {
    "content-type": file.mimeType ?? mimeFor(extFromStoredName(file.storedName)),
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
  };
  // content-length 只在远端明确给出时带上（分块传输时留空，让运行时自己决定）
  const size = opened.size ?? null;
  if (typeof size === "number" && Number.isFinite(size) && size >= 0) headers["content-length"] = String(size);

  return withSecurityHeaders(new Response(opened.body, { status: 200, headers }));
}

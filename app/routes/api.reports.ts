import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { createReport, handleUploadError, listReportsFor, readUpload, type Upload } from "../lib/reports.server";
import { requireAuth } from "../lib/session.server";

/** GET /api/reports —— 管理员看全部组织，组织管理者看本组织，普通用户只看自己提交的（与页面 loader 共用实现） */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  return ok(listReportsFor(auth.user));
}

/**
 * POST /api/reports —— multipart 建单（字段：periodStart/periodEnd/docType/note/ownerId + file）。
 * 字段校验、组织归属、落盘与通知都在 app/lib/reports.server.ts，路由只负责读上传体与落响应。
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  let upload: Upload;
  try {
    upload = await readUpload(request);
  } catch (error) {
    return handleUploadError(error);
  }
  const result = await createReport(auth.user, upload);
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}

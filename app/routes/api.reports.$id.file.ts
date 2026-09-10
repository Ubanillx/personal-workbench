import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { handleUploadError, readUpload, reuploadReport, reuploadTarget, type Upload } from "../lib/reports.server";
import { requireAuth } from "../lib/session.server";

/**
 * POST /api/reports/:id/file —— 重新上传（仅"已退回"状态）。
 * 分支顺序与旧实现一致：先做可见性/权限/状态校验，再读上传体，因此状态不符时不会解析 multipart。
 * `report_files` 没有 org_id，经 `report_id` 关联到周报后才判定组织边界（§14.2），逻辑都在 app/lib/reports.server.ts。
 */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;

  const target = reuploadTarget(auth.user, String(params.id));
  if (!target.ok) return fail(target.code, target.message, target.status);

  let upload: Upload;
  try {
    upload = await readUpload(request);
  } catch (error) {
    return handleUploadError(error);
  }
  const result = await reuploadReport(auth.user, target.data, upload);
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}

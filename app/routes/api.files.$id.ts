import { appConfig } from "../lib/context.server";
import { deleteFileRecord } from "../lib/files.server";
import { ok } from "../lib/http.server";
import { failureResponse } from "../lib/records.server";
import { requireManager } from "../lib/session.server";

/** DELETE /api/files/:id —— 文件库限管理员与组织管理者（§4）；不存在与跨组织一律 404 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const removed = deleteFileRecord(auth.user, params.id);
  if (!removed.ok) return failureResponse(removed);
  return ok(null);
}

import { appConfig } from "../lib/context.server";
import { markFileUsedRecord } from "../lib/files.server";
import { ok } from "../lib/http.server";
import { failureResponse } from "../lib/records.server";
import { requireManager } from "../lib/session.server";

/** POST /api/files/:id/use —— 标记最近使用；文件库限管理员与组织管理者（§4），不存在与跨组织一律 404 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const used = markFileUsedRecord(auth.user, params.id);
  if (!used.ok) return failureResponse(used);
  return ok(used.data);
}

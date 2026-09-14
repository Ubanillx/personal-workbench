import { appConfig } from "../lib/context.server";
import { markFileUsedRecord } from "../lib/files.server";
import { ok } from "../lib/http.server";
import { failureResponse } from "../lib/records.server";
import { requireAuth } from "../lib/session.server";

/** POST /api/files/:id/use —— 标记最近使用（组织内所有人都可以）；不存在与跨组织一律 404 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const used = markFileUsedRecord(auth.user, params.id);
  if (!used.ok) return failureResponse(used);
  return ok(used.data);
}

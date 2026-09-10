import { appConfig } from "../lib/context.server";
import { deleteFileRecord } from "../lib/files.server";
import { ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";

/** DELETE /api/files/:id —— 仅主人；不存在也返回 200 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  deleteFileRecord(params.id);
  return ok(null);
}

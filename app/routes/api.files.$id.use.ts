import { appConfig } from "../lib/context.server";
import { fileExists, markFileUsedRecord } from "../lib/files.server";
import { fail, ok } from "../lib/http.server";
import { findFile } from "../lib/records.server";
import { requireOwner } from "../lib/session.server";

/** POST /api/files/:id/use —— 标记最近使用 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = params.id;
  if (!fileExists(id)) return fail("NOT_FOUND", "文件不存在", 404);
  markFileUsedRecord(id);
  return ok(findFile(id));
}

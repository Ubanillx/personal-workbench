import { appConfig } from "../lib/context.server";
import { createFileRecord, listFiles } from "../lib/files.server";
import { fail, ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";

/** GET /api/files —— 逻辑在 app/lib/files.server.ts，与文件页 loader 共用 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const query = new URL(request.url).searchParams;
  return ok(listFiles((query.get("search") ?? "").trim(), (query.get("category") ?? "").trim()));
}

/** POST /api/files —— 逻辑同上，与文件页 action 共用 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const created = createFileRecord({
    name: String(body.name ?? ""),
    filePath: String(body.filePath ?? ""),
    category: String(body.category ?? ""),
  });
  if (!created) return fail("VALIDATION_ERROR", "文件名称和路径不能为空", 400);
  return ok(created, 201);
}

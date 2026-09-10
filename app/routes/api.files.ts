import { appConfig } from "../lib/context.server";
import { createFileRecord, listFiles } from "../lib/files.server";
import { fail, ok } from "../lib/http.server";
import { requireManager } from "../lib/session.server";

/**
 * GET /api/files —— 逻辑在 app/lib/files.server.ts，与文件页 loader 共用。
 * 文件库只对管理员与组织管理者开放（§4），因此这里是 requireManager：
 * 角色不够是 403（不是 404），跨组织才是 404。`?org=` 是管理员（D-28）的筛选器接缝。
 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const query = new URL(request.url).searchParams;
  // 组织筛选器只对管理员有意义（D-28），与 /api/tasks 的写法一致
  const orgFilter = auth.user.role === "admin" ? query.get("org") : null;
  return ok(listFiles(auth.user, (query.get("search") ?? "").trim(), (query.get("category") ?? "").trim(), orgFilter));
}

/** POST /api/files —— 逻辑同上，与文件页 action 共用 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const created = createFileRecord(auth.user, {
    name: String(body.name ?? ""),
    filePath: String(body.filePath ?? ""),
    category: String(body.category ?? ""),
    orgId: body.orgId,
  });
  if (!created.ok) return fail(created.code, created.message, created.status);
  return ok(created.data, created.status);
}

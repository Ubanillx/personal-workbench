import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { createNoteRecord, listNotes } from "../lib/notes.server";
import { requireOwner } from "../lib/session.server";

/** GET /api/notes —— 仅主人；逻辑在 app/lib/notes.server.ts */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  return ok(listNotes());
}

/** POST /api/notes —— 逻辑在 app/lib/notes.server.ts（与页面表单 action 共用） */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const created = createNoteRecord(body.content);
  if (!created) return fail("VALIDATION_ERROR", "笔记内容不能为空", 400);
  return ok(created, 201);
}

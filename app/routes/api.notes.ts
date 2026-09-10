import { randomUUID } from "node:crypto";
import { appConfig } from "../lib/context.server";
import { db, now, rows, run } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { findNote } from "../lib/records.server";
import { requireOwner } from "../lib/session.server";

/** GET /api/notes —— 仅主人 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  return ok(
    rows(
      db(),
      "SELECT id,content,is_pinned AS isPinned,created_at AS createdAt,updated_at AS updatedAt FROM notes ORDER BY updated_at DESC",
    ),
  );
}

/** POST /api/notes */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const content = String(body.content ?? "").trim();
  if (!content) return fail("VALIDATION_ERROR", "笔记内容不能为空", 400);
  const stamp = now();
  const id = randomUUID();
  run(db(), "INSERT INTO notes(id,content,is_pinned,created_at,updated_at) VALUES(?,?,?,?,?)", id, content, 0, stamp, stamp);
  return ok(findNote(id), 201);
}

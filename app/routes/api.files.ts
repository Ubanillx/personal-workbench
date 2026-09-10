import { randomUUID } from "node:crypto";
import { appConfig } from "../lib/context.server";
import { db, now, rows, run } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { findFile } from "../lib/records.server";
import { requireOwner } from "../lib/session.server";

/** GET /api/files —— 仅主人；支持 search 与 category 过滤 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const query = new URL(request.url).searchParams;
  const search = (query.get("search") ?? "").trim();
  const category = (query.get("category") ?? "").trim();
  const conditions: string[] = [];
  const params: string[] = [];
  if (search) {
    conditions.push("(name LIKE ? OR file_path LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  if (category) {
    conditions.push("category=?");
    params.push(category);
  }
  return ok(
    rows(
      db(),
      `SELECT id,name,file_path AS filePath,category,last_used_at AS lastUsedAt,created_at AS createdAt,updated_at AS updatedAt FROM important_files ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY COALESCE(last_used_at,updated_at) DESC`,
      ...params,
    ),
  );
}

/** POST /api/files —— 登记文件路径索引 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const name = String(body.name ?? "").trim();
  const filePath = String(body.filePath ?? "").trim();
  if (!name || !filePath) return fail("VALIDATION_ERROR", "文件名称和路径不能为空", 400);
  const stamp = now();
  const id = randomUUID();
  run(
    db(),
    "INSERT INTO important_files(id,name,file_path,category,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    id,
    name,
    filePath,
    String(body.category ?? "").trim(),
    null,
    stamp,
    stamp,
  );
  return ok(findFile(id), 201);
}

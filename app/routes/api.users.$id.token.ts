import { randomUUID } from "node:crypto";
import { db, hash, newToken, now, run } from "../lib/db.server";
import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";
import { memberExists } from "../lib/users.server";

/** POST /api/users/:id/token —— 重新签发成员令牌（旧令牌立即失效） */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = params.id;
  if (!memberExists(id)) return fail("NOT_FOUND", "成员不存在", 404);
  const token = newToken();
  const stamp = now();
  run(db(), "UPDATE access_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", stamp, id);
  run(
    db(),
    "INSERT INTO access_tokens(id,user_id,token_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,NULL,NULL)",
    randomUUID(),
    id,
    hash(token),
    stamp,
  );
  return ok({ token });
}

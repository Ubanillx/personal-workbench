import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabaseClient, type DatabaseClient } from "../../server/src/db/client";
import { resetOwnerAccess } from "../../server/src/security/owner-token";
import { findFreePort, startServer } from "../../tools/contract/runner";

const migrationsDirectory = path.resolve(process.cwd(), "server/src/db/migrations");
const COOKIE = "workbench_session";

/**
 * 端到端验证"主人令牌重置"在 **当前实现** 的 HTTP 层真的生效。
 * 先准备好"已重置"的库，再用 `npm run serve` 拉起真实服务打请求。
 * 需要先 `npm run build`（与 test:api、test:ui 相同前提）。
 */
test("重置主人令牌后，HTTP 层拒绝旧主人令牌与旧会话，助理不受影响", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-owner-http-"));
  const databasePath = path.join(directory, "workbench.sqlite");
  const uploadsDir = path.join(directory, "uploads");
  const database = createDatabaseClient({ databasePath, migrationsDirectory });
  seed(database);
  await database.close();

  const result = await resetOwnerAccess({ databasePath, backupDirectory: path.join(directory, "backups") });
  const port = await findFreePort();
  const server = await startServer({ serveNpm: "serve", fixture: { databasePath, uploadsDir }, port });

  t.after(async () => {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const login = (token: string): Promise<Response> =>
    fetch(`${base}/api/auth/access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
  const me = (cookie: string): Promise<Response> => fetch(`${base}/api/auth/me`, { headers: { cookie } });

  assert.equal((await login("old-owner-token")).status, 401, "旧主人令牌应被拒绝");
  assert.equal((await login("assistant-token")).status, 200, "助理令牌应仍然有效");

  const fresh = await login(result.token);
  assert.equal(fresh.status, 200, "新主人令牌应可用");
  const cookiePair = (fresh.headers.getSetCookie?.()[0] ?? fresh.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  assert.ok(cookiePair.startsWith(`${COOKIE}=`), `登录应下发 ${COOKIE} Cookie`);
  assert.equal((await me(cookiePair)).status, 200, "重置后新建的主人会话应可用");

  assert.equal((await me(`${COOKIE}=old-owner-session`)).status, 401, "旧主人会话应被拒绝");
  assert.equal((await me(`${COOKIE}=assistant-session`)).status, 200, "助理会话应仍然有效");
});

function seed(database: DatabaseClient): void {
  const db = database.getDatabase();
  const stamp = new Date().toISOString();
  const expiry = new Date(Date.now() + 86_400_000).toISOString();
  for (const [id, name, role, token, session] of [
    ["owner", "主人", "owner", "old-owner-token", "old-owner-session"],
    ["assistant", "助理", "assistant", "assistant-token", "assistant-session"],
  ] as const) {
    db.prepare("INSERT INTO users(id,name,role,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, name, role, 1, stamp, stamp);
    db.prepare("INSERT INTO access_tokens(id,user_id,token_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,NULL,NULL)").run(
      `token-${id}`,
      id,
      hash(token),
      stamp,
    );
    db.prepare("INSERT INTO access_sessions(id,user_id,session_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,NULL)").run(
      `session-${id}`,
      id,
      hash(session),
      stamp,
      expiry,
    );
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

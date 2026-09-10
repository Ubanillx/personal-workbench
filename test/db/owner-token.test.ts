import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../../server/src/app";
import { loadConfig } from "../../server/src/config/env";
import { createDatabaseClient, type DatabaseClient } from "../../server/src/db/client";
import { resetOwnerAccess } from "../../server/src/security/owner-token";

const migrationsDirectory = path.resolve(process.cwd(), "server/src/db/migrations");

test("主人令牌重置会备份数据库、撤销旧主人访问并保留助理访问", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-owner-reset-"));
  const databasePath = path.join(directory, "workbench.sqlite");
  const backupDirectory = path.join(directory, "backups");
  const database = createDatabaseClient({ databasePath, migrationsDirectory });
  seed(database);
  await database.close();

  const result = await resetOwnerAccess({ databasePath, backupDirectory });
  await stat(result.backupPath);

  const app = await buildApp({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: databasePath }, process.cwd()) });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/access", payload: { token: "old-owner-token" } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/access", payload: { token: result.token } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/access", payload: { token: "assistant-token" } })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: "workbench_session=old-owner-session" } })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: "workbench_session=assistant-session" } })).statusCode, 200);
});

function seed(database: DatabaseClient): void {
  const db = database.getDatabase();
  const stamp = new Date().toISOString();
  const expiry = new Date(Date.now() + 86_400_000).toISOString();
  for (const [id, name, role, token, session] of [["owner", "主人", "owner", "old-owner-token", "old-owner-session"], ["assistant", "助理", "assistant", "assistant-token", "assistant-session"]] as const) {
    db.prepare("INSERT INTO users(id,name,role,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, name, role, 1, stamp, stamp);
    db.prepare("INSERT INTO access_tokens(id,user_id,token_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,NULL,NULL)").run(`token-${id}`, id, hash(token), stamp);
    db.prepare("INSERT INTO access_sessions(id,user_id,session_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,NULL)").run(`session-${id}`, id, hash(session), stamp, expiry);
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

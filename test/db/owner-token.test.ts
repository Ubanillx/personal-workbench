import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabaseClient, type DatabaseClient } from "../../server/src/db/client";
import { resetOwnerAccess } from "../../server/src/security/owner-token";

const migrationsDirectory = path.resolve(process.cwd(), "server/src/db/migrations");

type TokenRow = { token_hash: string; revoked_at: string | null };
type SessionRow = { session_hash: string; revoked_at: string | null };

/**
 * 数据层验证：只依赖 server/src（框架无关），不启动 HTTP 服务。
 * HTTP 层"旧令牌/旧会话真的被拒绝"的端到端验证在 test/api/owner-reset.test.ts。
 */
test("主人令牌重置会备份数据库、撤销旧主人访问并保留助理访问", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-owner-reset-"));
  const databasePath = path.join(directory, "workbench.sqlite");
  const backupDirectory = path.join(directory, "backups");
  const database = createDatabaseClient({ databasePath, migrationsDirectory });
  seed(database);
  await database.close();

  const result = await resetOwnerAccess({ databasePath, backupDirectory });
  await stat(result.backupPath);

  // 备份必须发生在撤销之前：备份库里旧主人令牌仍然有效
  const backup = createDatabaseClient({ databasePath: result.backupPath, readOnly: true });
  const after = createDatabaseClient({ databasePath, readOnly: true });
  // 注册顺序 = 执行顺序：先关连接再删目录（Windows 下文件被占用会 EBUSY）
  t.after(async () => {
    await backup.close();
    await after.close();
    await rm(directory, { recursive: true, force: true });
  });

  assert.equal(activeToken(backup, "owner", "old-owner-token"), true, "备份库应保留重置前的旧主人令牌");
  assert.equal(activeSession(backup, "owner", "old-owner-session"), true, "备份库应保留重置前的旧主人会话");

  // 旧主人令牌与会话被撤销，新令牌可用
  assert.equal(activeToken(after, "owner", "old-owner-token"), false, "旧主人令牌应被撤销");
  assert.equal(activeSession(after, "owner", "old-owner-session"), false, "旧主人会话应被撤销");
  assert.equal(activeToken(after, "owner", result.token), true, "新主人令牌应处于可用状态");
  assert.equal(countActiveOwnerTokens(after), 1, "主人名下应只剩一个可用令牌");

  // 助理访问不受影响
  assert.equal(activeToken(after, "assistant", "assistant-token"), true, "助理令牌不应被撤销");
  assert.equal(activeSession(after, "assistant", "assistant-session"), true, "助理会话不应被撤销");
});

function activeToken(database: DatabaseClient, userId: string, token: string): boolean {
  const row = database
    .getDatabase()
    .prepare("SELECT token_hash, revoked_at FROM access_tokens WHERE user_id=? AND token_hash=?")
    .get(userId, hash(token)) as TokenRow | undefined;
  return row !== undefined && row.revoked_at === null;
}

function activeSession(database: DatabaseClient, userId: string, session: string): boolean {
  const row = database
    .getDatabase()
    .prepare("SELECT session_hash, revoked_at FROM access_sessions WHERE user_id=? AND session_hash=?")
    .get(userId, hash(session)) as SessionRow | undefined;
  return row !== undefined && row.revoked_at === null;
}

function countActiveOwnerTokens(database: DatabaseClient): number {
  const row = database
    .getDatabase()
    .prepare("SELECT COUNT(*) AS total FROM access_tokens WHERE user_id='owner' AND revoked_at IS NULL")
    .get() as { total: number };
  return row.total;
}

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

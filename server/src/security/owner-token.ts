import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { backupOpenDatabase } from "../db/backup";
import { openWritableDatabase } from "../db/client";

export type ResetOwnerAccessOptions = {
  databasePath: string;
  backupDirectory: string;
};

export type ResetOwnerAccessResult = {
  backupPath: string;
  token: string;
};

export async function resetOwnerAccess(options: ResetOwnerAccessOptions): Promise<ResetOwnerAccessResult> {
  const databasePath = path.resolve(options.databasePath);
  const database = openWritableDatabase(databasePath);
  try {
    database.exec("PRAGMA busy_timeout=5000");
    const backupPath = await backupOpenDatabase(database, path.resolve(options.backupDirectory));
    const owner = database.prepare("SELECT id FROM users WHERE id='owner' AND role='owner'").get() as { id: string } | undefined;
    if (!owner) throw new Error("未找到主人账户，未执行主人令牌重置");

    const stamp = new Date().toISOString();
    const token = createToken();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("UPDATE access_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL").run(stamp, owner.id);
      database.prepare("UPDATE access_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL").run(stamp, owner.id);
      database.prepare("INSERT INTO access_tokens(id,user_id,token_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,NULL,NULL)").run(randomUUID(), owner.id, hash(token), stamp);
      database.exec("COMMIT");
      return { backupPath, token };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function createToken(): string {
  return randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

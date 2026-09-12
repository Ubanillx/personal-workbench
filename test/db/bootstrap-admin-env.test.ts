import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DEFAULT_ADMIN_USERNAME, ensureDefaultAdminAndOrganization } from "../../server/src/db/bootstrap";
import { createDatabaseClient, openWritableDatabase } from "../../server/src/db/client";
import { hashPasswordSync, isLockedPasswordHash, LOCKED_PASSWORD_HASH, verifyPassword } from "../../server/src/security/password";

/**
 * 管理员初始密码走环境变量（D-51，`WORKBENCH_ADMIN_PASSWORD`）。
 *
 * 要守住的边界：只在账号还是 `locked$` 占位时生效一次；已有真密码的账号**永不覆盖**；
 * 非法值（太短）只标记、不静默变成"没密码"。
 */

const migrationsDirectory = path.resolve(process.cwd(), "server/src/db/migrations");
const ENV_PASSWORD = "workbench-env-pass-1";
const OTHER_ENV_PASSWORD = "workbench-env-pass-2";

type AdminRow = { id: string; username: string; passwordHash: string; mustChange: number };

async function tempDatabasePath(): Promise<{ directory: string; databasePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-admin-env-"));
  return { directory, databasePath: path.join(directory, "workbench.sqlite") };
}

async function withMigratedDatabase<T>(databasePath: string, run: (database: DatabaseSync) => T): Promise<T> {
  const client = createDatabaseClient({ databasePath, migrationsDirectory });
  try {
    return run(client.getDatabase());
  } finally {
    await client.close();
  }
}

function withDatabase<T>(databasePath: string, query: (database: DatabaseSync) => T): T {
  const database = openWritableDatabase(databasePath);
  try {
    return query(database);
  } finally {
    database.close();
  }
}

function readAdmin(databasePath: string): AdminRow {
  return withDatabase(databasePath, (database) => {
    const row = database
      .prepare("SELECT id, username, password_hash AS passwordHash, must_change_password AS mustChange FROM users WHERE role='admin'")
      .get() as AdminRow | undefined;
    assert.ok(row, "库里应该有一个管理员");
    return row;
  });
}

/** 预置一个已存在的管理员，模拟「老库/上一版建出来的库」（必须先迁移，否则 users 表还不存在） */
async function seedAdmin(databasePath: string, passwordHash: string, mustChange: number): Promise<void> {
  await withMigratedDatabase(databasePath, (database) => {
    const stamp = new Date().toISOString();
    database
      .prepare(
        "INSERT INTO users(id,username,email,name,role,org_id,password_hash,must_change_password,is_active,created_at,updated_at) VALUES('admin-seeded','admin','admin@local.invalid','主人','admin',NULL,?,?,1,?,?)",
      )
      .run(passwordHash, mustChange, stamp, stamp);
  });
}

test("全新库 + env 密码：管理员直接拿到可用密码，且不强制首登改密", async (t) => {
  const temp = await tempDatabasePath();
  t.after(() => rm(temp.directory, { recursive: true, force: true }));

  const result = await withMigratedDatabase(temp.databasePath, (database) =>
    ensureDefaultAdminAndOrganization(database, { adminPassword: ENV_PASSWORD }),
  );

  assert.deepEqual(result, {
    createdAdmin: true,
    createdOrganization: true,
    adminAwaitingPassword: false,
    adminPasswordFromEnv: true,
    adminPasswordInvalid: false,
    adminUsername: DEFAULT_ADMIN_USERNAME,
  });

  const admin = readAdmin(temp.databasePath);
  assert.equal(isLockedPasswordHash(admin.passwordHash), false, "不该再是 locked$ 占位");
  assert.equal(admin.mustChange, 0, "env 里给的是运维自己挑的长期密码，不强制改密");
  assert.equal(await verifyPassword(ENV_PASSWORD, admin.passwordHash), true, "env 里的密码必须能登录");
  assert.equal(await verifyPassword("wrong-password", admin.passwordHash), false);
});

test("老库（管理员还是 locked$）+ env 密码：补设一次；之后改 env 不再覆盖", async (t) => {
  const temp = await tempDatabasePath();
  t.after(() => rm(temp.directory, { recursive: true, force: true }));

  await seedAdmin(temp.databasePath, LOCKED_PASSWORD_HASH, 1);

  const first = await withMigratedDatabase(temp.databasePath, (database) =>
    ensureDefaultAdminAndOrganization(database, { adminPassword: ENV_PASSWORD }),
  );
  assert.equal(first.adminPasswordFromEnv, true);
  assert.equal(first.adminAwaitingPassword, false);
  assert.equal(first.createdAdmin, false, "已有管理员时不应新建账号");

  const afterFirst = readAdmin(temp.databasePath);
  assert.equal(await verifyPassword(ENV_PASSWORD, afterFirst.passwordHash), true);

  // 第二次换个密码再来：账号已经有真密码 → 一个字节都不该变
  const second = await withMigratedDatabase(temp.databasePath, (database) =>
    ensureDefaultAdminAndOrganization(database, { adminPassword: OTHER_ENV_PASSWORD }),
  );
  assert.equal(second.adminPasswordFromEnv, false, "已设密码后 env 不再生效");
  assert.equal(readAdmin(temp.databasePath).passwordHash, afterFirst.passwordHash, "hash 不能被改写");
  assert.equal(await verifyPassword(ENV_PASSWORD, readAdmin(temp.databasePath).passwordHash), true);
  assert.equal(await verifyPassword(OTHER_ENV_PASSWORD, readAdmin(temp.databasePath).passwordHash), false);
});

test("env 密码不合法（太短）：保持 locked$，并标记 adminPasswordInvalid", async (t) => {
  const temp = await tempDatabasePath();
  t.after(() => rm(temp.directory, { recursive: true, force: true }));

  const result = await withMigratedDatabase(temp.databasePath, (database) =>
    ensureDefaultAdminAndOrganization(database, { adminPassword: "short" }),
  );

  assert.equal(result.adminPasswordInvalid, true);
  assert.equal(result.adminPasswordFromEnv, false);
  assert.equal(result.adminAwaitingPassword, true, "忽略非法密码后管理员仍是「等密码」状态");
  assert.equal(readAdmin(temp.databasePath).passwordHash, LOCKED_PASSWORD_HASH);
});

test("没有 env 密码时保持原行为：locked$ + 强制首登改密", async (t) => {
  const temp = await tempDatabasePath();
  t.after(() => rm(temp.directory, { recursive: true, force: true }));

  const result = await withMigratedDatabase(temp.databasePath, (database) => ensureDefaultAdminAndOrganization(database));

  assert.equal(result.adminAwaitingPassword, true);
  assert.equal(result.adminPasswordFromEnv, false);
  assert.equal(result.adminPasswordInvalid, false);
  const admin = readAdmin(temp.databasePath);
  assert.equal(admin.passwordHash, LOCKED_PASSWORD_HASH);
  assert.equal(admin.mustChange, 1);
});

test("已有真密码的管理员：env 密码既不覆盖也不报成「无效」", async (t) => {
  const temp = await tempDatabasePath();
  t.after(() => rm(temp.directory, { recursive: true, force: true }));

  await seedAdmin(temp.databasePath, hashPasswordSync("existing-real-pass"), 0);

  const result = await withMigratedDatabase(temp.databasePath, (database) =>
    ensureDefaultAdminAndOrganization(database, { adminPassword: ENV_PASSWORD }),
  );

  assert.equal(result.adminPasswordFromEnv, false);
  assert.equal(result.adminPasswordInvalid, false, "账号本来就有密码，不是 env 的问题");
  assert.equal(result.adminAwaitingPassword, false);
  assert.equal(await verifyPassword("existing-real-pass", readAdmin(temp.databasePath).passwordHash), true, "原密码必须还能用");
  assert.equal(await verifyPassword(ENV_PASSWORD, readAdmin(temp.databasePath).passwordHash), false);
});

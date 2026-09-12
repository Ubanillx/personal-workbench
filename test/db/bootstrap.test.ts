import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DEFAULT_ADMIN_USERNAME, DEFAULT_ORG_ID, DEFAULT_ORG_NAME, ensureDefaultAdminAndOrganization } from "../../server/src/db/bootstrap";
import { createDatabaseClient, openWritableDatabase } from "../../server/src/db/client";
import { LOCKED_PASSWORD_HASH } from "../../server/src/security/password";

/**
 * 数据库自举（D-39）：全新空库要能开箱拿到「默认管理员 + 默认组织」，已有数据的库一律不打扰。
 * 自举挂在应用运行时（app/lib/context.server.ts），因此这里直接测 server 侧的函数。
 */

const migrationsDirectory = path.resolve(process.cwd(), "server/src/db/migrations");

type UserRow = {
  id: string;
  username: string;
  email: string;
  name: string;
  role: string;
  orgId: string | null;
  passwordHash: string;
  mustChange: number;
};

type OrgRow = { id: string; name: string; status: string; createdBy: string };

async function tempDatabasePath(): Promise<{ directory: string; databasePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-bootstrap-"));
  return { directory, databasePath: path.join(directory, "workbench.sqlite") };
}

/** 迁移到最新 schema 后交给回调；用完关连接，否则 Windows 上临时目录删不掉（EBUSY） */
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

function readSnapshot(databasePath: string): { users: UserRow[]; organizations: OrgRow[] } {
  return withDatabase(databasePath, (database) => ({
    users: database
      .prepare(
        "SELECT id, username, email, name, role, org_id AS orgId, password_hash AS passwordHash, must_change_password AS mustChange FROM users ORDER BY username",
      )
      .all() as UserRow[],
    organizations: database.prepare("SELECT id, name, status, created_by AS createdBy FROM organizations ORDER BY id").all() as OrgRow[],
  }));
}

test("全新空库自举出默认管理员与默认组织，组织挂在管理员名下且管理员不隶属组织", async (t) => {
  const temp = await tempDatabasePath();
  t.after(() => rm(temp.directory, { recursive: true, force: true }));

  const result = await withMigratedDatabase(temp.databasePath, (database) => {
    // 迁移后的全新库是「0 账号 + 0 组织」：009 只在已有主人账号的库上建组织
    assert.deepEqual(readCounts(database), { users: 0, organizations: 0 });
    return ensureDefaultAdminAndOrganization(database);
  });

  assert.deepEqual(result, {
    createdAdmin: true,
    createdOrganization: true,
    adminAwaitingPassword: true,
    adminPasswordFromEnv: false,
    adminPasswordInvalid: false,
    adminUsername: DEFAULT_ADMIN_USERNAME,
  });

  const snapshot = readSnapshot(temp.databasePath);
  assert.equal(snapshot.users.length, 1);
  const admin = snapshot.users[0] as UserRow;
  assert.equal(admin.username, DEFAULT_ADMIN_USERNAME);
  assert.equal(admin.name, "主人");
  assert.equal(admin.email, `${DEFAULT_ADMIN_USERNAME}@local.invalid`);
  assert.equal(admin.role, "admin");
  assert.equal(admin.orgId, null, "管理员不隶属组织（D-26）");
  assert.equal(admin.passwordHash, LOCKED_PASSWORD_HASH, "密码保持 locked$ 占位，等 npm run user:init");
  assert.equal(admin.mustChange, 1, "初始密码是临时的，首次登录必须改密");

  assert.equal(snapshot.organizations.length, 1);
  const org = snapshot.organizations[0] as OrgRow;
  assert.equal(org.id, DEFAULT_ORG_ID);
  assert.equal(org.name, DEFAULT_ORG_NAME);
  assert.equal(org.status, "active");
  assert.equal(org.createdBy, admin.id, "默认组织必须绑定在管理员账号上");
});

test("自举幂等：重复执行不再插入，已有数据一个字段都不改", async (t) => {
  const temp = await tempDatabasePath();
  t.after(() => rm(temp.directory, { recursive: true, force: true }));

  const first = await withMigratedDatabase(temp.databasePath, (database) => ensureDefaultAdminAndOrganization(database));
  assert.equal(first.createdAdmin, true);
  const afterFirst = readSnapshot(temp.databasePath);

  const second = await withMigratedDatabase(temp.databasePath, (database) => ensureDefaultAdminAndOrganization(database));
  // 管理员仍是 locked$ 占位（没给 env 密码），所以状态如实报「还没有密码」；
  // 老实现这里硬编码 false，会让「重启后管理员仍无密码」不再被提示。
  assert.deepEqual(second, {
    createdAdmin: false,
    createdOrganization: false,
    adminAwaitingPassword: true,
    adminPasswordFromEnv: false,
    adminPasswordInvalid: false,
    adminUsername: DEFAULT_ADMIN_USERNAME,
  });
  assert.deepEqual(readSnapshot(temp.databasePath), afterFirst, "第二次执行不应有任何写入");
});

test("已有管理员但组织被清空的库：只补默认组织，不新建账号", async (t) => {
  const temp = await tempDatabasePath();
  t.after(() => rm(temp.directory, { recursive: true, force: true }));

  await withMigratedDatabase(temp.databasePath, (database) => {
    const stamp = new Date().toISOString();
    database
      .prepare(
        "INSERT INTO users(id,username,email,name,role,org_id,password_hash,must_change_password,is_active,created_at,updated_at) VALUES('admin-1','admin','admin@local.invalid','主人','admin',NULL,?,1,1,?,?)",
      )
      .run(LOCKED_PASSWORD_HASH, stamp, stamp);
    return ensureDefaultAdminAndOrganization(database);
  });

  const snapshot = readSnapshot(temp.databasePath);
  assert.equal(snapshot.users.length, 1, "已有管理员时不应再建账号");
  assert.equal(snapshot.users[0]?.id, "admin-1", "原管理员保持不变");
  assert.equal(snapshot.organizations.length, 1);
  assert.equal(snapshot.organizations[0]?.createdBy, "admin-1", "补出来的组织挂在已有管理员名下");
});

test("夹具式库（已有管理员与组织）完全不动；admin 用户名被普通账号占用时也不顶替", async (t) => {
  const temp = await tempDatabasePath();
  t.after(() => rm(temp.directory, { recursive: true, force: true }));

  // 1. 已有管理员 + 已有组织（契约夹具就是这个形态）：一个字段都不能变
  await withMigratedDatabase(temp.databasePath, (database) => {
    const stamp = new Date().toISOString();
    database
      .prepare(
        "INSERT INTO users(id,username,email,name,role,org_id,password_hash,must_change_password,is_active,created_at,updated_at) VALUES('user-admin','admin','admin@local.invalid','管理员','admin',NULL,?,0,1,?,?)",
      )
      .run(LOCKED_PASSWORD_HASH, stamp, stamp);
    database
      .prepare(
        "INSERT INTO organizations(id,name,description,status,created_by,created_at,updated_at,archived_at) VALUES('org-alpha','阿尔法组','','active','user-admin',?,?,NULL)",
      )
      .run(stamp, stamp);
    return ensureDefaultAdminAndOrganization(database);
  });

  const snapshot = readSnapshot(temp.databasePath);
  assert.deepEqual(
    snapshot.organizations.map((org) => org.id),
    ["org-alpha"],
    "已有组织时不应再建「默认组织」",
  );

  // 2. 另一个库：admin 这个用户名被普通账号抢占了
  const second = await tempDatabasePath();
  t.after(() => rm(second.directory, { recursive: true, force: true }));
  const result = await withMigratedDatabase(second.databasePath, (database) => {
    const stamp = new Date().toISOString();
    database
      .prepare(
        "INSERT INTO users(id,username,email,name,role,org_id,password_hash,must_change_password,is_active,created_at,updated_at) VALUES('user-1','admin','admin@example.test','抢到名字的人','member',NULL,?,0,1,?,?)",
      )
      .run(LOCKED_PASSWORD_HASH, stamp, stamp);
    return ensureDefaultAdminAndOrganization(database);
  });

  assert.deepEqual(result, {
    createdAdmin: false,
    createdOrganization: false,
    adminAwaitingPassword: false,
    adminPasswordFromEnv: false,
    adminPasswordInvalid: false,
    adminUsername: null,
  });
  const after = readSnapshot(second.databasePath);
  assert.deepEqual(
    after.users.map((user) => [user.id, user.role]),
    [["user-1", "member"]],
    "不能顶替或提升已占用 admin 用户名的账号",
  );
  assert.equal(after.organizations.length, 0, "没有管理员就没人能当 created_by，不能凭空建组织");
});

function readCounts(database: DatabaseSync): { users: number; organizations: number } {
  const count = (table: string): number => (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { users: count("users"), organizations: count("organizations") };
}

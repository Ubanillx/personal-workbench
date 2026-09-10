import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createDatabaseClient, openWritableDatabase } from "../../server/src/db/client";
import { AccountNotFoundError, initMissingPasswords, listAccounts, setAccountPassword } from "../../server/src/security/account";
import { LOCKED_PASSWORD_HASH, hashPassword, validatePassword, verifyPassword } from "../../server/src/security/password";

const migrationsDirectory = path.resolve(process.cwd(), "server/src/db/migrations");
const EXISTING_PASSWORD = "already-set-password";

type UserRow = { username: string; passwordHash: string; mustChangePassword: number; updatedAt: string };

async function tempDatabasePath(): Promise<{ directory: string; databasePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-account-"));
  return { directory, databasePath: path.join(directory, "workbench.sqlite") };
}

/** 用独立连接读一次就关掉：Windows 下连接没关会让临时目录删不掉（EBUSY） */
function withDatabase<T>(databasePath: string, query: (database: DatabaseSync) => T): T {
  const database = openWritableDatabase(databasePath);
  try {
    return query(database);
  } finally {
    database.close();
  }
}

function readUsers(databasePath: string): Map<string, UserRow> {
  return withDatabase(databasePath, (database) => {
    const rows = database
      .prepare(
        "SELECT username, password_hash AS passwordHash, must_change_password AS mustChangePassword, updated_at AS updatedAt FROM users",
      )
      .all() as UserRow[];
    return new Map(rows.map((row) => [row.username, row]));
  });
}

/**
 * 造一个迁移后的库：管理员（无组织）+ 两个普通成员（同一组织）。
 * alice 与 admin 的密码还是 locked$ 占位值，bob 已经有真实密码。
 */
async function seedDatabase(databasePath: string): Promise<void> {
  const client = createDatabaseClient({ databasePath, migrationsDirectory });
  try {
    const database = client.getDatabase();
    const stamp = new Date().toISOString();
    const insertUser = database.prepare(
      "INSERT INTO users(id,username,email,name,role,org_id,password_hash,must_change_password,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)",
    );
    insertUser.run("admin-1", "admin", "admin@local.invalid", "主人", "admin", null, LOCKED_PASSWORD_HASH, 1, stamp, stamp);
    database
      .prepare(
        "INSERT INTO organizations(id,name,description,status,created_by,created_at,updated_at,archived_at) VALUES('org-1','测试组织','','active','admin-1',?,?,NULL)",
      )
      .run(stamp, stamp);
    insertUser.run("user-alice", "alice", "alice@example.test", "爱丽丝", "member", "org-1", LOCKED_PASSWORD_HASH, 1, stamp, stamp);
    insertUser.run(
      "user-bob",
      "bob",
      "bob@example.test",
      "鲍勃",
      "member",
      "org-1",
      await hashPassword(EXISTING_PASSWORD),
      0,
      stamp,
      stamp,
    );
  } finally {
    await client.close();
  }
}

test("initMissingPasswords 只给 locked$ 账号生成初始密码，且重复执行幂等", async (t) => {
  const temp = await tempDatabasePath();
  t.after(() => rm(temp.directory, { recursive: true, force: true }));
  await seedDatabase(temp.databasePath);
  const before = readUsers(temp.databasePath);

  const issued = await initMissingPasswords(temp.databasePath);
  assert.deepEqual(issued.map((item) => item.username).toSorted(), ["admin", "alice"], "只应处理还是 locked$ 的账号，bob 已有密码不动");

  const afterFirst = readUsers(temp.databasePath);
  for (const item of issued) {
    assert.equal(validatePassword(item.password), null, "生成的初始密码本身要合法");
    const stored = afterFirst.get(item.username)?.passwordHash ?? "";
    assert.notEqual(stored, LOCKED_PASSWORD_HASH, `${item.username} 的占位值应被真实哈希替换`);
    assert.equal(await verifyPassword(item.password, stored), true, `${item.username} 打印出来的密码必须能通过校验`);
    assert.equal(await verifyPassword("wrong-password", stored), false);
    assert.equal(afterFirst.get(item.username)?.mustChangePassword, 1, "初始密码是临时的，首次登录必须改密");
  }
  assert.equal(afterFirst.get("bob")?.passwordHash, before.get("bob")?.passwordHash, "bob 的哈希不应被改动");
  assert.equal(await verifyPassword(EXISTING_PASSWORD, afterFirst.get("bob")?.passwordHash ?? ""), true, "bob 原来的密码仍然有效");
  assert.equal(afterFirst.get("bob")?.mustChangePassword, 0);

  // 幂等：第二次执行不生成任何新密码，也不覆盖已有哈希
  const second = await initMissingPasswords(temp.databasePath);
  assert.deepEqual(second, []);
  const afterSecond = readUsers(temp.databasePath);
  for (const username of ["admin", "alice", "bob"]) {
    assert.equal(afterSecond.get(username)?.passwordHash, afterFirst.get(username)?.passwordHash, `${username} 的哈希第二次不应变化`);
  }
});

test("setAccountPassword 写入的哈希能被 verifyPassword 校验通过", async (t) => {
  const temp = await tempDatabasePath();
  t.after(() => rm(temp.directory, { recursive: true, force: true }));
  await seedDatabase(temp.databasePath);

  await setAccountPassword({ databasePath: temp.databasePath, username: "alice", password: "new-password-123" });
  const after = readUsers(temp.databasePath);
  const stored = after.get("alice")?.passwordHash ?? "";
  assert.equal(await verifyPassword("new-password-123", stored), true, "新密码应能被校验通过");
  assert.equal(await verifyPassword("new-password-124", stored), false, "错误密码必须失败");
  assert.equal(await verifyPassword("new-password-123", LOCKED_PASSWORD_HASH), false, "占位值对任何输入都失败");
  assert.equal(after.get("alice")?.mustChangePassword, 1, "默认视为临时密码，要求首次登录改密");

  // mustChangePassword: false 用于本人改密 / 管理员给自己设长期密码
  await setAccountPassword({
    databasePath: temp.databasePath,
    username: "alice",
    password: "long-term-password",
    mustChangePassword: false,
  });
  const settled = readUsers(temp.databasePath);
  assert.equal(settled.get("alice")?.mustChangePassword, 0);
  assert.equal(await verifyPassword("long-term-password", settled.get("alice")?.passwordHash ?? ""), true);
  assert.equal(await verifyPassword("new-password-123", settled.get("alice")?.passwordHash ?? ""), false, "旧密码应失效");
});

test("setAccountPassword 对不存在的账号报错，且拒绝过短的密码", async (t) => {
  const temp = await tempDatabasePath();
  t.after(() => rm(temp.directory, { recursive: true, force: true }));
  await seedDatabase(temp.databasePath);

  await assert.rejects(
    () => setAccountPassword({ databasePath: temp.databasePath, username: "nobody", password: "whatever-password" }),
    AccountNotFoundError,
  );
  await assert.rejects(
    () => setAccountPassword({ databasePath: temp.databasePath, username: "alice", password: "short" }),
    /密码至少 8 位/u,
  );
  const after = readUsers(temp.databasePath);
  assert.equal(after.get("alice")?.passwordHash, LOCKED_PASSWORD_HASH, "失败的调用不应改动库里的哈希");
});

test("listAccounts 列出账号并标出尚未设置密码的账号", async (t) => {
  const temp = await tempDatabasePath();
  t.after(() => rm(temp.directory, { recursive: true, force: true }));
  await seedDatabase(temp.databasePath);

  const before = listAccounts(temp.databasePath);
  assert.deepEqual(
    before.map((account) => account.username),
    ["admin", "alice", "bob"],
    "管理员排在最前",
  );
  assert.equal(before.find((account) => account.username === "alice")?.hasPassword, false);
  assert.equal(before.find((account) => account.username === "bob")?.hasPassword, true);
  assert.equal(before.find((account) => account.username === "bob")?.orgName, "测试组织");
  assert.equal(before.find((account) => account.username === "admin")?.orgName, null, "管理员不隶属组织");

  await initMissingPasswords(temp.databasePath);
  const after = listAccounts(temp.databasePath);
  assert.equal(
    after.every((account) => account.hasPassword),
    true,
    "初始化后不应再有未设密码的账号",
  );
});

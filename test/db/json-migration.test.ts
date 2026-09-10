import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { openWritableDatabase } from "../../server/src/db/client";
import { migrateJsonToSqlite } from "../../server/src/db/json-migration";
import { TaskRepository } from "../../server/src/db/repositories/task-repository";
import { LOCKED_PASSWORD_HASH } from "../../server/src/security/password";

const migrationsDirectory = path.resolve(process.cwd(), "server/src/db/migrations");
const fixture = JSON.stringify({
  tasks: [
    {
      id: "task-1",
      title: "迁移任务",
      desc: "",
      priority: "P1",
      status: "doing",
      progress: 50,
      due: "2026-09-05",
      assignee: "assistant:a1",
      logs: [{ t: 1, text: "开始" }],
      comments: [{ t: 2, text: "反馈", by: "查看者", role: "viewer" }],
      source: "assistant",
      createdAt: 1,
      doneAt: null,
    },
  ],
  todos: [{ id: "todo-1", text: "待办", done: false, date: "2026-09-04", createdAt: 1, doneAt: null }],
  notes: [{ id: "note-1", text: "笔记", pinned: true, createdAt: 1 }],
  files: [{ id: "file-1", name: "file.txt", path: "C:/safe/file.txt", createdAt: 1 }],
  settings: {
    apiToken: "fixture-api-token",
    // 旧 JSON 里的访问令牌（ownerToken / shareToken / 各成员 token）迁移时一律忽略：
    // access_tokens 已随 010 退役，令牌登录整体作废（§3.5）
    ownerToken: "fixture-owner-token",
    // 两个助理分别覆盖用户名规则的两条分支：ASCII 名字 → 小写名字；中文名字 → member-<id 前 6 位>
    assistants: [
      { id: "a1", name: "助理", token: "fixture-assistant-token", createdAt: 1 },
      { id: "a2", name: "Selene", token: "fixture-assistant-token-2", createdAt: 2 },
    ],
    viewers: [{ id: "v1", name: "查看者", token: "fixture-viewer-token", createdAt: 1 }],
  },
});

async function tempDatabase(): Promise<{ directory: string; databasePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-stage4-"));
  return { directory, databasePath: path.join(directory, "stage4.sqlite") };
}

function count(database: DatabaseSync, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function columnNames(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

type UserRow = {
  id: string;
  username: string;
  email: string;
  name: string;
  role: string;
  orgId: string | null;
  passwordHash: string;
  mustChangePassword: number;
};

function users(database: DatabaseSync): Map<string, UserRow> {
  const rows = database
    .prepare(
      "SELECT id, username, email, name, role, org_id AS orgId, password_hash AS passwordHash, must_change_password AS mustChangePassword FROM users",
    )
    .all() as UserRow[];
  return new Map(rows.map((row) => [row.id, row]));
}

test("JSON 迁移按新结构建账号、组织与业务数据", async (t) => {
  const temp = await tempDatabase();
  const database = openWritableDatabase(temp.databasePath);
  t.after(async () => {
    database.close();
    await rm(temp.directory, { recursive: true, force: true });
  });
  const result = migrateJsonToSqlite({ database, rawJson: fixture, sourceName: "fixture.json", migrationsDirectory });
  assert.equal(result.status, "completed");
  assert.equal(result.statistics.tasks, 1);
  assert.equal(result.statistics.logs, 1);
  assert.equal(result.statistics.comments, 1);
  assert.equal(result.statistics.assistants, 2);
  assert.equal(result.statistics.viewers, 1);

  const task = new TaskRepository(database).findById("task-1");
  assert.equal(task?.status, "in_progress");
  assert.equal(task?.ownerId, "a1");
  assert.equal(task?.createdBy, "a1");
  assert.equal(task?.isPrivate, false);

  // 用户表结构：账号密码 + 多组织改造后的列一个都不能少
  const userColumns = columnNames(database, "users");
  for (const column of ["username", "email", "password_hash", "org_id", "must_change_password"]) {
    assert.ok(userColumns.includes(column), `users 应包含 ${column} 列`);
  }

  // 账号映射：主人 → 全局管理员；其余人 → 迁移组织的普通成员
  const accounts = users(database);
  assert.equal(accounts.size, 4);
  const admin = accounts.get("owner");
  assert.equal(admin?.username, "admin");
  assert.equal(admin?.email, "admin@local.invalid");
  assert.equal(admin?.role, "admin");
  assert.equal(admin?.orgId, null, "管理员是全局角色，不隶属组织");
  assert.equal(accounts.get("a2")?.username, "selene", "纯 ASCII 名字取小写名字作用户名");
  assert.equal(accounts.get("a2")?.email, "selene@local.invalid");
  assert.equal(accounts.get("a1")?.username, "member-a1", "名字不可用时回退 member-<id 前 6 位>");
  assert.equal(accounts.get("v1")?.username, "member-v1");
  assert.equal(accounts.get("a1")?.role, "member");
  assert.equal(accounts.get("v1")?.role, "member");
  assert.equal(accounts.get("a1")?.name, "助理", "显示名仍保留旧名字");
  for (const account of accounts.values()) {
    assert.ok(["admin", "manager", "member"].includes(account.role), `角色必须是新三角色：${account.role}`);
    assert.equal(account.passwordHash, LOCKED_PASSWORD_HASH, "迁移不写密码，一律 locked$ 占位");
    assert.equal(account.mustChangePassword, 1, "迁移出来的账号首次登录必须改密");
    assert.ok(account.orgId !== null || account.role === "admin", "非管理员必须有组织");
  }

  // 迁移时自动建组织，并把管理员记为创建人
  assert.equal(count(database, "organizations"), 1);
  const organization = database.prepare("SELECT id, name, status, created_by AS createdBy FROM organizations").get() as {
    id: string;
    name: string;
    status: string;
    createdBy: string;
  };
  assert.equal(organization.id, "org-migrated");
  assert.equal(organization.name, "迁移组织");
  assert.equal(organization.status, "active");
  assert.equal(organization.createdBy, "owner");

  // 五张业务表都带上了 org_id（NOT NULL，逐表核对取值）
  for (const table of ["tasks", "todos", "notes", "important_files"]) {
    assert.ok(columnNames(database, table).includes("org_id"), `${table} 应包含 org_id 列`);
    const row = database.prepare(`SELECT DISTINCT org_id AS orgId FROM ${table}`).all() as Array<{ orgId: string }>;
    assert.deepEqual(
      row.map((item) => item.orgId),
      ["org-migrated"],
      `${table} 的每一行都必须挂在迁移组织上`,
    );
  }

  // 历史评论的角色按 009 的规则回填（viewer → member）
  const comment = database.prepare("SELECT author_role AS authorRole FROM task_comments").get() as { authorRole: string };
  assert.equal(comment.authorRole, "member");
  assert.equal(count(database, "task_comments"), 1);
  assert.equal(count(database, "task_progress_logs"), 1);

  // 令牌时代退役：access_tokens 表已不存在
  const tokenTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'access_tokens'").get();
  assert.equal(tokenTable, undefined, "access_tokens 表应已被 010 删除");
  // api_tokens 是另一张死表（DEBT-05），本次不动：旧 JSON 的 apiToken 仍照旧落库
  assert.equal(count(database, "api_tokens"), 1);
});

test("重复迁移同一 JSON 不会重复写入", async (t) => {
  const temp = await tempDatabase();
  const database = openWritableDatabase(temp.databasePath);
  t.after(async () => {
    database.close();
    await rm(temp.directory, { recursive: true, force: true });
  });
  migrateJsonToSqlite({ database, rawJson: fixture, sourceName: "fixture.json", migrationsDirectory });
  const second = migrateJsonToSqlite({ database, rawJson: fixture, sourceName: "fixture.json", migrationsDirectory });
  assert.equal(second.status, "already_migrated");
  assert.equal(count(database, "tasks"), 1);
  assert.equal(count(database, "users"), 4);
  assert.equal(count(database, "organizations"), 1);
});

test("非法 priority 会回滚整个迁移", async (t) => {
  const temp = await tempDatabase();
  const database = openWritableDatabase(temp.databasePath);
  t.after(async () => {
    database.close();
    await rm(temp.directory, { recursive: true, force: true });
  });
  const invalid = fixture.replace('"priority":"P1"', '"priority":"P9"');
  assert.throws(
    () => migrateJsonToSqlite({ database, rawJson: invalid, sourceName: "fixture.json", migrationsDirectory }),
    /Invalid task priority/,
  );
  assert.equal(count(database, "tasks"), 0);
  assert.equal(count(database, "users"), 0);
  assert.equal(count(database, "organizations"), 0, "回滚后不应留下半个组织");
  assert.equal(count(database, "migration_runs"), 0);
});

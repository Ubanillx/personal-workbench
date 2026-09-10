import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDatabaseClient } from "../../server/src/db/client";

/**
 * 在**正式库的副本**上试跑待启用迁移（`server/src/db/migrations-pending/`），并逐表核对结果。
 *
 *   npm run db:rehearse
 *   npm run db:rehearse -- --source data/workbench.sqlite --keep
 *
 * 为什么需要它：009 给 5 张业务表加的是 NOT NULL org_id，只有在「所有插入都带 org_id」的代码
 * 落地之后才能进 migrations/。在此之前用本工具验证迁移本身正确，正式库始终不动。
 *
 * 退出码 0 = 全部核对通过。
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), "server/src/db/migrations");
const PENDING_DIR = path.resolve(process.cwd(), "server/src/db/migrations-pending");

/** 迁移前后行数必须一致的表（除 access_tokens 被删、organizations/join_requests 是新建的） */
const PRESERVED_TABLES = [
  "access_sessions",
  "api_tokens",
  "important_files",
  "migration_runs",
  "notes",
  "notifications",
  "report_files",
  "task_comments",
  "task_events",
  "task_progress_logs",
  "tasks",
  "todos",
  "users",
  "weekly_reports",
] as const;

/** 加了 org_id 之后，每一行都必须挂到初始组织 */
const ORG_SCOPED_TABLES = ["tasks", "todos", "notes", "important_files", "weekly_reports"] as const;

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/u;

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
}

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

/** 某个写操作是否被数据库约束拒绝 */
function rejects(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): boolean {
  try {
    db.prepare(sql).run(...params);
    return false;
  } catch {
    return true;
  }
}

async function snapshot(source: string, target: string): Promise<void> {
  const backupFn = (
    (await import("node:sqlite")) as unknown as {
      backup?: (db: DatabaseSync, destination: string) => Promise<void>;
    }
  ).backup;
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    if (backupFn) {
      await backupFn(db, target);
      return;
    }
    throw new Error("当前 Node 不提供 node:sqlite 的 backup()");
  } finally {
    db.close();
  }
}

/** 合成临时迁移目录：已启用的 + 待启用的，交给真实 runner 执行 */
function stageMigrations(directory: string): number {
  const files = [
    ...fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")),
    ...fs.readdirSync(PENDING_DIR).filter((file) => file.endsWith(".sql")),
  ];
  for (const file of files) {
    const from = fs.existsSync(path.join(PENDING_DIR, file)) ? path.join(PENDING_DIR, file) : path.join(MIGRATIONS_DIR, file);
    fs.copyFileSync(from, path.join(directory, file));
  }
  return files.length;
}

async function main(): Promise<void> {
  const source = path.resolve(process.cwd(), argValue("--source", "data/workbench.sqlite"));
  const keep = process.argv.includes("--keep");
  if (!fs.existsSync(source)) throw new Error(`源库不存在：${source}（用 --source 指定）`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-rehearse-"));
  const stagingDir = path.join(workDir, "migrations");
  const copyPath = path.join(workDir, "workbench.sqlite");
  fs.mkdirSync(stagingDir, { recursive: true });

  console.log(`源库：${source}`);
  console.log(`副本：${copyPath}`);
  await snapshot(source, copyPath);

  const before = new DatabaseSync(copyPath, { readOnly: true });
  const beforeCounts = new Map<string, number>();
  for (const table of PRESERVED_TABLES) beforeCounts.set(table, tableExists(before, table) ? count(before, table) : -1);
  const beforeMigrations = (
    before.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>
  ).map((row) => row.version);
  const earliestAssistant = before.prepare("SELECT id FROM users WHERE role='assistant' ORDER BY created_at, id LIMIT 1").get() as
    { id: string } | undefined;
  const ownerRow = before.prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at, id LIMIT 1").get() as
    { id: string } | undefined;
  before.close();

  console.log(`已应用迁移：${beforeMigrations.length} 个（最新 ${beforeMigrations.at(-1) ?? "无"}）`);
  const staged = stageMigrations(stagingDir);
  console.log(`临时迁移目录合成 ${staged} 个文件，开始执行…`);

  const client = createDatabaseClient({ databasePath: copyPath, migrationsDirectory: stagingDir });
  const db = client.getDatabase();
  const applied = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>).map(
    (row) => row.version,
  );

  // ---------------------------------------------------------------- 迁移执行
  record(
    "两个待启用迁移都已记录",
    applied.includes("009_accounts_and_organizations") && applied.includes("010_drop_access_tokens"),
    applied.slice(-2).join(", "),
  );

  // ---------------------------------------------------------------- 结构
  record("access_tokens 已删除", !tableExists(db, "access_tokens"));
  record("organizations 已建立", tableExists(db, "organizations"));
  record("organization_join_requests 已建立", tableExists(db, "organization_join_requests"));

  const afterCounts = new Map<string, number>();
  for (const table of PRESERVED_TABLES) afterCounts.set(table, tableExists(db, table) ? count(db, table) : -1);

  for (const table of PRESERVED_TABLES) {
    const expected = beforeCounts.get(table) ?? -1;
    if (expected < 0) continue;
    const actual = afterCounts.get(table) ?? -1;
    record(`${table} 行数不变`, expected === actual, `${expected} → ${actual}`);
  }

  // ---------------------------------------------------------------- 初始组织
  const org = db.prepare("SELECT id, name, status, created_by FROM organizations").all() as Array<{
    id: string;
    name: string;
    status: string;
    created_by: string;
  }>;
  record("只有一个初始组织", org.length === 1, JSON.stringify(org));
  record("初始组织 id/状态正确", org[0]?.id === "org-default" && org[0]?.status === "active", `${org[0]?.id} / ${org[0]?.status}`);
  record("初始组织 created_by 指向管理员", ownerRow !== undefined && org[0]?.created_by === ownerRow.id, `${org[0]?.created_by}`);

  // ---------------------------------------------------------------- 账号映射
  const users = db
    .prepare("SELECT id, username, email, name, role, org_id, password_hash, must_change_password FROM users ORDER BY role, username")
    .all() as Array<{
    id: string;
    username: string;
    email: string;
    name: string;
    role: string;
    org_id: string | null;
    password_hash: string;
    must_change_password: number;
  }>;
  const roleCount = (role: string): number => users.filter((user) => user.role === role).length;
  record("账号数不变", users.length === (beforeCounts.get("users") ?? -1), String(users.length));
  record(
    "角色分布 1 管理员 / 1 组织管理者 / 其余普通用户",
    roleCount("admin") === 1 && roleCount("manager") === 1 && roleCount("member") === users.length - 2,
    `admin=${roleCount("admin")} manager=${roleCount("manager")} member=${roleCount("member")}`,
  );
  record(
    "没有残留旧角色",
    users.every((user) => ["admin", "manager", "member"].includes(user.role)),
  );
  record(
    "管理员不隶属组织",
    users.filter((user) => user.role === "admin").every((user) => user.org_id === null),
  );
  record(
    "其他账号都挂在初始组织",
    users.filter((user) => user.role !== "admin").every((user) => user.org_id === "org-default"),
  );
  record(
    "全部账号密码为 locked 占位",
    users.every((user) => user.password_hash === "locked$"),
  );
  record(
    "全部账号强制改密",
    users.every((user) => user.must_change_password === 1),
  );
  record(
    "用户名合法且唯一",
    users.every((user) => USERNAME_RE.test(user.username)) && new Set(users.map((user) => user.username)).size === users.length,
    users.map((user) => user.username).join(", "),
  );
  record(
    "邮箱是占位域名",
    users.every((user) => user.email.endsWith("@local.invalid")),
  );
  record(
    "组织管理者是创建时间最早的助理",
    earliestAssistant !== undefined && users.find((user) => user.role === "manager")?.id === earliestAssistant.id,
    `${users.find((user) => user.role === "manager")?.username} (${earliestAssistant?.id})`,
  );

  // ---------------------------------------------------------------- 数据归属
  for (const table of ORG_SCOPED_TABLES) {
    const total = count(db, table);
    const scoped = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id='org-default'`).get() as { n: number }).n;
    record(`${table} 全部挂到初始组织`, total === scoped, `${scoped}/${total}`);
  }

  const commentRoles = db.prepare("SELECT DISTINCT author_role FROM task_comments").all() as Array<{ author_role: string | null }>;
  record(
    "task_comments 的旧角色已映射",
    commentRoles.every((row) => row.author_role === null || ["admin", "manager", "member"].includes(row.author_role)),
    commentRoles.map((row) => String(row.author_role)).join(", "),
  );

  // ---------------------------------------------------------------- 约束真的生效
  const foreignKeyProblems = db.prepare("PRAGMA foreign_key_check").all();
  record("外键完整性检查干净", foreignKeyProblems.length === 0, JSON.stringify(foreignKeyProblems));

  const stamp = new Date().toISOString();
  record(
    "旧角色 owner 被 CHECK 拒绝",
    rejects(
      db,
      "INSERT INTO users(id,username,email,name,role,org_id,password_hash,must_change_password,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      "probe-owner",
      "probe-owner",
      "probe-owner@local.invalid",
      "探针",
      "owner",
      null,
      "locked$",
      1,
      1,
      stamp,
      stamp,
    ),
  );
  record(
    "注册路径可用：member + org_id=NULL 必须被允许",
    !rejects(
      db,
      "INSERT INTO users(id,username,email,name,role,org_id,password_hash,must_change_password,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      "probe-member",
      "probe-member",
      "probe-member@local.invalid",
      "探针",
      "member",
      null,
      "locked$",
      0,
      1,
      stamp,
      stamp,
    ),
  );
  db.prepare("DELETE FROM users WHERE id='probe-member'").run();
  record(
    "组织管理者必须有组织（NULL 被 CHECK 拒绝）",
    rejects(
      db,
      "INSERT INTO users(id,username,email,name,role,org_id,password_hash,must_change_password,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      "probe-manager",
      "probe-manager",
      "probe-manager@local.invalid",
      "探针",
      "manager",
      null,
      "locked$",
      0,
      1,
      stamp,
      stamp,
    ),
  );
  record(
    "管理员不得隶属组织（带 org_id 被 CHECK 拒绝）",
    rejects(
      db,
      "INSERT INTO users(id,username,email,name,role,org_id,password_hash,must_change_password,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      "probe-admin",
      "probe-admin",
      "probe-admin@local.invalid",
      "探针",
      "admin",
      "org-default",
      "locked$",
      0,
      1,
      stamp,
      stamp,
    ),
  );
  record(
    "业务表缺 org_id 被 NOT NULL 拒绝",
    rejects(
      db,
      "INSERT INTO todos(id,content,todo_date,is_completed,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      "probe-todo",
      "x",
      null,
      0,
      null,
      stamp,
      stamp,
    ),
  );
  record(
    "同一用户不能有第二个待审批申请",
    rejects(
      db,
      "INSERT INTO organization_join_requests(id,kind,user_id,org_id,status,message,created_at,decided_at,decided_by,decision_note) VALUES(?,?,?,?,?,?,?,NULL,NULL,'')",
      "probe-1",
      "join",
      users[0]?.id ?? "x",
      "org-default",
      "pending",
      "",
      stamp,
    ) === false &&
      rejects(
        db,
        "INSERT INTO organization_join_requests(id,kind,user_id,org_id,status,message,created_at,decided_at,decided_by,decision_note) VALUES(?,?,?,?,?,?,?,NULL,NULL,'')",
        "probe-2",
        "join",
        users[0]?.id ?? "x",
        "org-default",
        "pending",
        "",
        stamp,
      ),
  );

  await client.close();

  // ---------------------------------------------------------------- 报告
  console.log("\n表行数：");
  console.log(`  ${"表".padEnd(24)}${"迁移前".padStart(8)}${"迁移后".padStart(8)}`);
  for (const table of PRESERVED_TABLES) {
    const expected = beforeCounts.get(table) ?? -1;
    console.log(`  ${table.padEnd(24)}${String(expected).padStart(8)}${String(afterCounts.get(table) ?? -1).padStart(8)}`);
  }

  console.log("\n账号映射：");
  for (const user of users) {
    console.log(`  ${user.username.padEnd(16)}${user.role.padEnd(9)}${(user.org_id ?? "-").padEnd(14)}${user.name}`);
  }

  const failed = checks.filter((check) => !check.ok);
  console.log("\n核对结果：");
  for (const check of checks) {
    console.log(`  ${check.ok ? "✓" : "✗"} ${check.name}${check.detail ? `  [${check.detail}]` : ""}`);
  }
  console.log(`\n共 ${checks.length} 项，失败 ${failed.length} 项`);

  if (keep) console.log(`\n副本保留在：${workDir}`);
  else fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });

  if (failed.length > 0) process.exitCode = 1;
}

void main();

import type { DatabaseSync } from "node:sqlite";
import type { UserRole } from "../../../shared/types/domain";
import { LOCKED_PASSWORD_HASH } from "../security/password";
import type { LegacyWorkbench, MigrationStatistics, UserRole as LegacyUserRole } from "../types/database";
import {
  assertNonEmptyString,
  createEmptyStatistics,
  isoFromMillis,
  normalizeLegacyWorkbench,
  normalizeTaskSource,
  normalizeTaskStatus,
  sha256,
} from "../types/database";
import { SqliteMigrationRunner } from "./migration-runner";

/**
 * 旧 JSON → 规范化 schema 的一次性迁移（调用方已归档，现在只被 test/db/json-migration.test.ts 使用）。
 *
 * 账号密码 + 多组织改造（docs/harness/ACCOUNTS_AND_ORGS.md §3.2/§3.4/§3.5）之后：
 * - `users` 必须写全 `username`/`email`/`password_hash`/`org_id`/`must_change_password`，角色只剩 admin/manager/member；
 * - 迁移**不写密码**，一律用 `LOCKED_PASSWORD_HASH` 占位，之后由 `npm run user:init` 生成初始密码；
 * - `access_tokens` 表已删除，令牌相关逻辑全部移除；
 * - 五张业务表都有 `NOT NULL org_id`，迁移时先确保有一个组织，再把每一行挂上去。
 */

export type JsonMigrationResult = {
  status: "completed" | "already_migrated";
  sourceSha256: string;
  schemaVersion: string;
  statistics: MigrationStatistics;
  warnings: string[];
};

export type JsonMigrationOptions = {
  database: DatabaseSync;
  rawJson: string;
  sourceName: string;
  migrationsDirectory: string;
};

type MigratedIdentity = {
  id: string;
  name: string;
  /** 新结构里的角色：JSON 迁移只产出 admin 与 member（"最早助理升 manager"是 009 对旧库的规则） */
  role: UserRole;
  /** 旧 JSON 里的角色：任务来源、负责人判定仍按历史事实走（assistant 负责的任务 created_by 记助理） */
  legacyRole: LegacyUserRole;
  username: string;
};

/** 迁移出来的管理员：沿用 009 的做法保留原主键 `owner`，只把用户名换成 admin */
const ADMIN_ID = "owner";
const ADMIN_USERNAME = "admin";
const ADMIN_NAME = "主人";
/** RFC 2606 保留 TLD：明确表示「占位、不可达」 */
const LOCAL_EMAIL_DOMAIN = "local.invalid";
/** 库中还没有组织时新建的组织 */
const MIGRATED_ORG_ID = "org-migrated";
const MIGRATED_ORG_NAME = "迁移组织";
/** 名字不可用作用户名时，用 id 前 6 位兜底（与 009 的 `member-<id 前 6 位>` 一致） */
const USERNAME_FALLBACK_LENGTH = 6;

export function migrateJsonToSqlite(options: JsonMigrationOptions): JsonMigrationResult {
  const sourceSha256 = sha256(options.rawJson);
  const runner = new SqliteMigrationRunner(options.database, options.migrationsDirectory);
  const migrationResult = runner.migrate();
  const existing = options.database
    .prepare(
      "SELECT statistics_json FROM migration_runs WHERE source_sha256 = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1",
    )
    .get(sourceSha256) as { statistics_json: string } | undefined;
  if (existing) {
    return {
      status: "already_migrated",
      sourceSha256,
      schemaVersion: migrationResult.currentVersion,
      statistics: JSON.parse(existing.statistics_json) as MigrationStatistics,
      warnings: [],
    };
  }

  const workbench = normalizeLegacyWorkbench(JSON.parse(options.rawJson) as unknown);
  const statistics = createEmptyStatistics();
  const warnings: string[] = [];
  const now = new Date().toISOString();
  const runId = `json-${sourceSha256.slice(0, 32)}`;

  options.database.exec("PRAGMA foreign_keys = ON");
  options.database.exec("BEGIN IMMEDIATE");
  try {
    options.database
      .prepare(
        "INSERT INTO migration_runs(id, source_name, source_sha256, target_schema_version, status, statistics_json, started_at, completed_at) VALUES (?, ?, ?, ?, 'started', ?, ?, NULL)",
      )
      .run(runId, options.sourceName, sourceSha256, migrationResult.currentVersion, JSON.stringify(statistics), now);

    const accounts = migrateAccounts(options.database, workbench, now, statistics);
    migrateApiToken(options.database, workbench, now);
    migrateTasks(options.database, workbench, accounts.identities, accounts.orgId, now, statistics, warnings);
    migrateTodos(options.database, workbench, accounts.orgId, now, statistics);
    migrateNotes(options.database, workbench, accounts.orgId, now, statistics);
    migrateFiles(options.database, workbench, accounts.orgId, now, statistics);

    options.database
      .prepare("UPDATE migration_runs SET status = 'completed', statistics_json = ?, completed_at = ? WHERE id = ?")
      .run(JSON.stringify(statistics), new Date().toISOString(), runId);
    options.database.exec("COMMIT");
  } catch (error) {
    options.database.exec("ROLLBACK");
    throw error;
  }

  return { status: "completed", sourceSha256, schemaVersion: migrationResult.currentVersion, statistics, warnings };
}

/**
 * 建用户与组织。顺序是硬性的，因为 `PRAGMA foreign_keys = ON` 下外键真的生效：
 * 先插入管理员（`org_id` 为 NULL，全局角色）→ 用它当 `created_by` 建组织 → 其余成员挂到该组织。
 *
 * 旧的令牌（`access_tokens`）随 009/010 一起退役，这里不再搬运任何令牌。
 */
function migrateAccounts(
  database: DatabaseSync,
  workbench: LegacyWorkbench,
  now: string,
  statistics: MigrationStatistics,
): { identities: Map<string, MigratedIdentity>; orgId: string } {
  const identities = new Map<string, MigratedIdentity>();
  const identityByName = new Map<string, MigratedIdentity>();
  const legacyMembers: Array<{ id: string; name: string; legacyRole: LegacyUserRole; createdAt: string }> = [];

  for (const member of workbench.settings.assistants) {
    legacyMembers.push({
      id: assertNonEmptyString(member.id, "user id"),
      name: assertNonEmptyString(member.name, "user name"),
      legacyRole: "assistant",
      createdAt: isoFromMillis(member.createdAt, now),
    });
    statistics.assistants += 1;
  }
  for (const member of workbench.settings.viewers) {
    legacyMembers.push({
      id: assertNonEmptyString(member.id, "user id"),
      name: assertNonEmptyString(member.name, "user name"),
      legacyRole: "viewer",
      createdAt: isoFromMillis(member.createdAt, now),
    });
    statistics.viewers += 1;
  }

  // 名字重名时一律退回 id 派生（与 009 的 `COUNT(...) = 1` 判定同义）
  const nameCounts = new Map<string, number>();
  for (const member of legacyMembers) {
    const key = member.name.toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const takenUsernames = new Set<string>([ADMIN_USERNAME]);
  const allocateUsername = (id: string, name: string): string => {
    const lowered = name.toLowerCase();
    const nameUsable =
      lowered.length >= 3 &&
      lowered.length <= 32 &&
      /^[a-z0-9_-]+$/u.test(lowered) &&
      lowered !== ADMIN_USERNAME &&
      (nameCounts.get(lowered) ?? 0) === 1;
    const base = nameUsable ? lowered : `member-${id.replaceAll("-", "").slice(0, USERNAME_FALLBACK_LENGTH)}`;
    // 兜底派生值仍可能撞车（例如两个 id 前 6 位相同）：加序号保证 UNIQUE
    let candidate = base;
    let suffix = 2;
    while (takenUsernames.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    takenUsernames.add(candidate);
    return candidate;
  };

  const insertUser = database.prepare(
    "INSERT INTO users(id, username, email, name, role, org_id, password_hash, must_change_password, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)",
  );

  // 1. 管理员：全局角色，不隶属组织；密码留 locked$ 占位，等 `npm run user:init`
  insertUser.run(
    ADMIN_ID,
    ADMIN_USERNAME,
    `${ADMIN_USERNAME}@${LOCAL_EMAIL_DOMAIN}`,
    ADMIN_NAME,
    "admin",
    null,
    LOCKED_PASSWORD_HASH,
    now,
    now,
  );
  const admin: MigratedIdentity = { id: ADMIN_ID, name: ADMIN_NAME, role: "admin", legacyRole: "owner", username: ADMIN_USERNAME };
  identities.set(admin.id, admin);
  identityByName.set(admin.name, admin);

  // 2. 组织：库中已有组织就沿用（例如 009 给旧库建的 org-default），否则新建
  const orgId = ensureOrganization(database, now, admin.id);

  // 3. 其余账号：普通成员，必须有组织（users 的 CHECK 要求非 admin 的 org_id 非空）
  for (const member of legacyMembers) {
    const username = allocateUsername(member.id, member.name);
    insertUser.run(
      member.id,
      username,
      `${username}@${LOCAL_EMAIL_DOMAIN}`,
      member.name,
      "member",
      orgId,
      LOCKED_PASSWORD_HASH,
      member.createdAt,
      member.createdAt,
    );
    const identity: MigratedIdentity = { id: member.id, name: member.name, role: "member", legacyRole: member.legacyRole, username };
    identities.set(identity.id, identity);
    identityByName.set(identity.name, identity);
  }
  for (const [name, identity] of identityByName) identities.set(`name:${name}`, identity);
  return { identities, orgId };
}

/** 迁移时至少要有一个组织（业务表的 org_id 是 NOT NULL）；已有组织则沿用创建最早的那个 */
function ensureOrganization(database: DatabaseSync, now: string, createdBy: string): string {
  const existing = database.prepare("SELECT id FROM organizations ORDER BY created_at, id LIMIT 1").get() as { id: string } | undefined;
  if (existing) return existing.id;
  database
    .prepare(
      "INSERT INTO organizations(id, name, description, status, created_by, created_at, updated_at, archived_at) VALUES (?, ?, ?, 'active', ?, ?, ?, NULL)",
    )
    .run(MIGRATED_ORG_ID, MIGRATED_ORG_NAME, "旧 JSON 迁移时自动创建：收纳迁移进来的全部账号与业务数据，可改名", createdBy, now, now);
  return MIGRATED_ORG_ID;
}

function migrateApiToken(database: DatabaseSync, workbench: LegacyWorkbench, now: string): void {
  if (!workbench.settings.apiToken) return;
  const rawToken = assertNonEmptyString(workbench.settings.apiToken, "api token");
  database
    .prepare(
      "INSERT INTO api_tokens(id, name, token_hash, created_at, expires_at, revoked_at) VALUES (?, 'legacy-incoming-api', ?, ?, NULL, NULL)",
    )
    .run("api-legacy-incoming", sha256(rawToken), now);
}

/** 历史评论的角色映射（与 009 回填 task_comments 的规则一致）：owner→admin、assistant/viewer→member */
function commentAuthorRole(role: LegacyUserRole | undefined): UserRole | null {
  if (role === "owner") return "admin";
  if (role === "assistant" || role === "viewer") return "member";
  return null;
}

function migrateTasks(
  database: DatabaseSync,
  workbench: LegacyWorkbench,
  identities: Map<string, MigratedIdentity>,
  orgId: string,
  now: string,
  statistics: MigrationStatistics,
  warnings: string[],
): void {
  const insertTask = database.prepare(
    "INSERT INTO tasks(id, org_id, title, description, priority, status, progress, due_date, owner_id, created_by, source, is_private, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertLog = database.prepare(
    "INSERT INTO task_progress_logs(id, task_id, author_id, author_name, content, progress_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertComment = database.prepare(
    "INSERT INTO task_comments(id, task_id, author_id, author_name, author_role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  for (const task of workbench.tasks) {
    const id = assertNonEmptyString(task.id, "task id");
    const title = assertNonEmptyString(task.title, "task title");
    if (task.priority !== "P0" && task.priority !== "P1" && task.priority !== "P2") throw new Error(`Invalid task priority for ${id}`);
    const progress = task.progress;
    const normalizedStatus = normalizeTaskStatus(progress, task.status);
    if (normalizedStatus.corrected) statistics.correctedStatuses += 1;
    const assignee = task.assignee ?? "me";
    const assignedIdentity =
      assignee === "me"
        ? identities.get(ADMIN_ID)
        : assignee.startsWith("assistant:")
          ? identities.get(assignee.slice("assistant:".length))
          : undefined;
    const ownerId = assignedIdentity?.id ?? ADMIN_ID;
    if (!assignedIdentity) {
      warnings.push(`Task ${id} had an unresolved assignee and was assigned to the migrated administrator`);
      statistics.fallbackCreators += 1;
    }
    const source = normalizeTaskSource(task.source);
    const creator = source === "assistant" && assignedIdentity?.legacyRole === "assistant" ? assignedIdentity.id : ADMIN_ID;
    if (source === "assistant" && creator === ADMIN_ID) statistics.fallbackCreators += 1;
    const createdAt = isoFromMillis(task.createdAt, now);
    const completedAt = normalizedStatus.status === "completed" ? isoFromMillis(task.doneAt, createdAt) : null;
    insertTask.run(
      id,
      orgId,
      title,
      task.desc ?? "",
      task.priority,
      normalizedStatus.status,
      progress,
      task.due ?? null,
      ownerId,
      creator,
      source,
      Number(assignee === "me"),
      createdAt,
      completedAt ?? createdAt,
      completedAt,
    );
    statistics.tasks += 1;

    for (const [index, log] of (task.logs ?? []).entries()) {
      const content = assertNonEmptyString(log.text, `task log for ${id}`);
      const author = log.by ? identities.get(`name:${log.by}`) : undefined;
      const snapshot =
        typeof log.progress === "number" && Number.isInteger(log.progress) && log.progress >= 0 && log.progress <= 100
          ? log.progress
          : null;
      insertLog.run(`${id}:log:${index}`, id, author?.id ?? null, log.by ?? null, content, snapshot, isoFromMillis(log.t, createdAt));
      statistics.logs += 1;
    }
    for (const [index, comment] of (task.comments ?? []).entries()) {
      const content = assertNonEmptyString(comment.text, `task comment for ${id}`);
      const author = comment.by ? identities.get(`name:${comment.by}`) : undefined;
      insertComment.run(
        `${id}:comment:${index}`,
        id,
        author?.id ?? null,
        comment.by ?? null,
        commentAuthorRole(comment.role),
        content,
        isoFromMillis(comment.t, createdAt),
      );
      statistics.comments += 1;
    }
  }
}

function migrateTodos(
  database: DatabaseSync,
  workbench: LegacyWorkbench,
  orgId: string,
  now: string,
  statistics: MigrationStatistics,
): void {
  const insert = database.prepare(
    "INSERT INTO todos(id, org_id, content, todo_date, is_completed, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const todo of workbench.todos) {
    const createdAt = isoFromMillis(todo.createdAt, now);
    const completedAt = todo.done ? isoFromMillis(todo.doneAt, createdAt) : null;
    insert.run(
      assertNonEmptyString(todo.id, "todo id"),
      orgId,
      assertNonEmptyString(todo.text, "todo content"),
      todo.date ?? null,
      Number(todo.done),
      completedAt,
      createdAt,
      completedAt ?? createdAt,
    );
    statistics.todos += 1;
  }
}

function migrateNotes(
  database: DatabaseSync,
  workbench: LegacyWorkbench,
  orgId: string,
  now: string,
  statistics: MigrationStatistics,
): void {
  const insert = database.prepare("INSERT INTO notes(id, org_id, content, is_pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const note of workbench.notes) {
    const createdAt = isoFromMillis(note.createdAt, now);
    insert.run(
      assertNonEmptyString(note.id, "note id"),
      orgId,
      assertNonEmptyString(note.text, "note content"),
      Number(note.pinned ?? false),
      createdAt,
      createdAt,
    );
    statistics.notes += 1;
  }
}

function migrateFiles(
  database: DatabaseSync,
  workbench: LegacyWorkbench,
  orgId: string,
  now: string,
  statistics: MigrationStatistics,
): void {
  const insert = database.prepare(
    "INSERT INTO important_files(id, org_id, name, file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const file of workbench.files) {
    const createdAt = isoFromMillis(file.createdAt, now);
    insert.run(
      assertNonEmptyString(file.id, "file id"),
      orgId,
      assertNonEmptyString(file.name, "file name"),
      assertNonEmptyString(file.path, "file path"),
      createdAt,
      createdAt,
    );
    statistics.files += 1;
  }
}

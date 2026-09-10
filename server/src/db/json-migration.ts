import type { DatabaseSync } from "node:sqlite";
import type { LegacyWorkbench, MigrationStatistics, UserRole } from "../types/database";
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

type MemberIdentity = { id: string; name: string; role: UserRole };

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

    const identities = migrateUsersAndTokens(options.database, workbench, now, statistics);
    migrateApiToken(options.database, workbench, now);
    migrateTasks(options.database, workbench, identities, now, statistics, warnings);
    migrateTodos(options.database, workbench, now, statistics);
    migrateNotes(options.database, workbench, now, statistics);
    migrateFiles(options.database, workbench, now, statistics);

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

function migrateUsersAndTokens(
  database: DatabaseSync,
  workbench: LegacyWorkbench,
  now: string,
  statistics: MigrationStatistics,
): Map<string, MemberIdentity> {
  const identities = new Map<string, MemberIdentity>();
  const identityByName = new Map<string, MemberIdentity>();
  const insertUser = database.prepare("INSERT INTO users(id, name, role, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)");
  const insertAccessToken = database.prepare(
    "INSERT INTO access_tokens(id, user_id, token_hash, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL, NULL)",
  );
  const usedHashes = new Set<string>();
  const addUser = (id: string, name: string, role: UserRole, createdAt: string): void => {
    assertNonEmptyString(id, "user id");
    assertNonEmptyString(name, "user name");
    insertUser.run(id, name, role, createdAt, createdAt);
    const identity = { id, name, role };
    identities.set(id, identity);
    identityByName.set(name, identity);
  };
  const addToken = (id: string, token: string, createdAt: string): void => {
    const rawToken = assertNonEmptyString(token, "access token");
    const tokenHash = sha256(rawToken);
    if (usedHashes.has(tokenHash)) throw new Error("Duplicate access token detected in source JSON");
    usedHashes.add(tokenHash);
    insertAccessToken.run(`access-${id}`, id, tokenHash, createdAt);
  };

  addUser("owner", "主人", "owner", now);
  const ownerToken = workbench.settings.ownerToken ?? workbench.settings.shareToken;
  if (!ownerToken) throw new Error("Owner access token is required for migration");
  addToken("owner", ownerToken, now);

  for (const member of workbench.settings.assistants) {
    const createdAt = isoFromMillis(member.createdAt, now);
    addUser(member.id, member.name, "assistant", createdAt);
    addToken(member.id, member.token, createdAt);
    statistics.assistants += 1;
  }
  for (const member of workbench.settings.viewers) {
    const createdAt = isoFromMillis(member.createdAt, now);
    addUser(member.id, member.name, "viewer", createdAt);
    addToken(member.id, member.token, createdAt);
    statistics.viewers += 1;
  }
  for (const [name, identity] of identityByName) identities.set(`name:${name}`, identity);
  return identities;
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

function migrateTasks(
  database: DatabaseSync,
  workbench: LegacyWorkbench,
  identities: Map<string, MemberIdentity>,
  now: string,
  statistics: MigrationStatistics,
  warnings: string[],
): void {
  const insertTask = database.prepare(
    "INSERT INTO tasks(id, title, description, priority, status, progress, due_date, owner_id, created_by, source, is_private, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        ? identities.get("owner")
        : assignee.startsWith("assistant:")
          ? identities.get(assignee.slice("assistant:".length))
          : undefined;
    const ownerId = assignedIdentity?.id ?? "owner";
    if (!assignedIdentity) {
      warnings.push(`Task ${id} had an unresolved assignee and was assigned to owner`);
      statistics.fallbackCreators += 1;
    }
    const source = normalizeTaskSource(task.source);
    const creator = source === "assistant" && assignedIdentity?.role === "assistant" ? assignedIdentity.id : "owner";
    if (source === "assistant" && creator === "owner") statistics.fallbackCreators += 1;
    const createdAt = isoFromMillis(task.createdAt, now);
    const completedAt = normalizedStatus.status === "completed" ? isoFromMillis(task.doneAt, createdAt) : null;
    insertTask.run(
      id,
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
      const role = comment.role === "owner" || comment.role === "assistant" || comment.role === "viewer" ? comment.role : null;
      const author = comment.by ? identities.get(`name:${comment.by}`) : undefined;
      insertComment.run(
        `${id}:comment:${index}`,
        id,
        author?.id ?? null,
        comment.by ?? null,
        role,
        content,
        isoFromMillis(comment.t, createdAt),
      );
      statistics.comments += 1;
    }
  }
}

function migrateTodos(database: DatabaseSync, workbench: LegacyWorkbench, now: string, statistics: MigrationStatistics): void {
  const insert = database.prepare(
    "INSERT INTO todos(id, content, todo_date, is_completed, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const todo of workbench.todos) {
    const createdAt = isoFromMillis(todo.createdAt, now);
    const completedAt = todo.done ? isoFromMillis(todo.doneAt, createdAt) : null;
    insert.run(
      assertNonEmptyString(todo.id, "todo id"),
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

function migrateNotes(database: DatabaseSync, workbench: LegacyWorkbench, now: string, statistics: MigrationStatistics): void {
  const insert = database.prepare("INSERT INTO notes(id, content, is_pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  for (const note of workbench.notes) {
    const createdAt = isoFromMillis(note.createdAt, now);
    insert.run(
      assertNonEmptyString(note.id, "note id"),
      assertNonEmptyString(note.text, "note content"),
      Number(note.pinned ?? false),
      createdAt,
      createdAt,
    );
    statistics.notes += 1;
  }
}

function migrateFiles(database: DatabaseSync, workbench: LegacyWorkbench, now: string, statistics: MigrationStatistics): void {
  const insert = database.prepare("INSERT INTO important_files(id, name, file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  for (const file of workbench.files) {
    const createdAt = isoFromMillis(file.createdAt, now);
    insert.run(
      assertNonEmptyString(file.id, "file id"),
      assertNonEmptyString(file.name, "file name"),
      assertNonEmptyString(file.path, "file path"),
      createdAt,
      createdAt,
    );
    statistics.files += 1;
  }
}

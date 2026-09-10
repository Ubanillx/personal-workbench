import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openWritableDatabase } from "../../server/src/db/client";
import { migrateJsonToSqlite } from "../../server/src/db/json-migration";
import { TaskRepository } from "../../server/src/db/repositories/task-repository";

const migrationsDirectory = path.resolve(process.cwd(), "server/src/db/migrations");
const fixture = JSON.stringify({
  tasks: [{ id: "task-1", title: "迁移任务", desc: "", priority: "P1", status: "doing", progress: 50, due: "2026-09-05", assignee: "assistant:a1", logs: [{ t: 1, text: "开始" }], comments: [{ t: 2, text: "反馈", by: "查看者", role: "viewer" }], source: "assistant", createdAt: 1, doneAt: null }],
  todos: [{ id: "todo-1", text: "待办", done: false, date: "2026-09-04", createdAt: 1, doneAt: null }],
  notes: [{ id: "note-1", text: "笔记", pinned: true, createdAt: 1 }],
  files: [{ id: "file-1", name: "file.txt", path: "C:/safe/file.txt", createdAt: 1 }],
  settings: { apiToken: "fixture-api-token", ownerToken: "fixture-owner-token", assistants: [{ id: "a1", name: "助理", token: "fixture-assistant-token", createdAt: 1 }], viewers: [{ id: "v1", name: "查看者", token: "fixture-viewer-token", createdAt: 1 }] }
});

async function tempDatabase(): Promise<{ directory: string; databasePath: string }> { const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-stage4-")); return { directory, databasePath: path.join(directory, "stage4.sqlite") }; }

test("JSON 迁移建立规范化 schema 与业务数据", async (t) => {
  const temp = await tempDatabase();
  const database = openWritableDatabase(temp.databasePath);
  t.after(async () => { database.close(); await rm(temp.directory, { recursive: true, force: true }); });
  const result = migrateJsonToSqlite({ database, rawJson: fixture, sourceName: "fixture.json", migrationsDirectory });
  assert.equal(result.status, "completed");
  assert.equal(result.statistics.tasks, 1);
  assert.equal(result.statistics.logs, 1);
  assert.equal(result.statistics.comments, 1);
  const task = new TaskRepository(database).findById("task-1");
  assert.equal(task?.status, "in_progress");
  assert.equal(task?.ownerId, "a1");
  assert.equal(task?.createdBy, "a1");
  assert.equal(task?.isPrivate, false);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM access_tokens").get() as { count: number }).count, 3);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM task_comments").get() as { count: number }).count, 1);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM task_progress_logs").get() as { count: number }).count, 1);
  const columns = database.prepare("PRAGMA table_info(access_tokens)").all() as Array<{ name: string }>;
  assert.equal(columns.some((column) => column.name === "token"), false);
});

test("重复迁移同一 JSON 不会重复写入", async (t) => {
  const temp = await tempDatabase();
  const database = openWritableDatabase(temp.databasePath);
  t.after(async () => { database.close(); await rm(temp.directory, { recursive: true, force: true }); });
  migrateJsonToSqlite({ database, rawJson: fixture, sourceName: "fixture.json", migrationsDirectory });
  const second = migrateJsonToSqlite({ database, rawJson: fixture, sourceName: "fixture.json", migrationsDirectory });
  assert.equal(second.status, "already_migrated");
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count, 1);
});

test("非法 priority 会回滚整个迁移", async (t) => {
  const temp = await tempDatabase();
  const database = openWritableDatabase(temp.databasePath);
  t.after(async () => { database.close(); await rm(temp.directory, { recursive: true, force: true }); });
  const invalid = fixture.replace('"priority":"P1"', '"priority":"P9"');
  assert.throws(() => migrateJsonToSqlite({ database, rawJson: invalid, sourceName: "fixture.json", migrationsDirectory }), /Invalid task priority/);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count, 0);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM migration_runs").get() as { count: number }).count, 0);
});

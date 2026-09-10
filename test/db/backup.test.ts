import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backupSqlite } from "../../server/src/db/backup";

test("SQLite 备份最多保留指定数量", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workbench-backup-"));
  const source = path.join(dir, "source.sqlite");
  const backupDir = path.join(dir, "backups");
  await writeFile(source, "fixture");
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (let i = 0; i < 7; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    await backupSqlite(source, backupDir, 5);
  }
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(backupDir);
  assert.equal(files.filter((file) => file.endsWith(".sqlite.bak")).length, 5);
});

test("不存在的 SQLite 源不会创建备份目录", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workbench-backup-empty-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await backupSqlite(path.join(dir, "missing.sqlite"), path.join(dir, "backups"));
  assert.equal(result, null);
});

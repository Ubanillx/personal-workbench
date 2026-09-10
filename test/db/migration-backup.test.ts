import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabaseClient } from "../../server/src/db/client";

test("现有 SQLite 在执行待应用迁移前会自动备份", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-migration-backup-"));
  const databasePath = path.join(directory, "workbench.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceMigrations = path.resolve(process.cwd(), "server/src/db/migrations");
  const legacyMigrations = path.join(directory, "legacy-migrations");
  await mkdir(legacyMigrations);
  for (const file of ["001_initial_schema.sql", "002_indexes.sql", "003_sessions.sql"]) await copyFile(path.join(sourceMigrations, file), path.join(legacyMigrations, file));
  const first = createDatabaseClient({ databasePath, migrationsDirectory: legacyMigrations });
  await first.close();
  const client = createDatabaseClient({ databasePath, migrationsDirectory: sourceMigrations });
  await client.close();
  const names = await readdir(directory);
  assert.ok(names.some((name) => /^workbench\.before-migration-.+\.sqlite\.bak$/u.test(name)));
});

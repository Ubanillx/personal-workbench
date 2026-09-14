import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDatabaseClient } from "../../server/src/db/client";

/**
 * 迁移 **017 + 018** 的副本演练：把正式库复制一份，先读改动前的行数，再跑迁移，逐项核对
 * 「待办/随手记的 owner_id 是否都认领到了本组织的人」「重要文件是否都回填成组织可见」
 * 「两批数据一条都没丢」。
 *
 *   node --import tsx tools/db/rehearse-personal-records.ts
 *
 * 只读正式库（复制出来才写），失败不影响 data/workbench.sqlite。
 */

type Counts = { todos: number; notes: number; files: number };

function counts(db: DatabaseSync): Counts {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;
  return {
    todos: one("SELECT COUNT(*) AS n FROM todos"),
    notes: one("SELECT COUNT(*) AS n FROM notes"),
    files: one("SELECT COUNT(*) AS n FROM important_files"),
  };
}

function main(): void {
  const source = path.resolve(process.cwd(), "data", "workbench.sqlite");
  if (!fs.existsSync(source)) throw new Error(`找不到正式库：${source}`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-rehearse-"));
  const copy = path.join(directory, "workbench.sqlite");
  fs.copyFileSync(source, copy);

  // 改动前的行数要在**迁移之前**读：迁移会就地改这个副本
  const raw = new DatabaseSync(copy, { readOnly: true });
  const before = counts(raw);
  raw.close();

  const client = createDatabaseClient({
    databasePath: copy,
    readOnly: false,
    migrationsDirectory: path.resolve(process.cwd(), "server/src/db/migrations"),
  });
  const db = client.getDatabase();
  const rows = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
  const scalar = (sql: string): number => (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;

  const after = counts(db);
  const unownedTodos = scalar("SELECT COUNT(*) AS n FROM todos WHERE owner_id IS NULL");
  const unownedNotes = scalar("SELECT COUNT(*) AS n FROM notes WHERE owner_id IS NULL");
  const unownedFiles = scalar("SELECT COUNT(*) AS n FROM important_files WHERE owner_id IS NULL");
  const strayVisibility = scalar(
    "SELECT COUNT(*) AS n FROM important_files WHERE visibility IS NULL OR visibility NOT IN ('org','private')",
  );
  const privateFiles = scalar("SELECT COUNT(*) AS n FROM important_files WHERE visibility='private'");
  const claimants = rows<{ owner_id: string; role: string; n: number }>(
    `SELECT f.owner_id AS owner_id, u.role AS role, COUNT(*) AS n
       FROM important_files f JOIN users u ON u.id = f.owner_id
      GROUP BY f.owner_id, u.role`,
  );
  const hasColumn = (table: string, column: string): boolean =>
    rows<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === column);
  const applied = (version: string): boolean => scalar(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version='${version}'`) === 1;

  const checks: Array<[string, boolean, string]> = [
    ["迁移已记录 017_personal_records", applied("017_personal_records"), ""],
    ["迁移已记录 018_file_visibility", applied("018_file_visibility"), ""],
    [
      "三张表行数都不变",
      before.todos === after.todos && before.notes === after.notes && before.files === after.files,
      JSON.stringify({ before, after }),
    ],
    ["todos 全部有归属人", unownedTodos === 0, `未认领 ${unownedTodos} 条`],
    ["notes 全部有归属人", unownedNotes === 0, `未认领 ${unownedNotes} 条`],
    ["重要文件全部有归属人", unownedFiles === 0, `未认领 ${unownedFiles} 条`],
    ["重要文件的可见范围都已回填（org / private）", strayVisibility === 0, `异常 ${strayVisibility} 条`],
    ["老数据的行为零变化：回填后没有任何 private", privateFiles === 0, `private ${privateFiles} 条（老数据应全部是 org）`],
    [
      "重要文件的归属人都是组织管理者或管理员",
      claimants.every((row) => row.role === "manager" || row.role === "admin"),
      JSON.stringify(claimants),
    ],
    [
      "owner_id 列已存在（todos / notes / important_files）",
      ["todos", "notes", "important_files"].every((t) => hasColumn(t, "owner_id")),
      "",
    ],
    ["visibility 列已存在（important_files）", hasColumn("important_files", "visibility"), ""],
  ];

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  [${detail}]` : ""}`);
  }
  console.log(`\n共 ${checks.length} 项，失败 ${failed} 项`);
  console.log(`重要文件归属明细：${JSON.stringify(claimants)}`);

  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
  if (failed > 0) process.exitCode = 1;
}

main();

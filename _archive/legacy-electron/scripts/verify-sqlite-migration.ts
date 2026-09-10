import { readFile } from "node:fs/promises";
import path from "node:path";
import { openWritableDatabase } from "../server/src/db/client";
import { sha256 } from "../server/src/types/database";

const root = process.cwd();
const args = process.argv.slice(2);
const valueAfter = (name: string): string | undefined => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const sourcePath = path.resolve(root, valueAfter("--source") ?? "data/workbench.json");
const targetPath = path.resolve(root, valueAfter("--target") ?? "data/workbench.stage4.sqlite");

async function main(): Promise<void> {
  const raw = await readFile(sourcePath, "utf8");
  const sourceHash = sha256(raw);
  const database = openWritableDatabase(targetPath);
  try {
    const row = database.prepare("SELECT source_name, source_sha256, target_schema_version, status, statistics_json FROM migration_runs WHERE source_sha256 = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1").get(sourceHash) as { source_name: string; source_sha256: string; target_schema_version: string; status: string; statistics_json: string } | undefined;
    if (!row) throw new Error("No completed migration found for source JSON");
    const count = (table: string): number => Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    const sensitiveColumns = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%token%' AND name NOT IN ('access_tokens', 'api_tokens')").all();
    const statistics = JSON.parse(row.statistics_json) as Record<string, number>;
    const actual = { tasks: count("tasks"), todos: count("todos"), notes: count("notes"), assistants: Number((database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'assistant'").get() as { count: number }).count), viewers: Number((database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'viewer'").get() as { count: number }).count), logs: count("task_progress_logs"), comments: count("task_comments"), files: count("important_files") };
    const expectedKeys = ["tasks", "todos", "notes", "assistants", "viewers", "logs", "comments", "files"] as const;
    for (const key of expectedKeys) if (actual[key] !== statistics[key]) throw new Error(`Count mismatch for ${key}`);
    if (foreignKeys.length > 0) throw new Error("Foreign key check failed");
    if (sensitiveColumns.length > 0) throw new Error("Unexpected sensitive columns detected");
    console.log(JSON.stringify({ ok: true, sourceSha256Prefix: row.source_sha256.slice(0, 12), schemaVersion: row.target_schema_version, counts: actual, foreignKeys: "passed", sensitiveFields: "passed" }));
  } finally { database.close(); }
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Verification failed"); process.exitCode = 1; });

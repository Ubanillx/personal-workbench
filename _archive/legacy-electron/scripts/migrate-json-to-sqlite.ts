import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { openWritableDatabase } from "../server/src/db/client";
import { migrateJsonToSqlite } from "../server/src/db/json-migration";
import { sha256 } from "../server/src/types/database";

const root = process.cwd();
const args = process.argv.slice(2);
const valueAfter = (name: string): string | undefined => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const sourcePath = path.resolve(root, valueAfter("--source") ?? "data/workbench.json");
const targetPath = path.resolve(root, valueAfter("--target") ?? "data/workbench.stage4.sqlite");
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");

async function main(): Promise<void> {
  const rawJson = await readFile(sourcePath, "utf8");
  const sourceHash = sha256(rawJson);
  if (dryRun) {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const settings = typeof parsed.settings === "object" && parsed.settings !== null ? parsed.settings as Record<string, unknown> : {};
    const count = (key: string): number => Array.isArray(parsed[key]) ? parsed[key].length : 0;
    console.log(JSON.stringify({ mode: "dry-run", source: path.basename(sourcePath), sourceSha256Prefix: sourceHash.slice(0, 12), tasks: count("tasks"), todos: count("todos"), notes: count("notes"), files: count("files"), assistants: Array.isArray(settings.assistants) ? settings.assistants.length : 0, viewers: Array.isArray(settings.viewers) ? settings.viewers.length : 0 }));
    return;
  }
  if (targetPath.toLowerCase().endsWith("workbench.sqlite") && !targetPath.toLowerCase().endsWith("workbench.stage4.sqlite")) throw new Error("Refusing to write the formal workbench.sqlite target");
  if (!force) {
    try { await readFile(targetPath); throw new Error(`Target already exists: ${targetPath}`); } catch (error) { if (error instanceof Error && error.message.startsWith("Target already exists")) throw error; }
  }
  await mkdir(path.dirname(targetPath), { recursive: true });
  const database = openWritableDatabase(targetPath);
  try {
    const result = migrateJsonToSqlite({ database, rawJson, sourceName: path.basename(sourcePath), migrationsDirectory: path.join(root, "server/src/db/migrations") });
    console.log(JSON.stringify({ mode: "migration", status: result.status, sourceSha256Prefix: result.sourceSha256.slice(0, 12), schemaVersion: result.schemaVersion, statistics: result.statistics, warnings: result.warnings }));
  } finally { database.close(); }
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Migration failed"); process.exitCode = 1; });

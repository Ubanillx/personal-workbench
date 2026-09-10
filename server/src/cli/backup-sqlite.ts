import path from "node:path";
import { backupSqlite } from "../db/backup";

const root = process.cwd();
const args = process.argv.slice(2);
const valueAfter = (name: string): string | undefined => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const sourcePath = path.resolve(root, valueAfter("--source") ?? "data/workbench.sqlite");
const backupDirectory = path.resolve(root, valueAfter("--backup-dir") ?? "data/backups");

void backupSqlite(sourcePath, backupDirectory).then((result) => {
  console.log(JSON.stringify({ ok: true, created: result !== null }));
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Backup failed");
  process.exitCode = 1;
});

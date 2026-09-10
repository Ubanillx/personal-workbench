import { copyFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { backup as sqliteBackup, type DatabaseSync } from "node:sqlite";

export async function backupSqlite(sourcePath: string, backupDirectory: string, keep = 5): Promise<string | null> {
  try { await stat(sourcePath); } catch { return null; }
  await mkdir(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const targetPath = path.join(backupDirectory, `workbench-${stamp}.sqlite.bak`);
  await copyFile(sourcePath, targetPath);
  await pruneBackups(backupDirectory, keep);
  return targetPath;
}

export async function backupOpenDatabase(source: DatabaseSync, backupDirectory: string, keep = 5): Promise<string> {
  await mkdir(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const targetPath = path.join(backupDirectory, `workbench-${stamp}.sqlite.bak`);
  await sqliteBackup(source, targetPath);
  await pruneBackups(backupDirectory, keep);
  return targetPath;
}

async function pruneBackups(backupDirectory: string, keep: number): Promise<void> {
  const files = (await readdir(backupDirectory)).filter((file) => file.endsWith(".sqlite.bak")).sort();
  for (const oldFile of files.slice(0, Math.max(0, files.length - keep))) await unlink(path.join(backupDirectory, oldFile));
}

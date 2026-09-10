import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type MigrationResult = { applied: string[]; currentVersion: string };

export class SqliteMigrationRunner {
  public constructor(private readonly database: DatabaseSync, private readonly migrationsDirectory: string) {}

  public migrate(): MigrationResult {
    this.database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const appliedRows = this.database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>;
    const applied = new Set(appliedRows.map((row) => row.version));
    const files = readdirSync(this.migrationsDirectory).filter((file) => file.endsWith(".sql")).sort();
    const appliedNow: string[] = [];
    // Some migrations rebuild tables that are referenced by foreign keys.
    // SQLite only allows toggling foreign-key enforcement outside a transaction.
    this.database.exec("PRAGMA foreign_keys = OFF");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const file of files) {
        const version = file.replace(/\.sql$/u, "");
        if (applied.has(version)) continue;
        const sql = readFileSync(path.join(this.migrationsDirectory, file), "utf8");
        this.database.exec(sql);
        this.database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
        appliedNow.push(version);
      }
      this.database.exec("COMMIT");
      this.database.exec("PRAGMA foreign_keys = ON");
    } catch (error) {
      this.database.exec("ROLLBACK");
      this.database.exec("PRAGMA foreign_keys = ON");
      throw error;
    }
    const currentVersion = [...applied, ...appliedNow].sort().at(-1) ?? "none";
    return { applied: appliedNow, currentVersion };
  }
}

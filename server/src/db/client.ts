import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { SqliteMigrationRunner } from "./migration-runner";

const nodeRequire = createRequire(__filename);
type DatabaseConstructor = typeof DatabaseSyncType;
let databaseConstructor: DatabaseConstructor | undefined;

function getDatabaseConstructor(): DatabaseConstructor {
  if (databaseConstructor) return databaseConstructor;
  try {
    databaseConstructor = nodeRequire("node:sqlite").DatabaseSync as DatabaseConstructor;
    return databaseConstructor;
  } catch {
    throw new Error("当前 Node.js 不支持 node:sqlite，请使用 Node.js 22.5 或更高版本");
  }
}

export interface DatabaseClient {
  healthCheck(): Promise<{ available: boolean; driver: string }>;
  close(): Promise<void>;
  getDatabase(): DatabaseSyncType;
}

export type SqliteClientOptions = {
  databasePath: string;
  readOnly?: boolean;
};

export class SqliteDatabaseClient implements DatabaseClient {
  private readonly database: DatabaseSyncType;

  public constructor(options: SqliteClientOptions & { migrationsDirectory?: string }) {
    const DatabaseSync = getDatabaseConstructor();
    const resolvedDatabasePath = path.resolve(options.databasePath);
    const existedBeforeOpen = fs.existsSync(resolvedDatabasePath);
    fs.mkdirSync(path.dirname(resolvedDatabasePath), { recursive: true });
    this.database = new DatabaseSync(options.databasePath, { readOnly: options.readOnly ?? false });
    if (!options.readOnly && options.migrationsDirectory) {
      if (existedBeforeOpen && hasPendingMigrations(this.database, options.migrationsDirectory)) {
        backupBeforeMigration(resolvedDatabasePath);
      }
      new SqliteMigrationRunner(this.database, options.migrationsDirectory).migrate();
      this.database.exec("CREATE TABLE IF NOT EXISTS access_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT); CREATE INDEX IF NOT EXISTS idx_access_sessions_hash ON access_sessions(session_hash); CREATE INDEX IF NOT EXISTS idx_access_sessions_user_id ON access_sessions(user_id);");
    }
  }

  public async healthCheck(): Promise<{ available: boolean; driver: string }> {
    this.database.prepare("SELECT 1").get();
    return { available: true, driver: "node:sqlite" };
  }

  public async close(): Promise<void> {
    this.database.close();
  }

  public getDatabase(): DatabaseSyncType {
    return this.database;
  }
}

export function createDatabaseClient(options: SqliteClientOptions & { migrationsDirectory?: string }): DatabaseClient {
  return new SqliteDatabaseClient(options);
}

export function openWritableDatabase(databasePath: string): DatabaseSyncType {
  const DatabaseSync = getDatabaseConstructor();
  fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  return new DatabaseSync(databasePath, { readOnly: false });
}

function hasPendingMigrations(database: DatabaseSyncType, migrationsDirectory: string): boolean {
  const files = fs.readdirSync(migrationsDirectory).filter((file) => file.endsWith(".sql"));
  if (!files.length) return false;
  try {
    const applied = new Set((database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>).map((row) => row.version));
    return files.some((file) => !applied.has(file.replace(/\.sql$/u, "")));
  } catch {
    return true;
  }
}

function backupBeforeMigration(databasePath: string): void {
  const directory = path.dirname(databasePath);
  const extension = path.extname(databasePath);
  const basename = path.basename(databasePath, extension);
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const target = path.join(directory, `${basename}.before-migration-${stamp}${extension}.bak`);
  fs.copyFileSync(databasePath, target);
}

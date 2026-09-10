import path from "node:path";
import { loadConfig, type AppConfig } from "../../server/src/config/env";
import { createDatabaseClient, type DatabaseClient } from "../../server/src/db/client";
import { databaseHealth } from "../../server/src/db/health";

const MIGRATIONS_DIRECTORY = path.resolve(process.cwd(), "server/src/db/migrations");

let cachedConfig: AppConfig | undefined;
let cachedDatabase: DatabaseClient | undefined;
let databaseResolved = false;

export function appConfig(): AppConfig {
  cachedConfig ??= loadConfig();
  return cachedConfig;
}

/**
 * 单进程内复用一个 SQLite 连接。
 * 建库失败时的语义与旧 app.ts 的 createDatabaseIfPresent 保持一致：
 * 生产环境直接抛错，非生产环境降级为 undefined（健康检查会报 not_configured）。
 */
export function appDatabase(): DatabaseClient | undefined {
  if (databaseResolved) return cachedDatabase;
  databaseResolved = true;
  try {
    cachedDatabase = createDatabaseClient({
      databasePath: appConfig().databasePath,
      readOnly: false,
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    });
  } catch (error) {
    if (appConfig().nodeEnv === "production") throw error;
    console.warn(`SQLite 数据库未连接：${error instanceof Error ? error.message : "未知错误"}`);
    cachedDatabase = undefined;
  }
  return cachedDatabase;
}

/** 与旧 server/src/routes/health.ts 的 payload() 逐字段一致 */
export async function healthPayload(): Promise<Record<string, unknown>> {
  return {
    name: "personal-workbench",
    status: "ok",
    version: "1.0.0",
    runtime: "node",
    database: await databaseHealth(appDatabase()),
    timestamp: new Date().toISOString(),
  };
}

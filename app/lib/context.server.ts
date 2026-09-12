import path from "node:path";
import { DEFAULT_ORG_NAME, ensureDefaultAdminAndOrganization } from "../../server/src/db/bootstrap";
import { loadConfig, loadDotEnv, type AppConfig } from "../../server/src/config/env";
import { assertSupportedNodeRuntime } from "../../server/src/runtime";
import { createDatabaseClient, type DatabaseClient } from "../../server/src/db/client";
import { databaseHealth } from "../../server/src/db/health";

const MIGRATIONS_DIRECTORY = path.resolve(process.cwd(), "server/src/db/migrations");

let cachedConfig: AppConfig | undefined;
let cachedDatabase: DatabaseClient | undefined;
let databaseResolved = false;

/**
 * 配置来源是**进程环境变量**；`.env` 是可选的便利层（见 `loadDotEnv`）。
 * 注意 `HOST` / `PORT` 由 `npm run serve` 的适配器更早读取，那两个变量靠
 * package.json 里的 `--env-file-if-exists=.env` 兜底。
 *
 * 顺带把运行时下限也在这里校验一次：下限是 22.9.0（`--env-file-if-exists` 需要），
 * 早报一句「需要 Node >=22.9.0」比让 node 抛 `bad option` 清楚。
 */
export function appConfig(): AppConfig {
  assertSupportedNodeRuntime();
  loadDotEnv();
  cachedConfig ??= loadConfig();
  return cachedConfig;
}

/**
 * 单进程内复用一个 SQLite 连接。
 * 建库失败时的语义与旧 app.ts 的 createDatabaseIfPresent 保持一致：
 * 生产环境直接抛错，非生产环境降级为 undefined（健康检查会报 not_configured）。
 *
 * 迁移之后立刻做一次自举（见 server/src/db/bootstrap.ts）：全新库在这里拿到
 * 「默认管理员 admin + 默认组织」，否则空库既没人能建组织、也没有组织可申请加入。
 */
export function appDatabase(): DatabaseClient | undefined {
  if (databaseResolved) return cachedDatabase;
  databaseResolved = true;
  try {
    const client = createDatabaseClient({
      databasePath: appConfig().databasePath,
      readOnly: false,
      migrationsDirectory: MIGRATIONS_DIRECTORY,
    });
    const bootstrap = ensureDefaultAdminAndOrganization(client.getDatabase());
    if (bootstrap.createdAdmin && bootstrap.adminUsername) {
      console.warn(
        `已初始化默认管理员「${bootstrap.adminUsername}」与「${DEFAULT_ORG_NAME}」；首次登录前请在本机执行：npm run user:init -- --confirm`,
      );
    }
    cachedDatabase = client;
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

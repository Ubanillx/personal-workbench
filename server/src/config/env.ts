import fs from "node:fs";
import path from "node:path";

/**
 * 进程环境变量配置（数据库路径、监听地址、上传目录、WebDAV 地址）。
 *
 * WebDAV 拆成两半（见 docs/harness/WEBDAV.md）：
 * - **地址**是部署级的，来自 `WEBDAV_URL`——一个团队通常共用一个 NAS；
 * - **用户名 / 密码 / 浏览根目录 / 超时**是每个账号自己的，在设置页里维护、落库
 *   （`webdav_settings`）。
 */
export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databasePath: string;
  sessionCookieName: string;
  uploadsDir: string;
  /** 「重要文件」的 WebDAV 地址（`WEBDAV_URL`）；空串 = 整个远端通道未接入 */
  webdavUrl: string;
};

function positivePort(value: string | undefined): number {
  const port = Number(value ?? "17500");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535");
  }
  return port;
}

/**
 * 是否已经尝试过加载 `.env`（模块级标记：重复调用是空操作）。
 *
 * `process.loadEnvFile` **不会覆盖**已经存在于进程环境里的变量，所以
 * `$env:PORT=18000; npm run serve` 这种临时覆盖优先级始终高于 `.env` 文件。
 */
let dotEnvLoaded = false;

/**
 * 加载仓库根的 `.env`（Node 内置 `process.loadEnvFile`，不引第三方依赖）。
 *
 * 两条刻意的边界：
 * 1. **没有 `.env` 是正常情况**（该文件被 gitignore）：ENOENT 静默跳过，
 *    其余错误也只降级成一条警告——环境变量是可选的，缺了不该让服务起不来；
 * 2. 只加载一次；`HOST` / `PORT` 要在适配器启动**之前**进环境，所以 `npm run serve`
 *    还会用 Node 的 `--env-file-if-exists=.env` 再兜一道（见 package.json）。
 */
export function loadDotEnv(cwd = process.cwd()): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  const envPath = path.join(cwd, ".env");
  if (!fs.existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch (error) {
    console.warn(`.env 加载失败（已跳过）：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const rawEnv = env.NODE_ENV ?? "development";
  const nodeEnv: AppConfig["nodeEnv"] = rawEnv === "production" || rawEnv === "test" ? rawEnv : "development";
  return {
    nodeEnv,
    host: env.HOST ?? "127.0.0.1",
    port: positivePort(env.PORT),
    databasePath: path.resolve(cwd, env.DATABASE_PATH ?? "data/workbench.sqlite"),
    sessionCookieName: env.SESSION_COOKIE_NAME ?? "workbench_session",
    uploadsDir: path.resolve(cwd, env.UPLOADS_DIR ?? "data/uploads/reports"),
    webdavUrl: (env.WEBDAV_URL ?? "").trim(),
  };
}

import path from "node:path";

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databasePath: string;
  webDistPath: string;
  sessionCookieName: string;
  uploadsDir: string;
};

function positivePort(value: string | undefined): number {
  const port = Number(value ?? "17500");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535");
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const rawEnv = env.NODE_ENV ?? "development";
  const nodeEnv: AppConfig["nodeEnv"] = rawEnv === "production" || rawEnv === "test" ? rawEnv : "development";
  return {
    nodeEnv,
    host: env.HOST ?? "127.0.0.1",
    port: positivePort(env.PORT),
    databasePath: path.resolve(cwd, env.DATABASE_PATH ?? "data/workbench.sqlite"),
    webDistPath: path.resolve(cwd, env.WEB_DIST_PATH ?? "web/dist"),
    sessionCookieName: env.SESSION_COOKIE_NAME ?? "workbench_session",
    uploadsDir: path.resolve(cwd, env.UPLOADS_DIR ?? "data/uploads/reports"),
  };
}

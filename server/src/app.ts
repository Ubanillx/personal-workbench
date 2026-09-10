import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, type AppConfig } from "./config/env";
import { createDatabaseClient, type DatabaseClient } from "./db/client";
import { registerHealthRoutes } from "./routes/health";
import { registerReportRoutes } from "./routes/report";
import { registerWorkbenchRoutes } from "./routes/workbench";

export type BuildAppOptions = {
  config?: AppConfig;
  database?: DatabaseClient;
  enableDatabase?: boolean;
  uploadsDir?: string;
};

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  let ownedDatabase: DatabaseClient | undefined;

  await app.register(helmet, {
    // The default CSP includes `upgrade-insecure-requests`, which makes browsers
    // rewrite http:// subresources to https:// on non-loopback origins (e.g. the
    // LAN address assistants use). Since this service listens on plain HTTP, that
    // upgrade breaks the SPA bundle load and leaves a blank page. Remove it while
    // keeping the rest of the default directives.
    contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    // HSTS and COOP are only meaningful over HTTPS; they are ignored (HSTS) or
    // produce noisy console warnings (COOP) on a plain-HTTP LAN service.
    strictTransportSecurity: false,
    crossOriginOpenerPolicy: false
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 10, parts: 20 },
    throwFileSizeLimit: true
  });
  if (config.nodeEnv !== "production") {
    await app.register(cors, { origin: true, credentials: true });
  }

  const database = options.database ?? (options.enableDatabase === false ? undefined : createDatabaseIfPresent(config));
  if (!options.database) ownedDatabase = database;
  app.addHook("onClose", async () => {
    await ownedDatabase?.close();
  });

  await registerHealthRoutes(app, { config, database });
  if (database) {
    await registerWorkbenchRoutes(app, { config, database });
    await registerReportRoutes(app, { config, database, uploadsDir: options.uploadsDir ?? config.uploadsDir });
  }

  if (config.nodeEnv === "production" && fs.existsSync(config.webDistPath)) {
    await app.register(fastifyStatic, {
      root: config.webDistPath,
      wildcard: true,
      index: false
    });
    // fastify-static treats the dist root as a directory; serve the SPA entry explicitly.
    app.get("/", async (_request, reply) => sendSpaIndex(reply));
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "接口不存在" } });
    }
    if (config.nodeEnv === "production" && request.method === "GET" && isSpaPagePath(request.url)) {
      return sendSpaIndex(reply);
    }
    return reply.code(404).send({ ok: false, error: { code: "NOT_FOUND", message: "页面不存在" } });
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode === 400) {
      return reply.code(400).send({ ok: false, error: { code: "BAD_REQUEST", message: "请求格式不正确" } });
    }
    if (statusCode === 413) {
      return reply.code(413).send({ ok: false, error: { code: "FILE_TOO_LARGE", message: "文件超过 20MB 大小限制" } });
    }
    const message = error instanceof Error ? error.message : "未知错误";
    console.error(`请求失败：${request.method} ${request.url.split("?", 1)[0]} (${statusCode}) ${message}`);
    return reply.code(500).send({ ok: false, error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" } });
  });

  return app;
}

function createDatabaseIfPresent(config: AppConfig): DatabaseClient | undefined {
  try {
    return createDatabaseClient({
      databasePath: config.databasePath,
      readOnly: false,
      migrationsDirectory: path.resolve(process.cwd(), "server/src/db/migrations")
    });
  } catch (error) {
    if (config.nodeEnv === "production") throw error;
    appStartupWarning(error);
    return undefined;
  }
}

function appStartupWarning(error: unknown): void {
  const message = error instanceof Error ? error.message : "数据库初始化失败";
  console.warn(`SQLite 数据库未连接：${message}`);
}

function isSpaPagePath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  if (pathname.startsWith("/api/") || pathname.startsWith("/assets/") || /\/[^/]+\.[^/]+$/u.test(pathname)) return false;
  return true;
}

function sendSpaIndex(reply: import("fastify").FastifyReply): ReturnType<import("fastify").FastifyReply["sendFile"]> {
  return reply.header("Cache-Control", "no-store, max-age=0").sendFile("index.html");
}

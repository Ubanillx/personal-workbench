import type { FastifyInstance } from "fastify";
import { databaseHealth } from "../db/health";
import type { DatabaseClient } from "../db/client";
import type { AppConfig } from "../config/env";

export type HealthRouteOptions = {
  config: AppConfig;
  database?: DatabaseClient | undefined;
};

export async function registerHealthRoutes(app: FastifyInstance, options: HealthRouteOptions): Promise<void> {
  const payload = async () => ({
    name: "personal-workbench",
    status: "ok",
    version: "1.0.0",
    runtime: "node",
    database: await databaseHealth(options.database),
    timestamp: new Date().toISOString(),
  });

  app.get("/api/ping", async (_request, reply) => reply.send({ ok: true, data: await payload() }));
  app.get("/api/health", async (_request, reply) => reply.send({ ok: true, data: await payload() }));
}

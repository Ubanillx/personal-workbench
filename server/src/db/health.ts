import type { DatabaseClient } from "./client";

export async function databaseHealth(database: DatabaseClient | undefined): Promise<{
  status: "ready" | "unavailable" | "not_configured";
  driver?: string;
}> {
  if (!database) return { status: "not_configured" };
  try {
    const result = await database.healthCheck();
    return result.available ? { status: "ready", driver: result.driver } : { status: "unavailable", driver: result.driver };
  } catch {
    return { status: "unavailable" };
  }
}

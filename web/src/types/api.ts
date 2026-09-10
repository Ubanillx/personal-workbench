export type HealthStatus = {
  name: string;
  status: string;
  version: string;
  runtime: string;
  database: { status: string; driver?: string };
  timestamp: string;
};

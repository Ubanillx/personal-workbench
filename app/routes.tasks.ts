import type { RouteConfig } from "@react-router/dev/routes";

/**
 * 任务域端点（Phase 2 批次 B）：dashboard + tasks 全流程（19 个）。
 * 单独成文件是为了让并行的迁移批次各改各的，避免争抢 app/routes.ts。
 */
export const taskRoutes = [
  // route("api/dashboard", "routes/api.dashboard.ts"),
] satisfies RouteConfig;

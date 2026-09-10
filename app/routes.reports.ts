import type { RouteConfig } from "@react-router/dev/routes";

/**
 * 周报域端点（Phase 2 批次 D）：reports 7（含 multipart 上传与文件下载）。
 * 单独成文件是为了让并行的迁移批次各改各的，避免争抢 app/routes.ts。
 */
export const reportRoutes = [
  // route("api/reports", "routes/api.reports.ts"),
] satisfies RouteConfig;

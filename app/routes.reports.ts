import { type RouteConfig, route } from "@react-router/dev/routes";

/**
 * 周报域端点（Phase 2 批次 D）：reports 7（含 multipart 上传与文件下载）。
 * 单独成文件是为了让并行的迁移批次各改各的，避免争抢 app/routes.ts。
 *
 * 注意路径注册顺序无歧义：`:id` 只匹配三段，`/file` 与 `/file/:version` 分别是四段与五段。
 */
export const reportRoutes = [
  route("api/reports", "routes/api.reports.ts"),
  route("api/reports/:id", "routes/api.reports.$id.ts"),
  route("api/reports/:id/file", "routes/api.reports.$id.file.ts"),
  route("api/reports/:id/approve", "routes/api.reports.$id.approve.ts"),
  route("api/reports/:id/return", "routes/api.reports.$id.return.ts"),
  route("api/reports/:id/file/:version", "routes/api.reports.$id.file.$version.ts"),
] satisfies RouteConfig;

import { type RouteConfig, route } from "@react-router/dev/routes";

/**
 * 任务域端点（Phase 2 批次 B）：dashboard + tasks 全流程 + 评论/时间线 + 通知 + 验收视图。
 * 单独成文件是为了让并行的迁移批次各改各的，避免争抢 app/routes.ts。
 */
export const taskRoutes = [
  route("api/dashboard", "routes/api.dashboard.ts"),
  route("api/tasks", "routes/api.tasks.ts"),
  route("api/tasks/:id", "routes/api.tasks.$id.ts"),
  route("api/tasks/:id/progress", "routes/api.tasks.$id.progress.ts"),
  route("api/tasks/:id/submit-review", "routes/api.tasks.$id.submit-review.ts"),
  route("api/tasks/:id/approve", "routes/api.tasks.$id.approve.ts"),
  route("api/tasks/:id/return", "routes/api.tasks.$id.return.ts"),
  route("api/tasks/:id/archive", "routes/api.tasks.$id.archive.ts"),
  route("api/tasks/:id/restore", "routes/api.tasks.$id.restore.ts"),
  route("api/tasks/:id/comments", "routes/api.tasks.$id.comments.ts"),
  route("api/tasks/:id/activity", "routes/api.tasks.$id.activity.ts"),
  route("api/notifications", "routes/api.notifications.ts"),
  route("api/notifications/read", "routes/api.notifications.read.ts"),
  route("api/review", "routes/api.review.ts"),
] satisfies RouteConfig;

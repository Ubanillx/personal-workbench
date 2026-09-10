import type { RouteConfig } from "@react-router/dev/routes";

/**
 * 人员与个人域端点（Phase 2 批次 C）：users 4 + todos 4 + notes 4 + files 4 + inbox 2。
 * 单独成文件是为了让并行的迁移批次各改各的，避免争抢 app/routes.ts。
 */
export const peopleRoutes = [
  // route("api/users", "routes/api.users.ts"),
] satisfies RouteConfig;

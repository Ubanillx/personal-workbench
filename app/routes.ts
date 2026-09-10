import { type RouteConfig, index, route } from "@react-router/dev/routes";
import { peopleRoutes } from "./routes.people";
import { reportRoutes } from "./routes.reports";
import { taskRoutes } from "./routes.tasks";

/**
 * 资源路由（只有 loader/action、没有默认导出的组件）即 API 端点；
 * 带组件的路由即页面。Phase 3 逐页把 web/src 的 antd 页面搬进来，
 * 每搬完一页就把路径加入 app/root.tsx 的 MIGRATED_PATHS。
 */
export default [
  // 页面（Phase 3）
  index("routes/dashboard.tsx"),
  route("access", "routes/access.tsx"),
  route("logout", "routes/logout.ts"),

  // 健康检查
  route("api/ping", "routes/api.ping.ts"),
  route("api/health", "routes/api.health.ts"),

  // 认证与访问信息（Phase 2 · 批次 A，已完成）
  route("api/auth/access", "routes/api.auth.access.ts"),
  route("api/auth/logout", "routes/api.auth.logout.ts"),
  route("api/auth/me", "routes/api.auth.me.ts"),
  route("api/access-info", "routes/api.access-info.ts"),

  // 批次 B/C/D
  ...taskRoutes,
  ...peopleRoutes,
  ...reportRoutes,
] satisfies RouteConfig;

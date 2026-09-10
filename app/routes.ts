import { type RouteConfig, index, route } from "@react-router/dev/routes";
import { orgRoutes } from "./routes.orgs";
import { peopleRoutes } from "./routes.people";
import { reportRoutes } from "./routes.reports";
import { taskRoutes } from "./routes.tasks";

/**
 * 资源路由（只有 loader/action、没有默认导出的组件）即 API 端点；
 * 带组件的路由即页面。每新增页面都要把路径加入 app/root.tsx 的 MIGRATED_PATHS。
 */
export default [
  // 页面
  index("routes/dashboard.tsx"),
  route("login", "routes/login.tsx"),
  route("access", "routes/access-redirect.ts"),
  route("register", "routes/register.tsx"),
  route("password", "routes/password.tsx"),
  route("join", "routes/join.tsx"),
  route("organization", "routes/organization.tsx"),
  route("admin", "routes/admin.tsx"),
  route("logout", "routes/logout.ts"),
  route("tasks", "routes/tasks.tsx"),
  route("todos", "routes/todos.tsx"),
  route("notes", "routes/notes.tsx"),
  route("inbox", "routes/inbox.tsx"),
  route("reports", "routes/reports.tsx"),
  route("collaboration", "routes/collaboration.tsx"),
  route("files", "routes/files.tsx"),
  route("review", "routes/review.tsx"),

  // 健康检查
  route("api/ping", "routes/api.ping.ts"),
  route("api/health", "routes/api.health.ts"),

  // 认证（用户名 + 密码）与访问信息
  route("api/auth/login", "routes/api.auth.login.ts"),
  route("api/auth/register", "routes/api.auth.register.ts"),
  route("api/auth/password", "routes/api.auth.password.ts"),
  route("api/auth/logout", "routes/api.auth.logout.ts"),
  route("api/auth/me", "routes/api.auth.me.ts"),
  route("api/access-info", "routes/api.access-info.ts"),

  // 各域端点
  ...orgRoutes,
  ...taskRoutes,
  ...peopleRoutes,
  ...reportRoutes,
] satisfies RouteConfig;

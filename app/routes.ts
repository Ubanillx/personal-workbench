import { type RouteConfig, index, route } from "@react-router/dev/routes";

/**
 * 资源路由（只有 loader/action、没有默认导出的组件）即 API 端点。
 * Phase 2 按域分批把 48 个端点从 server/src/routes 搬过来，每批用
 * `npm run contract:compare -- --only <域名>` 验收。
 */
export default [
  index("routes/home.tsx"),

  // 健康检查
  route("api/ping", "routes/api.ping.ts"),
  route("api/health", "routes/api.health.ts"),

  // 认证与访问信息（Phase 2 · 批次 A）
  route("api/auth/access", "routes/api.auth.access.ts"),
  route("api/auth/logout", "routes/api.auth.logout.ts"),
  route("api/auth/me", "routes/api.auth.me.ts"),
  route("api/access-info", "routes/api.access-info.ts"),
] satisfies RouteConfig;

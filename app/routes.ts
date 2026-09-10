import { type RouteConfig, index, route } from "@react-router/dev/routes";

/**
 * Phase 1 只登记 health 探针；Phase 2 会把 48 个端点按域补齐。
 * 资源路由（只有 loader/action、没有默认导出的组件）即 API 端点。
 */
export default [
  index("routes/home.tsx"),
  route("api/ping", "routes/api.ping.ts"),
  route("api/health", "routes/api.health.ts"),
] satisfies RouteConfig;

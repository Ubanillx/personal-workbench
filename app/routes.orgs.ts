import type { RouteConfig } from "@react-router/dev/routes";
import { route } from "@react-router/dev/routes";

/**
 * 组织与成员域端点（账号密码 + 多组织改造 · C 阶段）：
 * organizations 6 + members 3 + join-requests 6 + leave-requests 1。
 * 单独成文件是为了不与其他域争抢 app/routes.ts。
 */
export const orgRoutes = [
  route("api/organizations", "routes/api.organizations.ts"),
  route("api/organizations/:id", "routes/api.organizations.$id.ts"),
  route("api/organizations/:id/archive", "routes/api.organizations.$id.archive.ts"),
  route("api/organizations/:id/restore", "routes/api.organizations.$id.restore.ts"),
  route("api/organizations/:id/members", "routes/api.organizations.$id.members.ts"),
  route("api/organizations/:id/invite", "routes/api.organizations.$id.invite.ts"),

  route("api/members", "routes/api.members.ts"),
  route("api/members/:id", "routes/api.members.$id.ts"),

  route("api/join-requests", "routes/api.join-requests.ts"),
  route("api/join-requests/:id", "routes/api.join-requests.$id.ts"),
  route("api/join-requests/:id/approve", "routes/api.join-requests.$id.approve.ts"),
  route("api/join-requests/:id/reject", "routes/api.join-requests.$id.reject.ts"),

  route("api/leave-requests", "routes/api.leave-requests.ts"),
] satisfies RouteConfig;

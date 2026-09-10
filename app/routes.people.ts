import type { RouteConfig } from "@react-router/dev/routes";
import { route } from "@react-router/dev/routes";

/**
 * 个人记录域端点（Phase 2 批次 C）：todos 4 + notes 4 + files 4 + inbox 2。
 * users/members 四条已随「多组织」改造移到 app/routes.orgs.ts。
 */
export const peopleRoutes = [
  route("api/todos", "routes/api.todos.ts"),
  route("api/todos/:id", "routes/api.todos.$id.ts"),

  route("api/notes", "routes/api.notes.ts"),
  route("api/notes/:id", "routes/api.notes.$id.ts"),

  route("api/files", "routes/api.files.ts"),
  route("api/files/:id", "routes/api.files.$id.ts"),
  route("api/files/:id/use", "routes/api.files.$id.use.ts"),

  route("api/inbox/preview", "routes/api.inbox.preview.ts"),
  route("api/inbox/import", "routes/api.inbox.import.ts"),
] satisfies RouteConfig;

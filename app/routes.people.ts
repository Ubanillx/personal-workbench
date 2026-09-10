import type { RouteConfig } from "@react-router/dev/routes";
import { route } from "@react-router/dev/routes";

/**
 * 人员与个人域端点（Phase 2 批次 C）：users 4 + todos 4 + notes 4 + files 4 + inbox 2。
 * 单独成文件是为了让并行的迁移批次各改各的，避免争抢 app/routes.ts。
 * inbox 两个端点依赖任务域辅助函数，待批次 B 抽出后补上。
 */
export const peopleRoutes = [
  route("api/users", "routes/api.users.ts"),
  route("api/users/:id", "routes/api.users.$id.ts"),
  route("api/users/:id/token", "routes/api.users.$id.token.ts"),

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

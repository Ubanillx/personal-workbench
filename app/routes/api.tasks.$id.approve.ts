import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireManager } from "../lib/session.server";
import { approveTask } from "../lib/task-service.server";

/**
 * POST /api/tasks/:id/approve —— 任务**发布人**验收（全局管理员兜底）。
 * 这里只判角色（`requireManager`），「是不是这条任务的发布人、是不是负责人」由服务层的
 * `canReviewTask()` 判定；逻辑在 app/lib/task-service.server.ts
 */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = approveTask(auth.user, String(params.id), String(body.note ?? "验收通过"));
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}

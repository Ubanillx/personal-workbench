import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireManager } from "../lib/session.server";
import { approveTask } from "../lib/task-service.server";

/**
 * POST /api/tasks/:id/approve —— 发布任务的组织管理者验收，管理员只作应急兜底。
 * 这里只判角色（`requireManager`），发布人与负责人关系由服务层的 `canReviewTask()` 判定；
 * 逻辑在 app/lib/task-service.server.ts
 */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = approveTask(auth.user, String(params.id), String(body.note ?? "验收通过"));
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}

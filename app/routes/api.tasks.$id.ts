import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";
import { canManageRole } from "../lib/task-permissions";
import { deleteTask, updateTask } from "../lib/task-service.server";

type Params = { request: Request; params: { id?: string } };

/**
 * PATCH /api/tasks/:id —— 改任务元信息：管理角色（admin / manager），或任务发布人本人
 * （普通成员只能改自己创建任务的标题 / 说明 / 优先级 / 截止日期，其余字段由服务端拒绝）。
 * DELETE /api/tasks/:id —— 彻底删除，仍只限管理员或组织管理者。
 *
 * 组织边界由 task-service 判定：跨组织返回 404，逻辑在 app/lib/task-service.server.ts。
 */
export async function action({ request, params }: Params): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = String(params.id);
  if (request.method === "DELETE") {
    if (!canManageRole(auth.user.role)) return fail("FORBIDDEN", "只有管理员或组织管理者可以执行此操作", 403);
    const removed = deleteTask(auth.user, id);
    return removed.ok ? ok(removed.data, removed.status) : fail(removed.code, removed.message, removed.status);
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = updateTask(auth.user, id, body);
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}

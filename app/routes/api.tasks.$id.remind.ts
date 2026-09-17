import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireManager } from "../lib/session.server";
import { remindOverdueTask } from "../lib/task-service.server";

/** POST /api/tasks/:id/remind —— 管理员 / 组织管理者手动提醒逾期任务负责人。 */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const result = remindOverdueTask(auth.user, String(params.id));
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}

import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";
import { readPersonalTask, savePersonalTask } from "../lib/task-dimensions.server";

type Params = { request: Request; params: { id?: string } };
export function loader({ request, params }: Params): Response {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const result = readPersonalTask(auth.user, String(params.id));
  return result.ok ? ok(result.data) : fail(result.code, result.message, result.status);
}
export async function action({ request, params }: Params): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  if (request.method !== "PATCH") return fail("METHOD_NOT_ALLOWED", "不支持该请求方法", 405);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("VALIDATION_ERROR", "请求需要 JSON 对象", 400);
  const result = savePersonalTask(auth.user, String(params.id), body);
  return result.ok ? ok(result.data) : fail(result.code, result.message, result.status);
}

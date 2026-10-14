import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";
import { listTaskDimensions, saveTaskDimension } from "../lib/task-dimensions.server";

export function loader({ request }: { request: Request }): Response {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  return auth.ok ? ok(listTaskDimensions(auth.user)) : auth.response;
}

export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  if (request.method !== "POST") return fail("METHOD_NOT_ALLOWED", "不支持该请求方法", 405);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("VALIDATION_ERROR", "请求需要 JSON 对象", 400);
  const result = saveTaskDimension(auth.user, null, body);
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}

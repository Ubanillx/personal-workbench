import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";
import { addComment, listComments } from "../lib/task-service.server";

type Params = { request: Request; params: { id?: string } };

/** GET /api/tasks/:id/comments —— 逻辑在 app/lib/task-service.server.ts */
export async function loader({ request, params }: Params): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const result = listComments(auth.user, String(params.id));
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}

/** POST /api/tasks/:id/comments —— 逻辑在 app/lib/task-service.server.ts */
export async function action({ request, params }: Params): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = addComment(auth.user, String(params.id), body);
  return result.ok ? ok(result.data, result.status) : fail(result.code, result.message, result.status);
}

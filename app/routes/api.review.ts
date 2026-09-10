import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { reviewData } from "../lib/review.server";
import { requireManager } from "../lib/session.server";

/** GET /api/review —— 逻辑在 app/lib/review.server.ts，与回顾统计页 loader 共用（管理员或组织管理者） */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const query = new URL(request.url).searchParams;
  return ok(
    reviewData(auth.user, { from: query.get("from"), to: query.get("to"), ownerId: query.get("ownerId"), status: query.get("status") }),
  );
}

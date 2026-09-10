import { accessInfoPayload } from "../lib/access.server";
import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";

/** GET /api/access-info —— 仅主人；逻辑在 app/lib/access.server.ts，与协作管理页共用 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  return ok(accessInfoPayload());
}

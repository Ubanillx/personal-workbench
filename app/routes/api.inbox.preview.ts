import { appConfig } from "../lib/context.server";
import { db, inboxFingerprint, one } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";

/** POST /api/inbox/preview —— 解析企微草稿并标记疑似重复（查看者 403） */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  if (auth.user.role === "viewer") return fail("FORBIDDEN", "查看者不能导入任务", 403);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const drafts = Array.isArray(body.drafts) ? (body.drafts as Record<string, unknown>[]) : [];
  const previews: Record<string, unknown>[] = [];
  for (const item of drafts.slice(0, 100)) {
    const title = String(item.title ?? "").trim();
    const fingerprint = inboxFingerprint(item, title);
    // 草稿字段不固定：必须原样保留客户端提交的其它字段，因此这里刻意展开
    previews.push({
      ...item,
      title,
      fingerprint,
      duplicate: Boolean(title && one(db(), "SELECT id FROM tasks WHERE wecom_fingerprint=?", fingerprint)),
    });
  }
  return ok(previews);
}

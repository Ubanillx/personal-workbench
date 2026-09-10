import { appConfig } from "../lib/context.server";
import { db, inboxFingerprint, one } from "../lib/db.server";
import { ok } from "../lib/http.server";
import { requireAuth } from "../lib/session.server";

/**
 * POST /api/inbox/preview —— 解析企微草稿并标记疑似重复。
 * 三种角色都能用（§4：member 限自己，导出的负责人候选由页面按角色收窄），因此不再有 viewer 的 403。
 *
 * 重复判定按**目标组织**做，与导入同一口径：指纹算法一个字没改（仍然只由 sender/标题/时间算出），
 * 但只看本组织已导入的任务，避免把别的组织导入过的同一条消息误判成重复、也不跨组织泄露信息。
 * 目标组织：成员/管理者是自己的组织，管理员要在请求里带 `orgId`；解析不出目标组织时不报重复。
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const orgId = user.role === "admin" ? String(body.orgId ?? "").trim() : (user.orgId ?? "");
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
      duplicate: Boolean(title && orgId && one(db(), "SELECT id FROM tasks WHERE wecom_fingerprint=? AND org_id=?", fingerprint, orgId)),
    });
  }
  return ok(previews);
}

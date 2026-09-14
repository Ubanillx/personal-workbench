import { appConfig } from "../lib/context.server";
import { deleteFileRecord, updateFileRecord } from "../lib/files.server";
import { ok } from "../lib/http.server";
import { failureResponse } from "../lib/records.server";
import { requireAuth } from "../lib/session.server";

/**
 * PATCH /api/files/:id —— 编辑索引（名称 / 路径 / 分类）：**组织内所有人都可以**（D-54）。
 * DELETE /api/files/:id —— **只有组织管理者与全局管理员**（D-54）。
 *
 * 门槛分两层且顺序固定：先由域服务 `locateFile` 过组织边界（不存在与跨组织一律 404），
 * 再由 `deleteFileRecord` 判角色（普通成员 403「只有组织管理者或管理员可以删除重要文件」）。
 * 403 与 404 刻意不同：跨组织连「这条索引存不存在」都不该知道，而本组织成员知道它存在。
 */
export async function action({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const id = String(params.id);

  if (request.method === "DELETE") {
    const removed = deleteFileRecord(auth.user, id);
    if (!removed.ok) return failureResponse(removed);
    return ok(null);
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const updated = updateFileRecord(auth.user, id, {
    name: body.name,
    filePath: body.filePath,
    category: body.category,
    // 可见范围（D-55）：不带就保持原值——改名的请求不该顺手改掉可见范围
    visibility: body.visibility,
  });
  if (!updated.ok) return failureResponse(updated);
  return ok(updated.data);
}

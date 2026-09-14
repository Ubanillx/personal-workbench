import { WebDavError } from "../../server/src/webdav/client";
import { appConfig } from "../lib/context.server";
import { fail, withSecurityHeaders } from "../lib/http.server";
import { locateFile } from "../lib/records.server";
import { requireAuth } from "../lib/session.server";
import { isWebDavPath, toRemotePath, webDavClient, webDavErrorMessage } from "../lib/webdav.server";

/**
 * GET /api/files/:id/download —— 下载一条重要文件索引指向的**远端**文件（D-49）。
 *
 * 边界与文件库完全一致（见 docs/harness/WEBDAV.md）：
 * 1. **权限**：组织内所有人都可以下载（D-54；只有删除限组织管理者与管理员），这里用 `requireAuth`；
 * 2. **组织隔离**：先 `locateFile` 过索引的组织边界，跨组织 / 不存在一律 404；
 * 3. **流式代理**：浏览器 → 本服务 → NAS（`client.open`，GET 流式读），NAS 凭据不出服务器；
 *    本机路径的索引**没有下载**——服务端只能看到路径字符串，不可能读到用户本机的磁盘（400）。
 *
 * 响应体是二进制，必须用 `withSecurityHeaders` 补上 CSP / nosniff（与周报下载同一口径）。
 * 刻意不在 GET 上记「最近使用」：下载成功与否要等远端返回，副作用写库会让端点变得不纯。
 */
export async function loader({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;

  const located = locateFile(auth.user, String(params.id));
  // 不存在 / 跨组织 → 404；别人的个人文件 → 403（`locateFile` 已经把这两种失败分开）
  if (!located.view) return located.deny ?? fail("NOT_FOUND", "未找到该文件索引", 404);
  const filePath = String(located.view.filePath ?? "");
  if (!isWebDavPath(filePath)) return fail("NOT_REMOTE", "这条索引指向本机路径，只能复制、不能下载", 400);

  const client = webDavClient(auth.user.id);
  if (!client) return fail("WEBDAV_DISABLED", "未配置 WebDAV：请到「设置 → WebDAV」填写地址与账号", 503);

  const remotePath = toRemotePath(filePath);
  let opened: Awaited<ReturnType<typeof client.open>>;
  try {
    opened = await client.open(remotePath);
  } catch (error) {
    // 与 /api/webdav 的 remoteFail 同一口径：路径不合法 400，其余（连不上 / 认证失败 / 远端 5xx）502
    const status = error instanceof WebDavError && error.status === 400 ? 400 : 502;
    return fail("WEBDAV_ERROR", webDavErrorMessage(error), status);
  }
  if (!opened?.body) return fail("NOT_FOUND", "远端文件已不存在（可能已被移动或删除）", 404);

  // 下载文件名用**远端真实文件名**（路径最后一段），不用索引里的展示名称——后者可能不含扩展名
  const filename = remotePath.split("/").filter(Boolean).at(-1) ?? "download";
  const headers: Record<string, string> = {
    "content-type": opened.contentType ?? "application/octet-stream",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  };
  // content-length 只在远端明确给出时带上（分块传输时留空，让运行时自己决定）
  const size = opened.size ?? null;
  if (typeof size === "number" && Number.isFinite(size) && size >= 0) headers["content-length"] = String(size);

  return withSecurityHeaders(new Response(opened.body, { status: 200, headers }));
}

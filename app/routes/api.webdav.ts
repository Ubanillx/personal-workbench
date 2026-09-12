import { WebDavError } from "../../server/src/webdav/client";
import { appConfig } from "../lib/context.server";
import type { User } from "../lib/db.server";
import { createFileRecord } from "../lib/files.server";
import { fail, ok } from "../lib/http.server";
import { requireManager } from "../lib/session.server";
import { browseRemote, joinRemotePath, safeFileName, webDavClient, webDavErrorMessage, webDavStatus } from "../lib/webdav.server";

/**
 * /api/webdav —— 「重要文件」的 WebDAV 网关，与 /files 页面的选择器共用 app/lib/webdav.server.ts。
 *
 *   GET  ?path=<相对目录>                                       → 列目录（条目自带可直接入库的 filePath）
 *   POST multipart（dir + file + 可选 register/category/orgId） → 上传到远端，可选同时登记索引
 *
 * 权限与文件库一致：只有管理员与组织管理者（§4），角色不够是 403、未配置是 503。
 * **刻意不提供远端删除**：误删不可恢复，删文件请用 NAS 自己的界面（见 docs/harness/WEBDAV.md）。
 */

/** 单次上传上限：multipart 会被整体读进内存，太大了不利于本机服务稳定 */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function disabled(): Response {
  return fail("WEBDAV_DISABLED", "未配置 WebDAV：请到「设置 → WebDAV」填写地址与账号", 503);
}

/** 远端错误 → 响应：调用方路径不合法是 400，其余（连不上 / 认证失败 / 远端 5xx）是 502 */
function remoteFail(error: unknown): Response {
  const status = error instanceof WebDavError && error.status === 400 ? 400 : 502;
  return fail("WEBDAV_ERROR", webDavErrorMessage(error), status);
}

export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const status = webDavStatus(auth.user.id);
  if (!status.enabled) return disabled();
  try {
    const result = await browseRemote(auth.user.id, new URL(request.url).searchParams.get("path") ?? "");
    return ok({ ...result, root: status.root });
  } catch (error) {
    return remoteFail(error);
  }
}

export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireManager(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const client = webDavClient(auth.user.id);
  if (!client) return disabled();

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) return fail("BAD_REQUEST", "上传必须使用 multipart/form-data", 400);
  try {
    return await upload(client, auth.user, request);
  } catch (error) {
    return remoteFail(error);
  }
}

type UploadClient = NonNullable<ReturnType<typeof webDavClient>>;

/** 上传：远端 PUT，可选「同时登记到重要文件索引」（走 files.server 的同一份写入逻辑） */
async function upload(client: UploadClient, user: User, request: Request): Promise<Response> {
  const form = await request.formData();
  const directory = String(form.get("dir") ?? "");
  const file = [...form.values()].find((value): value is File => typeof value !== "string");
  if (!file) return fail("BAD_REQUEST", "缺少上传文件", 400);
  if (file.size > MAX_UPLOAD_BYTES) return fail("FILE_TOO_LARGE", "文件超过 100MB 大小限制", 413);

  const remotePath = joinRemotePath(directory, safeFileName(file.name));
  await client.upload(remotePath, file, file.type || undefined);

  const register = String(form.get("register") ?? "") === "1";
  if (!register) return ok({ path: remotePath, size: file.size, registered: false }, 201);

  const created = createFileRecord(user, {
    name: String(form.get("name") ?? "").trim() || safeFileName(file.name),
    filePath: `webdav:${remotePath}`,
    category: String(form.get("category") ?? ""),
    orgId: form.get("orgId") ?? undefined,
  });
  if (!created.ok) {
    // 文件已经传上去了，只是索引没登记：把两件事分开告诉用户，避免误以为白传了
    return fail("WEBDAV_INDEX_FAILED", `文件已上传到「${remotePath}」，但登记索引失败：${created.message}`, created.status);
  }
  return ok({ path: remotePath, size: file.size, registered: true, file: created.data }, 201);
}

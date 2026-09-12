import { WEBDAV_PATH_PREFIX, type WebDavBrowseEntry, type WebDavBrowseListing, type WebDavFileStatus } from "../../shared/types/domain";
import { createWebDavClient, WebDavError, type WebDavClient, type WebDavEntry as RemoteEntry } from "../../server/src/webdav/client";
import { resolveReportUploadConfig, resolveWebDavConfig, type WebDavSettings } from "./webdav-settings.server";

/**
 * 「重要文件」的 WebDAV 接入层（页面 loader / 资源路由共用）。
 *
 * 设计要点（见 docs/harness/WEBDAV.md）：
 * 1. **可选接入**：本账号在设置页里没登记过就是没接入，所有入口返回 `enabled: false` / 503，
 *    页面优雅降级；
 * 2. **地址部署级 + 凭据按账号**：地址来自环境变量 `WEBDAV_URL`（全员共用一个 NAS），
 *    用户名 / 密码 / 浏览根 / 超时按账号存 `webdav_settings`——见 `webdav-settings.server.ts`；
 * 3. **索引不迁移**：`important_files` 表结构与 `/api/files` 载荷都不动。远程文件用
 *    `webdav:<相对路径>` 这种带协议前缀的值存进原来的 `file_path` 列，本机路径照旧；
 * 4. **凭据不外泄**：对外只暴露可浏览根、相对路径与远端元信息，账号密码永远不出服务端；
 * 5. **边界**：组织隔离仍由 `important_files.org_id`（索引）负责。地址既然是全员共用的，
 *    `webdav:` 索引对所有人指向同一个远端，只有各人的**权限范围**可能不同（NAS 账号决定），
 *    所以换人查看不会再出现「索引指向另一个 NAS」的问题。
 */

/** 状态探测的超时上限：页面加载不能被远端拖住，用比上传更短的超时 */
const PROBE_TIMEOUT_MS = 4_000;
/** 一次页面加载最多探测多少条索引的远端状态 */
const PROBE_LIMIT = 10;

export type WebDavStatus = {
  enabled: boolean;
  /** 可浏览根（相对 WebDAV 服务根） */
  root: string;
  /** 给页面看的目标地址（不含账号密码）；未接入为 null */
  url: string | null;
  /** 一次状态探测最多检查多少条索引 */
  probeLimit: number;
  /** 账号里是否保存过配置（等价于 enabled，单独给出便于页面判断） */
  configured: boolean;
};

export function isWebDavPath(filePath: string): boolean {
  return filePath.startsWith(WEBDAV_PATH_PREFIX);
}

/** `webdav:a/b.txt` → `a/b.txt`（非 WebDAV 路径原样返回，调用方需先用 isWebDavPath 判定） */
export function toRemotePath(filePath: string): string {
  return isWebDavPath(filePath) ? filePath.slice(WEBDAV_PATH_PREFIX.length) : filePath;
}

export function toWebDavFilePath(remotePath: string): string {
  return `${WEBDAV_PATH_PREFIX}${remotePath.replace(/^\/+/u, "")}`;
}

/** 当前账号的接入状态（页面据此决定是否显示 WebDAV 入口） */
export function webDavStatus(userId: string): WebDavStatus {
  const config = resolveWebDavConfig(userId);
  return {
    enabled: config.enabled,
    root: config.root,
    url: config.enabled ? config.url : null,
    probeLimit: PROBE_LIMIT,
    configured: config.enabled,
  };
}

/**
 * 客户端缓存：按「生效配置 + 超时」做键。
 * 配置现在可以在网页上随时改，所以不能再用「单例」——改了配置换个键自然重建；
 * 键里带上密码，保证改密码后不会拿旧客户端继续发请求。上限兜住多账号场景。
 */
const CLIENT_CACHE_LIMIT = 16;
const clientCache = new Map<string, WebDavClient>();

function clientFor(config: WebDavSettings, timeoutMs: number): WebDavClient {
  const key = [config.url, config.username, config.password, config.root, String(timeoutMs)].join("\n");
  const cached = clientCache.get(key);
  if (cached) return cached;
  const client = createWebDavClient({
    baseUrl: config.url,
    username: config.username,
    password: config.password,
    basePath: config.root,
    timeoutMs,
  });
  if (clientCache.size >= CLIENT_CACHE_LIMIT) clientCache.clear();
  clientCache.set(key, client);
  return client;
}

/** 未接入时返回 null（调用方据此给 503 / 隐藏入口），不抛异常 */
export function webDavClient(userId: string): WebDavClient | null {
  const config = resolveWebDavConfig(userId);
  if (!config.enabled) return null;
  return clientFor(config, config.timeoutMs);
}

/** 状态探测专用的短超时客户端 */
function webDavProbeClient(userId: string): WebDavClient | null {
  const config = resolveWebDavConfig(userId);
  if (!config.enabled) return null;
  return clientFor(config, Math.min(config.timeoutMs, PROBE_TIMEOUT_MS));
}

/* ------------------------------------------------------------------ 周报上传（统一账号，D-46） */

/**
 * 周报存储专用的 WebDAV 客户端（**统一账号**，见 docs/harness/REPORTS_WEBDAV.md）。
 *
 * 与上面「重要文件」那份客户端的两点区别：
 * 1. 配置来自**全局单行** `report_upload_settings`，不是按账号——谁交周报都写同一个远端目录；
 * 2. `basePath` 固定成服务根 `/`：库里存的是**含上传根目录的完整路径**
 *    （`webdav:/周报/zhangsan/2026-09-01_2026-09-07/第八周周报.docx`），
 *    这样管理员日后改了「上传根目录」，老周报照样能下载（代价是新旧文件分处两个目录）。
 *
 * 未配置（地址没配好 **或** 单行配置不存在）返回 null，调用方据此给 503。
 */
export function reportUploadClient(): WebDavClient | null {
  const config = resolveReportUploadConfig();
  if (!config.enabled) return null;
  return clientFor({ ...config, root: "/" }, config.timeoutMs);
}

/**
 * 连通性 + 认证探针：拿一份**尚未保存**的配置直接 ping（设置页「测试连接」用）。
 * 不复用缓存、不落库；错误交给调用方用 `webDavErrorMessage` 翻译。
 */
export async function pingWebDav(config: WebDavSettings): Promise<void> {
  // 这里是用户主动点的「测试连接」，用配置里的完整超时，不套页面加载的短上限
  await createWebDavClient({
    baseUrl: config.url,
    username: config.username,
    password: config.password,
    basePath: config.root,
    timeoutMs: config.timeoutMs,
  }).ping();
}

/** 把远端异常翻译成给人看的一句话（不泄露响应体、不泄露账号密码） */
export function webDavErrorMessage(error: unknown): string {
  if (error instanceof WebDavError) {
    if (error.unreachable) return `${error.message}（请检查设置页里的 WebDAV 地址与网络，或调大超时）`;
    if (error.status === 401 || error.status === 403) return `${error.message}（请检查设置页里的用户名与密码）`;
    if (error.status === 404) return "远端路径不存在（可能已被移动或删除）";
    return error.message;
  }
  return error instanceof Error ? error.message : "WebDAV 操作失败";
}

/* ------------------------------------------------------------------ 路径工具 */

/** `a/b/c.txt` → `a/b`；根目录返回 "" */
export function parentPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.slice(0, -1).join("/");
}

/** 拼接目录与名字，并去掉名字里的路径成分（上传时防止用户构造出越界路径） */
export function joinRemotePath(directory: string, name: string): string {
  const cleanName = safeFileName(name);
  const cleanDirectory = directory
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
  return cleanDirectory ? `${cleanDirectory}/${cleanName}` : cleanName;
}

/** 只取最后一段并去掉非法字符：`../x/y.txt` → `y.txt` */
export function safeFileName(name: string): string {
  const base = name.split(/[/\\]/u).at(-1)?.trim() ?? "";
  const cleaned = base.replace(/[\0?#]/gu, "").replace(/^\.+$/u, "");
  if (!cleaned) throw new WebDavError("文件名不合法", 400);
  return cleaned;
}

/* ------------------------------------------------------------------ 远端状态 */

export type RemoteProbeResult = {
  /** 远端连通且认证通过（false 时状态列显示「未检查」，页面给一条提示） */
  reachable: boolean;
  /** 不可达的原因（已翻译成人话） */
  message: string | null;
  /** 键为**相对路径**；值为 null 表示该文件在远端不存在 */
  statuses: Map<string, WebDavFileStatus>;
};

/**
 * 批量探测远端文件状态：只取前 `probeLimit` 条**去重后**的远程路径。
 * 先做一次根探针，把「整个远端连不上」（→ 未检查）与「单个文件 404」（→ 不存在）区分开；
 * 探测失败一律不抛异常，本机索引与页面其余部分照常展示。
 */
export async function remoteStatuses(userId: string, remotePaths: string[]): Promise<RemoteProbeResult> {
  const client = webDavProbeClient(userId);
  if (!client) return { reachable: false, message: "未配置 WebDAV", statuses: new Map() };
  try {
    await client.ping();
  } catch (error) {
    return { reachable: false, message: webDavErrorMessage(error), statuses: new Map() };
  }
  const stats = await client.statMany([...new Set(remotePaths)].slice(0, PROBE_LIMIT));
  const statuses = new Map<string, WebDavFileStatus>();
  for (const [path, entry] of stats) {
    statuses.set(
      path,
      entry ? { exists: true, size: entry.size, lastModified: entry.lastModified } : { exists: false, size: null, lastModified: null },
    );
  }
  return { reachable: true, message: null, statuses };
}

/* ------------------------------------------------------------------ 浏览 */

/** 列目录结果的统一整形：`/api/webdav`、`/files` 页面与设置页的目录选择器共用同一份 */
async function listAsBrowseResult(client: WebDavClient, path: string): Promise<WebDavBrowseListing> {
  const normalized = client.normalizePath(path);
  const entries = await client.list(normalized);
  return {
    path: normalized,
    parent: normalized ? parentPath(normalized) : null,
    entries: entries.map((entry: RemoteEntry): WebDavBrowseEntry => ({
      path: entry.path,
      name: entry.name,
      isDirectory: entry.isDirectory,
      size: entry.size,
      lastModified: entry.lastModified,
      contentType: entry.contentType,
      filePath: toWebDavFilePath(entry.path),
    })),
  };
}

/** 浏览一个远端目录（用当前账号**已保存**的配置）；未接入抛 WebDavError(503)，由调用方转成响应 */
export async function browseRemote(userId: string, path: string): Promise<WebDavBrowseListing> {
  const client = webDavClient(userId);
  if (!client) throw new WebDavError("未配置 WebDAV", 503);
  return listAsBrowseResult(client, path);
}

/**
 * 用一份**显式配置**列目录——设置页的「目录选择器」专用：那里凭据往往还没保存，
 * 只能拿表单当前值去连（配置由 `resolveWebDavTestConfig` 组出来）。
 *
 * `basePath` 固定成 "/"：用户是要**挑**一个浏览根，必须能一路往上走到服务根；
 * 若沿用配置里已有的 root 当 basePath，就永远跳不出当前目录、也就换不了根。
 */
export async function browseWithConfig(config: WebDavSettings, path: string): Promise<WebDavBrowseListing> {
  const client = createWebDavClient({
    baseUrl: config.url,
    username: config.username,
    password: config.password,
    basePath: "/",
    timeoutMs: config.timeoutMs,
  });
  return listAsBrowseResult(client, path);
}

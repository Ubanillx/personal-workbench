import { WEBDAV_PATH_PREFIX } from "../../shared/types/domain";
import { WebDavError, type WebDavClient } from "../../server/src/webdav/client";
import { reportUploadClient, webDavErrorMessage } from "./webdav.server";
import { resolveReportUploadConfig } from "./webdav-settings.server";

/**
 * 周报正文的**远端存储层**（D-46，完整设计见 docs/harness/REPORTS_WEBDAV.md）。
 *
 * 一句话规则：正文只写 NAS，落点为
 *
 *   <上传根目录>/<登录用户名>/<period_start>_<period_end>/<原文件名>
 *
 * 本模块只做三件事，别的都不管（组织隔离、审批状态机留在 `reports.server.ts`）：
 * 1. **命名**：把「用户名 + 周期 + 原文件名」拼成远端路径，并做路径段清洗；
 * 2. **写入**：撞名时按后缀递增（`_2` / `_v2`），**绝不覆盖**远端已有文件；
 * 3. **读出**：给下载路由开一个流，不把整份文件读进内存。
 *
 * 为什么路径里存的是**含上传根目录的完整路径**（`webdav:/周报/…`）而不是「相对上传根」：
 * 管理员日后改了「上传根目录」，老周报仍然指向它当年所在的目录、照样能下载；
 * 代价是新旧文件会分处两个目录（见设计文档 §11.3）。
 */

/** 未配置时统一给出的提示：读者是普通成员，不能把他们指去一个进不去的设置页 */
export const REPORT_STORAGE_DISABLED_MESSAGE = "周报存储未配置：请联系管理员在「设置 → WebDAV」里配置周报上传";

/** 撞名时最多试探多少个后缀（`_2` … `_21`），超出就报错而不是无限试下去 */
const MAX_NAME_ATTEMPTS = 20;

/** 单个路径段（用户名 / 周期 / 文件名主体）的长度上限 */
const MAX_SEGMENT_LENGTH = 120;

/** 存储层可直接映射成 HTTP 响应的异常（`code` / `status` 与其它域的信封一致） */
export class ReportStorageError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ReportStorageError";
  }
}

/* ------------------------------------------------------------------ 路径与命名 */

// 文件名来自外部上传，必须剔除控制字符与路径分隔符，因此这里刻意匹配控制字符
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f/\\]/gu;

/**
 * 单段清洗：**剔除**控制字符与路径分隔符（与 `reports.server.ts` 的 `sanitizeName` 同一口径）
 * → 去掉首尾空白与前导/尾随点 → 截断 → 空串兜底 "unnamed"。
 */
export function safeSegment(raw: string): string {
  const cleaned = String(raw ?? "")
    .replace(CONTROL_CHARS, "")
    .trim()
    .replace(/^\.+/u, "")
    .replace(/\.+$/u, "")
    .trim();
  if (!cleaned) return "unnamed";
  return cleaned.length > MAX_SEGMENT_LENGTH ? cleaned.slice(0, MAX_SEGMENT_LENGTH) : cleaned;
}

/** `第八周周报.docx` → `{ stem: "第八周周报", ext: ".docx" }`；没有扩展名时 ext 为空串 */
export function splitDocName(originalName: string): { stem: string; ext: string } {
  const base = String(originalName ?? "")
    .split(/[/\\]/u)
    .at(-1)
    ?.trim();
  const safeBase = base && base.length > 0 ? base : "unnamed";
  const dot = safeBase.lastIndexOf(".");
  const ext = dot > 0 ? safeBase.slice(dot).toLowerCase() : "";
  const stemRaw = dot > 0 ? safeBase.slice(0, dot) : safeBase;
  const stem = safeSegment(stemRaw);
  const keep = Math.max(MAX_SEGMENT_LENGTH - ext.length, 1);
  return { stem: stem.length > keep ? stem.slice(0, keep) : stem, ext };
}

export type ReportPeriod = { username: string; periodStart: string; periodEnd: string };

/**
 * 远端目录：`<上传根目录>/<用户名>/<起止日期>`。
 * `root` 传 `resolveReportUploadConfig().root`（形如 `/周报`），会去掉尾斜杠后参与拼接。
 */
export function remoteDirectoryFor(root: string, period: ReportPeriod): string {
  const base = String(root ?? "")
    .trim()
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "");
  const segments = [base, safeSegment(period.username), `${safeSegment(period.periodStart)}_${safeSegment(period.periodEnd)}`].filter(
    (segment) => segment.length > 0,
  );
  return `/${segments.join("/")}`;
}

/**
 * 第 `attempt` 个候选文件名（attempt 从 0 起）：
 *
 * | 场景                | attempt 0        | 1           | 2           |
 * | ------------------- | ---------------- | ----------- | ----------- |
 * | 新建（version = 1） | `周报.xlsx`      | `周报_2.xlsx` | `周报_3.xlsx` |
 * | 重传（version ≥ 2） | `周报_v2.xlsx`   | `周报_v2_2.xlsx` | `周报_v2_3.xlsx` |
 *
 * 库里的 `report_files.version` 才是权威，文件名后缀只是给人看的（可能出现 `_v2_2`）。
 */
export function candidateFileName(originalName: string, version: number, attempt: number): string {
  const { stem, ext } = splitDocName(originalName);
  const suffix = version > 1 ? `_v${version}` : "";
  const tail = attempt > 0 ? `_${attempt + 1}` : "";
  return `${stem}${suffix}${tail}${ext}`;
}

/* ------------------------------------------------------------------ stored_name 值域 */

/** `report_files.stored_name` 是不是「远端路径」（旧式本地文件名没有前缀） */
export function isRemoteStoredName(storedName: string): boolean {
  return storedName.startsWith(WEBDAV_PATH_PREFIX);
}

/** `/周报/张三/2026-09-01_2026-09-07/周报.docx` → `webdav:/周报/…`（复用 important_files 的前缀约定） */
export function toRemoteStoredName(remotePath: string): string {
  const normalized = `/${String(remotePath ?? "")
    .trim()
    .replace(/^\/+/u, "")}`;
  return `${WEBDAV_PATH_PREFIX}${normalized}`;
}

/** `webdav:/周报/…` → `/周报/…`；调用方需先用 `isRemoteStoredName` 判定 */
export function remotePathOf(storedName: string): string {
  return isRemoteStoredName(storedName) ? storedName.slice(WEBDAV_PATH_PREFIX.length) : storedName;
}

/* ------------------------------------------------------------------ 写入 */

export type ReportUploadInput = ReportPeriod & {
  /** 用户上传时的原始文件名（只取最后一段，并做清洗） */
  originalName: string;
  /** 该文件在 `report_files` 里的版本号（决定 `_v{n}` 后缀） */
  version: number;
  buffer: Buffer;
  contentType?: string | null;
};

export type ReportUploadResult = {
  /** 可直接写进 `report_files.stored_name` 的值 */
  storedName: string;
  /** 远端绝对路径（相对 WebDAV 服务根），用于日志与 CLI 输出 */
  remotePath: string;
  size: number;
};

function storageClient(): WebDavClient {
  const client = reportUploadClient();
  if (!client) throw new ReportStorageError(REPORT_STORAGE_DISABLED_MESSAGE, "WEBDAV_DISABLED", 503);
  return client;
}

/**
 * 上传一份周报正文。
 *
 * 撞名策略（**绝不覆盖远端已有文件**）：先 `stat` 探一次，再用带 `If-None-Match: *` 的 PUT 写；
 * 目标名已存在就换下一个后缀（`_2` / `_v2_2` …）重试，20 次仍撞名则报 409。
 * 先探一次的理由是：万一某个服务端忽略条件头，这一步也能把「静默覆盖」挡在门外。
 */
export async function uploadReportFile(input: ReportUploadInput): Promise<ReportUploadResult> {
  const client = storageClient();
  const root = resolveReportUploadConfig().root;
  const directory = remoteDirectoryFor(root, input);
  const contentType = input.contentType ?? undefined;
  const blob = new Blob([new Uint8Array(input.buffer)]);
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const remotePath = `${directory}/${candidateFileName(input.originalName, input.version, attempt)}`;
    if (await client.stat(remotePath)) continue;
    const created = await client.uploadIfAbsent(remotePath, blob, contentType);
    if (created) return { storedName: toRemoteStoredName(remotePath), remotePath, size: input.buffer.byteLength };
  }
  throw new ReportStorageError("远端已存在同名文件，请改名或换一个周期再提交", "CONFLICT", 409);
}

/* ------------------------------------------------------------------ 读出 */

export type ReportDownloadStream = {
  /** 远端响应体（只读流），调用方负责消费或取消 */
  body: ReadableStream<Uint8Array>;
  contentType: string | null;
  /** 服务器给出的字节数；拿不到时为 null（此时不带 content-length 响应头） */
  size: number | null;
};

/**
 * 打开一份周报正文用于下载。返回 `null` 表示**远端确实没有这个文件**（404），
 * 调用方据此给「文件已丢失」；NAS 连不上等异常照旧抛出。
 */
export async function openReportDownload(storedName: string): Promise<ReportDownloadStream | null> {
  const client = storageClient();
  const opened = await client.open(remotePathOf(storedName));
  if (!opened?.body) return null;
  return { body: opened.body, contentType: opened.contentType, size: opened.size };
}

/* ------------------------------------------------------------------ 错误翻译 */

/**
 * 把存储层异常翻成给人看的一句话（不泄露响应体、不泄露账号密码）。
 * 周报的读者是普通成员，所以文案里统一指向「找管理员」，而不是让他们去改设置。
 */
export function reportStorageMessage(error: unknown): string {
  if (error instanceof ReportStorageError) return error.message;
  if (error instanceof WebDavError) {
    if (error.unreachable) return `${webDavErrorMessage(error)}（周报上传/下载暂时不可用，请稍后重试）`;
    if (error.status === 401 || error.status === 403) {
      return "周报上传账号认证失败或权限不足（请联系管理员检查「设置 → WebDAV」里的周报上传账号）";
    }
    if (error.status === 404) return "远端文件已不存在（可能被人移动或删除）";
    return webDavErrorMessage(error);
  }
  return error instanceof Error ? error.message : "周报存储操作失败";
}

/** 存储层异常对应的 HTTP 状态码：只有我们自己抛的错带明确状态，其余按 502（远端问题）处理 */
export function reportStorageStatus(error: unknown): number {
  if (error instanceof ReportStorageError) return error.status;
  return 502;
}

/** 存储层异常的响应错误码 */
export function reportStorageCode(error: unknown): string {
  if (error instanceof ReportStorageError) return error.code;
  if (error instanceof WebDavError && error.status === 404) return "NOT_FOUND";
  return "WEBDAV_ERROR";
}

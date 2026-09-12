/**
 * 极简 WebDAV 客户端（只用 Node 内置 fetch，不引第三方依赖）。
 *
 * 实现的六件事：
 *   PROPFIND Depth:1  → list()           列目录
 *   PROPFIND Depth:0  → stat()           取单条元信息（不存在返回 null）/ ping() 连通性探针
 *   PUT               → upload()         上传（同名覆盖，父目录用 MKCOL 自动补建）
 *   PUT + 条件头      → uploadIfAbsent() 上传且**不允许覆盖**（远端已存在回 412）
 *   GET               → open()           打开只读流（周报正文下载用）
 *   （私有）MKCOL     → 上传前补建父目录
 *
 * **刻意不做**远端删除：删远端文件不可恢复（用 NAS 自己的界面更稳妥）。
 *
 * 三条硬约束：
 * 1. **路径不能越过 basePath**：外部传入的路径一律拆成段处理，拒绝 `..`/`.`/空段/绝对 URL/反斜杠，
 *    再逐段 `encodeURIComponent`；服务器返回的 href 先按 basePath 前缀比对，对不上的一律丢弃；
 * 2. 认证只用 Basic（WebDAV 的事实标准），401/403 统一映射成 `WebDavError`，不把响应体带到页面；
 * 3. 所有请求带超时；网络层失败标记为 `status = 0`（`unreachable`），与「服务器返回了错误码」区分开。
 *
 * XML 刻意手写解析：PROPFIND 只用到 href / resourcetype / getcontentlength / getlastmodified /
 * getcontenttype 五个标签，为它引 XML 库不划算。解析器不关心命名空间前缀（`d:`/`D:`/`lp1:` 都认），
 * 并跳过 404 的 propstat 块（Depth:0 查不存在的路径时会出现）。
 */

export type WebDavEntry = {
  /** 相对 basePath 的路径，形如 `报价/2026报价单.xlsx`；basePath 根自身为 "" */
  path: string;
  /** 最后一段名字（根为 "/"） */
  name: string;
  isDirectory: boolean;
  size: number | null;
  /** ISO 时间串；解析不出来时为 null */
  lastModified: string | null;
  contentType: string | null;
};

/** `open()` 的返回值：一个还没读完的远端响应 */
export type WebDavDownload = {
  /** 响应体流；拿不到（如 204）时为 null */
  body: ReadableStream<Uint8Array> | null;
  contentType: string | null;
  /** 服务器给的 content-length；缺失（分块传输）时为 null */
  size: number | null;
};

export class WebDavError extends Error {
  public constructor(
    message: string,
    /** 远端 HTTP 状态码；网络层失败（超时 / 连不上 / DNS）为 0 */
    public readonly status: number,
  ) {
    super(message);
    this.name = "WebDavError";
  }

  /** 远端不可达——页面据此给「检查配置 / 稍后再试」而不是「认证失败」的提示 */
  public get unreachable(): boolean {
    return this.status === 0;
  }
}

export type WebDavClientOptions = {
  baseUrl: string;
  username?: string;
  password?: string;
  /** 可访问根目录（相对 WebDAV 服务根），默认 "/"；所有路径都被限制在它下面 */
  basePath?: string;
  timeoutMs?: number;
  /** 便于测试注入；默认用全局 fetch */
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * 下载（`open()`）的超时下限：下载是**流式**的，`AbortSignal.timeout` 会连同响应体一起掐断，
 * 沿用「浏览目录」那套 15 秒会让大文件在慢速局域网上传到一半就断。
 */
const MIN_DOWNLOAD_TIMEOUT_MS = 120_000;
/** 只请求需要的属性，减小响应体积 */
const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <D:getcontenttype/>
  </D:prop>
</D:propfind>`;

/** 单段规范化：拒绝越界/非法字符，再做百分号编码（返回编码后的段） */
function encodeSegment(raw: string): string {
  const value = raw.trim();
  if (!value || value === "." || value === "..") throw new WebDavError("路径不合法", 400);
  if (/[/\\\0?#]/u.test(value)) throw new WebDavError("路径不合法", 400);
  return encodeURIComponent(value);
}

/** 外部路径 → 编码后的段数组：`a/b//c/` → ["a","b","c"]；`..`、绝对 URL、反斜杠一律拒绝 */
export function splitRemotePath(path: string): string[] {
  const trimmed = path.trim();
  if (trimmed.includes("\\")) throw new WebDavError("路径不合法", 400);
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/u.test(trimmed)) throw new WebDavError("路径不合法", 400);
  return trimmed
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        throw new WebDavError("路径不合法", 400);
      }
      return encodeSegment(decoded);
    });
}

/** 解码后的段（用于和服务器返回的 href 对齐） */
function decodeSegments(segments: string[]): string[] {
  return segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

/** 命名空间前缀无关的标签提取（`<D:href>` / `<href>` 都认） */
function tagValues(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, "giu");
  const values: string[] = [];
  for (const match of xml.matchAll(pattern)) values.push((match[1] ?? "").trim());
  return values;
}

function firstTag(xml: string, tag: string): string | null {
  return tagValues(xml, tag)[0] ?? null;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_all, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gu, "&");
}

/** href（绝对路径或完整 URL）→ 解码后的段数组 */
function hrefSegments(href: string): string[] {
  const withoutHost = href.replace(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\/[^/]*/u, "");
  const pathPart = withoutHost.split("?")[0] ?? "";
  return decodeSegments(pathPart.split("/").filter((segment) => segment.length > 0));
}

function toIsoDate(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export type PropfindItem = { href: string; entry: Omit<WebDavEntry, "path" | "name"> };

/** 解析 207 Multi-Status；跳过 404 的 propstat（Depth:0 查不存在的路径时会出现） */
export function parsePropfind(xml: string): PropfindItem[] {
  const responses = xml.match(/<(?:[\w.-]+:)?response\b[\s\S]*?<\/(?:[\w.-]+:)?response>/giu) ?? [];
  const parsed: PropfindItem[] = [];
  for (const block of responses) {
    const status = firstTag(block, "status") ?? "";
    if (/\s404\b/u.test(status)) continue;
    const href = firstTag(block, "href");
    if (!href) continue;
    const resourceType = firstTag(block, "resourcetype") ?? "";
    const sizeText = firstTag(block, "getcontentlength");
    const modified = firstTag(block, "getlastmodified");
    const contentType = firstTag(block, "getcontenttype");
    parsed.push({
      href: hrefSegments(decodeXmlText(href)).join("/"),
      entry: {
        isDirectory: /<(?:[\w.-]+:)?collection\b/iu.test(resourceType),
        size: sizeText !== null && /^\d+$/u.test(sizeText) ? Number(sizeText) : null,
        lastModified: modified === null ? null : toIsoDate(decodeXmlText(modified)),
        contentType: contentType === null ? null : decodeXmlText(contentType),
      },
    });
  }
  return parsed;
}

export class WebDavClient {
  private readonly baseUrl: string;
  /** baseUrl 自带 path 的解码段（例如 `https://nas/dav` → ["dav"]），用于对齐 href */
  private readonly urlPrefix: string[];
  /** basePath 的编码段（拼 URL 用）与解码段（比对 href 用） */
  private readonly basePath: string[];
  private readonly basePathPlain: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly authorization: string | null;

  public constructor(options: WebDavClientOptions) {
    const trimmed = options.baseUrl.trim();
    if (!/^https?:\/\//u.test(trimmed)) throw new WebDavError("WebDAV 地址必须是 http(s):// 开头", 400);
    this.baseUrl = trimmed.replace(/\/+$/u, "");
    this.urlPrefix = decodeSegments(hrefSegments(new URL(this.baseUrl).pathname));
    this.basePath = splitRemotePath(options.basePath ?? "/");
    this.basePathPlain = decodeSegments(this.basePath);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.authorization =
      options.username || options.password
        ? `Basic ${Buffer.from(`${options.username ?? ""}:${options.password ?? ""}`).toString("base64")}`
        : null;
  }

  /** 相对 basePath 的根为 ""；非法路径抛 WebDavError(400) */
  public normalizePath(path: string): string {
    return splitRemotePath(path).join("/");
  }

  public buildUrl(path: string): string {
    return `${this.baseUrl}/${[...this.basePath, ...splitRemotePath(path)].join("/")}`;
  }

  /** href / 绝对路径 → 相对 basePath 的解码段；不在 basePath 之下返回 null */
  private relativeSegments(href: string): string[] | null {
    const segments = hrefSegments(href);
    const prefix = [...this.urlPrefix, ...this.basePathPlain];
    if (segments.length < prefix.length) return null;
    for (let index = 0; index < prefix.length; index += 1) {
      if (segments[index] !== prefix[index]) return null;
    }
    const relative = segments.slice(prefix.length);
    // 服务器返回的段不可信：带 `..` / `.` 的一律丢弃，避免被写进索引后在别处被解析成越界路径
    return relative.some((segment) => segment === ".." || segment === "." || segment.includes("\\")) ? null : relative;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.authorization ? { authorization: this.authorization, ...extra } : { ...extra };
  }

  private async send(path: string, init: RequestInit, timeoutMs = this.timeoutMs): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.buildUrl(path), {
        ...init,
        headers: this.headers(init.headers as Record<string, string> | undefined),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new WebDavError(`无法连接 WebDAV：${error instanceof Error ? error.message : "未知错误"}`, 0);
    }
    if (response.status === 401 || response.status === 403) {
      throw new WebDavError("WebDAV 认证失败或权限不足", response.status);
    }
    if (response.status >= 500) throw new WebDavError(`WebDAV 服务器错误（${response.status}）`, response.status);
    return response;
  }

  private async propfind(path: string, depth: "0" | "1"): Promise<PropfindItem[]> {
    const response = await this.send(path, {
      method: "PROPFIND",
      headers: { depth, "content-type": "application/xml; charset=utf-8" },
      body: PROPFIND_BODY,
    });
    if (response.status === 404) return [];
    if (response.status !== 207 && !response.ok) throw new WebDavError(`WebDAV 返回 ${response.status}`, response.status);
    return parsePropfind(await response.text());
  }

  /** 列目录：返回 basePath 下的条目（不含被列目录自身），目录在前、同类按名称排序 */
  public async list(path: string): Promise<WebDavEntry[]> {
    const normalized = this.normalizePath(path);
    const selfSegments = this.relativeSegments(new URL(this.buildUrl(normalized)).pathname) ?? [];
    const selfKey = selfSegments.join("/");
    const entries: WebDavEntry[] = [];
    for (const item of await this.propfind(normalized, "1")) {
      const relative = this.relativeSegments(item.href);
      if (!relative) continue;
      const key = relative.join("/");
      // Depth:1 会把被列目录自己一起返回，去掉它
      if (!key || key === selfKey) continue;
      entries.push({ ...item.entry, path: key, name: relative.at(-1) ?? key });
    }
    return entries.toSorted((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
      return left.name.localeCompare(right.name, "zh-Hans-CN");
    });
  }

  /**
   * 连通性 + 认证探针：对可浏览根做一次 Depth:0 的 PROPFIND。
   * 用于把「远端整个连不上」与「某个文件确实不存在」区分开——后者是 404，前者会抛错。
   */
  public async ping(): Promise<void> {
    const response = await this.send("", {
      method: "PROPFIND",
      headers: { depth: "0", "content-type": "application/xml; charset=utf-8" },
      body: PROPFIND_BODY,
    });
    if (response.status !== 207 && !response.ok) throw new WebDavError(`WebDAV 返回 ${response.status}`, response.status);
  }

  /** 取单条元信息；不存在（404）返回 null，其他错误抛出 */
  public async stat(path: string): Promise<WebDavEntry | null> {
    const normalized = this.normalizePath(path);
    if (!normalized) {
      return { path: "", name: "/", isDirectory: true, size: null, lastModified: null, contentType: null };
    }
    const item = (await this.propfind(normalized, "0"))[0];
    if (!item) return null;
    if (this.relativeSegments(item.href) === null) return null;
    return { ...item.entry, path: normalized, name: normalized.split("/").at(-1) ?? normalized };
  }

  /** 并发批量 stat（默认并发 4）；单条失败按「查不到」处理，不打断整页 */
  public async statMany(paths: string[], concurrency = 4): Promise<Map<string, WebDavEntry | null>> {
    const result = new Map<string, WebDavEntry | null>();
    const queue = [...paths];
    const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) return;
        try {
          result.set(next, await this.stat(next));
        } catch {
          result.set(next, null);
        }
      }
    });
    await Promise.all(workers);
    return result;
  }

  /** 上传（同名覆盖）；父目录不存在时逐级补建。`body` 用 Blob（页面上传拿到的是 File，本身就是 Blob，undici 会流式发送） */
  public async upload(path: string, body: Blob, contentType?: string): Promise<void> {
    const normalized = this.normalizePath(path);
    if (!normalized) throw new WebDavError("上传必须指定文件名", 400);
    const parent = normalized.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureDirectory(parent);
    const response = await this.send(normalized, {
      method: "PUT",
      body,
      headers: contentType ? { "content-type": contentType } : {},
    });
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
      throw new WebDavError(`WebDAV 上传失败（${response.status}）`, response.status);
    }
  }

  /**
   * 上传一个**不允许覆盖**的文件：`PUT` 带条件头 `If-None-Match: *`，远端已有同名文件时服务器必须回 412。
   *
   * 为什么需要它：`upload()` 走的是 PUT 的默认覆盖语义，而周报正文一旦被同名覆盖就不可恢复
   * （退回重传、同期再交一份都可能撞名）。返回 `true` = 确实写进去了，`false` = 远端已存在，
   * 调用方据此追加 `_2` / `_v2` 这类后缀换一个名字重试。
   *
   * 注意两点：
   * 1. `If-None-Match` 是标准 HTTP 条件请求，主流 WebDAV 服务端（nginx-dav、Synology、Nextcloud）都支持；
   *    万一有服务端忽略它，调用方**还要先 `stat` 一次**（`report-storage.server.ts` 就是这么做的），
   *    条件头在这里的作用是把「探测与写入之间被人插了一脚」的竞态也堵上；
   * 2. 412 是「已存在」的正常结果，不抛异常；412 之外的失败照旧抛 `WebDavError`。
   */
  public async uploadIfAbsent(path: string, body: Blob, contentType?: string): Promise<boolean> {
    const normalized = this.normalizePath(path);
    if (!normalized) throw new WebDavError("上传必须指定文件名", 400);
    const parent = normalized.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureDirectory(parent);
    const response = await this.send(normalized, {
      method: "PUT",
      body,
      headers: { "if-none-match": "*", ...(contentType ? { "content-type": contentType } : {}) },
    });
    if (response.status === 412) return false;
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
      throw new WebDavError(`WebDAV 上传失败（${response.status}）`, response.status);
    }
    return true;
  }

  /**
   * 打开一个远端文件用于**流式**读取（周报正文下载走这里，不再整份读进内存）。
   *
   * 返回 `null` 表示远端确实没有这个文件（404）；认证失败 / 服务器错误照旧抛 `WebDavError`，
   * 让调用方能把「文件没了」与「NAS 连不上」分开告诉用户。
   */
  public async open(path: string): Promise<WebDavDownload | null> {
    const normalized = this.normalizePath(path);
    if (!normalized) throw new WebDavError("下载必须指定文件路径", 400);
    const response = await this.send(normalized, { method: "GET" }, Math.max(this.timeoutMs, MIN_DOWNLOAD_TIMEOUT_MS));
    if (response.status === 404) return null;
    if (!response.ok) throw new WebDavError(`WebDAV 下载失败（${response.status}）`, response.status);
    const lengthText = response.headers.get("content-length");
    const length = lengthText !== null && /^\d+$/u.test(lengthText) ? Number(lengthText) : null;
    return { body: response.body, contentType: response.headers.get("content-type"), size: length };
  }

  /** 逐级补建目录链；已存在（MKCOL 405）按成功处理，保证幂等 */
  private async ensureDirectory(path: string): Promise<void> {
    let current = "";
    for (const segment of splitRemotePath(path)) {
      current = current ? `${current}/${segment}` : segment;
      if ((await this.stat(current))?.isDirectory) continue;
      const response = await this.send(current, { method: "MKCOL" });
      if (response.status !== 201 && response.status !== 405) {
        throw new WebDavError(`WebDAV 建目录失败（${response.status}）`, response.status);
      }
    }
  }
}

export function createWebDavClient(options: WebDavClientOptions): WebDavClient {
  return new WebDavClient(options);
}

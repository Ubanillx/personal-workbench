import { WebDavError } from "../../server/src/webdav/client";
import type { ReportUploadSettingsView, WebDavSettingsView } from "../../shared/types/domain";
import { appConfig } from "./context.server";
import { db, now, one, run } from "./db.server";

/**
 * WebDAV 连接配置的持久化与校验。这里管**两份**配置，用途不同、互不影响：
 *
 * 1. **「重要文件」（按账号，地址部署级）**：地址来自环境变量 `WEBDAV_URL`（部署级、只读），
 *    用户名 / 密码 / 浏览根目录 / 超时按账号存在 `webdav_settings` 里，在 `/settings?tab=webdav` 维护；
 * 2. **「周报上传」（全局单行，D-46）**：周报正文只写 NAS，用**一个统一账号**，
 *    存在单行表 `report_upload_settings` 里，同一个设置页的「周报上传」区块维护（仅管理员）。
 *
 * 边界：
 * - `password` 两份都是明文入库（Basic 认证需要原文），且**只进 `Authorization` 头**；
 *   经 `webDavSettingsView` / `reportUploadSettingsView` 对外只暴露 `hasPassword`；
 * - 地址不允许内嵌账号密码（避免地址出现在日志/页面里时顺带泄露凭据）；
 * - 这里只负责「读写 + 校验」，不发任何网络请求；连通性探针在 `webdav.server.ts`。
 */

/** 超时默认值与边界：下限避免误填 0，上限避免页面被远端拖太久 */
const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
/** 未配置时的默认浏览根 */
const DEFAULT_ROOT = "/";

/** 生效的完整配置（部署级地址 + 本账号凭据），可直接交给 WebDAV 客户端 */
export type WebDavSettings = {
  url: string;
  username: string;
  password: string;
  root: string;
  timeoutMs: number;
};

/** 库里按账号存下来的部分：地址不在这里（来自 WEBDAV_URL） */
export type StoredWebDavSettings = Omit<WebDavSettings, "url">;

/** 解析后的配置：`enabled` 表示这个账号能不能用（地址配好了 **且** 本账号登记过） */
export type ResolvedWebDavConfig = WebDavSettings & { enabled: boolean };

/** 未接入时的空配置（浏览根与超时给默认值，页面回填用） */
const UNCONFIGURED: StoredWebDavSettings = { username: "", password: "", root: DEFAULT_ROOT, timeoutMs: DEFAULT_TIMEOUT_MS };

/** 设置页表单提交的原始字段（都是 unknown，由下面的 normalize* 收敛）；地址不在表单里 */
export type WebDavSettingsInput = {
  username?: unknown;
  password?: unknown;
  root?: unknown;
  timeoutMs?: unknown;
};

export type WebDavSettingsSaveResult = { ok: true } | { ok: false; message: string };

/* ------------------------------------------------------------------ 地址（环境变量） */

/**
 * 部署级的 WebDAV 地址：来自 `WEBDAV_URL`，校验并规范化。
 *
 * 地址非法时**不抛异常**（那样会让整个服务起不来，而它只是一个可选功能）：
 * 返回 `error` 文案，由设置页显示出来，其余功能照常。
 */
export function webDavAddress(): { url: string; error: string | null } {
  const raw = appConfig().webdavUrl;
  if (!raw) return { url: "", error: null };
  try {
    return { url: normalizeWebDavUrl(raw), error: null };
  } catch (error) {
    return { url: "", error: error instanceof Error ? error.message : "WEBDAV_URL 不是合法地址" };
  }
}

/** `https://nas/dav/` → `https://nas/dav`；非法一律抛 WebDavError(400) */
export function normalizeWebDavUrl(raw: unknown): string {
  const value = String(raw ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WebDavError("WebDAV 地址不是合法 URL（例如 https://nas.example.com:5006/dav）", 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebDavError("WebDAV 地址必须以 http:// 或 https:// 开头", 400);
  }
  if (parsed.username || parsed.password) {
    throw new WebDavError("WebDAV 地址不要内嵌账号密码，请分别填写用户名与密码", 400);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
}

/**
 * 可浏览根：用户在 NAS 上看到的「访问路径」，Linux 与 Windows 两种写法都接受。
 *
 * 统一成「以 `/` 开头、不以 `/` 结尾」的 WebDAV 相对路径；`/` 代表服务根。
 * 支持的形式（`→` 后面是归一化结果）：
 *
 * | 写法                                   | 结果           | 说明                                     |
 * | -------------------------------------- | -------------- | ---------------------------------------- |
 * | `/volume1/work`（或 `volume1/work`）   | `/volume1/work` | Linux / WebDAV 原生路径，原样保留       |
 * | `\volume1\work`                        | `/volume1/work` | 只用反斜杠写的普通路径：反斜杠就是分隔符 |
 * | `\\192.168.0.242\work\报价`            | `/报价`         | Windows 共享（UNC）：**去掉主机名与共享名** |
 * | `Z:\报价` / `Z:\`                      | `/报价` / `/`   | Windows 盘符：只去掉盘符本身             |
 *
 * 两条刻意的边界：
 * 1. **UNC 只认反斜杠写法**（Windows 资源管理器复制出来的就是 `\\主机名\共享名\...`）。
 *    `//主机名/共享名` 这种正斜杠写法**不**当作 UNC，只当成重复斜杠——否则用户手滑多打一个
 *    `/` 就会静默丢掉一整段路径。要保留共享名就直接写 `/work/报价`。
 * 2. UNC 会把**共享名一起去掉**，所以它假定 `WEBDAV_URL` 已经指到那个共享里
 *    （例如 `http://nas:5005/work`）。若地址停在服务根，共享名本身就是路径的一段。
 *
 * 重复斜杠会被收敛（`///a//b///` → `/a/b`）；`.` / `..` 这类相对段直接拒绝——
 * 它们在任何文件系统里都不是合法目录名，放过去只会让后面浏览时莫名其妙地报「路径不合法」。
 */
export function normalizeWebDavRoot(raw: unknown): string {
  const value = String(raw ?? "").trim();
  // UNC 必须在替换分隔符**之前**判断，否则 `\\` 会被抹平成 `/` 而丢掉信息
  const isUnc = value.startsWith("\\\\");
  const segments = value.replace(/\\/gu, "/").split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new WebDavError("浏览根目录不能包含 . 或 .. 这样的相对段", 400);
  }
  const rest = isUnc
    ? // `\\主机名\共享名\其余…`：前两段就是主机名与共享名，都去掉
      segments.slice(2)
    : // `C:` / `C:\x` / `C:x`：把第一段里的盘符剥掉（剥完可能是空串，filter 掉）
      segments.map((segment, index) => (index === 0 ? segment.replace(/^[A-Za-z]:/u, "") : segment)).filter(Boolean);
  return rest.length ? `/${rest.join("/")}` : DEFAULT_ROOT;
}

/** 超时（毫秒）：落库前夹在 [1s, 120s] 内，非法值直接报错（不静默改） */
export function normalizeWebDavTimeout(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new WebDavError("超时必须是大于 0 的毫秒数", 400);
  return Math.min(Math.max(Math.trunc(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/* ------------------------------------------------------------------ 按账号的读写 */

/** 读账号里保存的凭据与偏好；没保存过返回 null */
export function readWebDavSettings(userId: string): StoredWebDavSettings | null {
  const row = one<Record<string, unknown>>(
    db(),
    "SELECT username, password, root, timeout_ms FROM webdav_settings WHERE user_id=?",
    userId,
  );
  if (!row) return null;
  return {
    username: String(row.username ?? ""),
    password: String(row.password ?? ""),
    root: String(row.root ?? DEFAULT_ROOT),
    timeoutMs: Number(row.timeout_ms ?? DEFAULT_TIMEOUT_MS),
  };
}

/**
 * 当前账号的生效配置。
 *
 * 两个条件都满足才算接入：**部署配了地址**（WEBDAV_URL）且**本账号登记过**。
 * 后者是刻意的：没打算用 WebDAV 的人不该在每次打开「重要文件」时被远端探测拖慢，
 * 也不该看到「远端不可达」的告警。
 */
export function resolveWebDavConfig(userId: string): ResolvedWebDavConfig {
  const { url } = webDavAddress();
  const stored = readWebDavSettings(userId);
  if (!url || !stored) return { url: "", ...UNCONFIGURED, ...stored, enabled: false };
  return { url, ...stored, enabled: true };
}

/** 给页面看的视图：地址来自环境变量（只读），凭据只给「有没有存过密码」 */
export function webDavSettingsView(userId: string): WebDavSettingsView {
  const address = webDavAddress();
  const stored = readWebDavSettings(userId);
  return {
    addressConfigured: Boolean(address.url),
    addressError: address.error,
    url: address.url,
    configured: Boolean(address.url) && stored !== null,
    username: stored?.username ?? "",
    root: stored?.root ?? DEFAULT_ROOT,
    timeoutMs: stored?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    hasPassword: Boolean(stored?.password),
  };
}

/**
 * 保存本账号的凭据与偏好（存在则更新，不存在则插入）。
 *
 * `password` 留空表示**保持原密码**：页面不回填密码，留空是常态，不能因此把密码清掉。
 * 地址没配好时直接拒绝，避免存下一行永远不会生效的配置。
 */
export function saveWebDavSettings(userId: string, input: WebDavSettingsInput): WebDavSettingsSaveResult {
  const address = webDavAddress();
  if (address.error) return { ok: false, message: `${address.error}（改 .env 里的 WEBDAV_URL 后重启服务）` };
  if (!address.url) return { ok: false, message: "还没配置 WebDAV 地址：请在 .env 里设置 WEBDAV_URL 后重启服务" };

  let root: string;
  let timeoutMs: number;
  try {
    root = normalizeWebDavRoot(input.root);
    timeoutMs = normalizeWebDavTimeout(input.timeoutMs);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "WebDAV 配置不合法" };
  }
  const existing = readWebDavSettings(userId);
  const username = String(input.username ?? "").trim();
  const password = typeof input.password === "string" && input.password !== "" ? input.password : (existing?.password ?? "");
  const stamp = now();
  if (existing) {
    run(
      db(),
      "UPDATE webdav_settings SET username=?,password=?,root=?,timeout_ms=?,updated_at=? WHERE user_id=?",
      username,
      password,
      root,
      timeoutMs,
      stamp,
      userId,
    );
  } else {
    run(
      db(),
      "INSERT INTO webdav_settings(user_id,username,password,root,timeout_ms,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      userId,
      username,
      password,
      root,
      timeoutMs,
      stamp,
      stamp,
    );
  }
  return { ok: true };
}

/** 清除本账号的配置（清除后回到「未接入」） */
export function clearWebDavSettings(userId: string): void {
  run(db(), "DELETE FROM webdav_settings WHERE user_id=?", userId);
}

/**
 * 「测试连接」用：地址取环境变量 + 表单当前值（密码留空则用库里已存的），**不落库**。
 * 校验失败返回错误文案，成功返回可交给 `pingWebDav` 的配置。
 */
export function resolveWebDavTestConfig(
  userId: string,
  input: WebDavSettingsInput,
): { ok: true; config: WebDavSettings } | { ok: false; message: string } {
  const address = webDavAddress();
  if (address.error) return { ok: false, message: address.error };
  if (!address.url) return { ok: false, message: "还没配置 WebDAV 地址：请在 .env 里设置 WEBDAV_URL 后重启服务" };
  try {
    const existing = readWebDavSettings(userId);
    return {
      ok: true,
      config: {
        url: address.url,
        username: String(input.username ?? "").trim(),
        password: typeof input.password === "string" && input.password !== "" ? input.password : (existing?.password ?? ""),
        root: normalizeWebDavRoot(input.root),
        timeoutMs: normalizeWebDavTimeout(input.timeoutMs),
      },
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "WebDAV 配置不合法" };
  }
}

/* ------------------------------------------------------------------ 周报上传（全局单行，D-46） */

/**
 * 周报正文的落点与配置（完整设计见 docs/harness/REPORTS_WEBDAV.md）。
 *
 * 与上面那份**按账号**的配置有三点不同：
 * 1. **全局一行**（`report_upload_settings`，主键固定为 1）：谁交周报都写同一个远端目录；
 * 2. **统一账号**：普通成员不需要、也不该去配 NAS 凭据，凭据由管理员维护；
 * 3. **上传根目录**是这份配置的核心字段，落点为 `<根>/<用户名>/<起止日期>/<文件名>`。
 *
 * 地址依旧来自 `WEBDAV_URL`（D-44），两份配置共用同一个地址、不同的账号。
 */

/** 周报上传的默认根目录（表单留空时也用它） */
export const DEFAULT_REPORT_ROOT = "/周报";

/**
 * 未配置时的视图：非管理员拿到的就是它——「周报上传」卡片只对管理员渲染，
 * 交给页面一个形状完整的空视图，比在组件里到处判空干净。
 */
export const UNCONFIGURED_REPORT_UPLOAD_VIEW: ReportUploadSettingsView = {
  configured: false,
  username: "",
  root: DEFAULT_REPORT_ROOT,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  hasPassword: false,
  updatedByName: null,
  updatedAt: null,
};

/** 单行表的固定主键：`CHECK (id = 1)` 保证这张表最多一行 */
const REPORT_UPLOAD_ROW_ID = 1;

/** 库里存下来的周报上传配置（与按账号那份同形：都不含地址） */
export type ReportUploadSettings = StoredWebDavSettings;

/** 生效的周报上传配置（部署级地址 + 单行凭据） */
export type ResolvedReportUploadConfig = WebDavSettings & { enabled: boolean };

/** 未配置时的空值（页面回填与默认值用） */
const UNCONFIGURED_REPORT_UPLOAD: ReportUploadSettings = {
  username: "",
  password: "",
  root: DEFAULT_REPORT_ROOT,
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

type ReportUploadRow = ReportUploadSettings & { updatedByName: string | null; updatedAt: string | null };

/** 读单行配置；没有这一行返回 null（= 周报存储未配置） */
function readReportUploadRow(): ReportUploadRow | null {
  const row = one<Record<string, unknown>>(
    db(),
    `SELECT s.username AS username,s.password AS password,s.root AS root,s.timeout_ms AS timeoutMs,
            s.updated_at AS updatedAt,u.name AS updatedByName
       FROM report_upload_settings s LEFT JOIN users u ON u.id = s.updated_by
      WHERE s.id=?`,
    REPORT_UPLOAD_ROW_ID,
  );
  if (!row) return null;
  return {
    username: String(row.username ?? ""),
    password: String(row.password ?? ""),
    root: String(row.root ?? DEFAULT_REPORT_ROOT),
    timeoutMs: Number(row.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    updatedByName: row.updatedByName == null ? null : String(row.updatedByName),
    updatedAt: row.updatedAt == null ? null : String(row.updatedAt),
  };
}

/** 周报上传是否已接入：**地址配好** 且 **单行配置存在**（两个条件缺一不可，与按账号那份同一口径） */
export function resolveReportUploadConfig(): ResolvedReportUploadConfig {
  const { url } = webDavAddress();
  const stored = readReportUploadRow();
  if (!url || !stored) return { url: "", ...UNCONFIGURED_REPORT_UPLOAD, enabled: false };
  const { username, password, root, timeoutMs } = stored;
  return { url, username, password, root, timeoutMs, enabled: true };
}

/** 设置页「周报上传」区块的视图（不含密码，只给 `hasPassword`） */
export function reportUploadSettingsView(): ReportUploadSettingsView {
  const address = webDavAddress();
  const stored = readReportUploadRow();
  return {
    configured: Boolean(address.url) && stored !== null,
    username: stored?.username ?? "",
    root: stored?.root ?? DEFAULT_REPORT_ROOT,
    timeoutMs: stored?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    hasPassword: Boolean(stored?.password),
    updatedByName: stored?.updatedByName ?? null,
    updatedAt: stored?.updatedAt ?? null,
  };
}

/**
 * 保存周报上传配置（存在则更新，不存在则插入那一行）。
 *
 * 三条与按账号那份一致的规矩：
 * - **密码留空 = 保持原密码**（页面不回填密码，留空是常态，不能因此把密码清掉）；
 * - 地址没配好直接拒绝，避免存下一行永远不会生效的配置；
 * - 根目录留空按默认 `/周报` 处理（`normalizeWebDavRoot("")` 会给出服务根 `/`，
 *   那会把周报直接铺在 NAS 根目录下，不是这里想要的语义）。
 */
export function saveReportUploadSettings(userId: string, input: WebDavSettingsInput): WebDavSettingsSaveResult {
  const address = webDavAddress();
  if (address.error) return { ok: false, message: `${address.error}（改 .env 里的 WEBDAV_URL 后重启服务）` };
  if (!address.url) return { ok: false, message: "还没配置 WebDAV 地址：请在 .env 里设置 WEBDAV_URL 后重启服务" };

  let root: string;
  let timeoutMs: number;
  try {
    const rawRoot = String(input.root ?? "").trim();
    root = rawRoot ? normalizeWebDavRoot(rawRoot) : DEFAULT_REPORT_ROOT;
    timeoutMs = normalizeWebDavTimeout(input.timeoutMs);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "周报上传配置不合法" };
  }
  const existing = readReportUploadRow();
  const username = String(input.username ?? "").trim();
  const password = typeof input.password === "string" && input.password !== "" ? input.password : (existing?.password ?? "");
  const stamp = now();
  if (existing) {
    run(
      db(),
      "UPDATE report_upload_settings SET username=?,password=?,root=?,timeout_ms=?,updated_by=?,updated_at=? WHERE id=?",
      username,
      password,
      root,
      timeoutMs,
      userId,
      stamp,
      REPORT_UPLOAD_ROW_ID,
    );
  } else {
    run(
      db(),
      "INSERT INTO report_upload_settings(id,username,password,root,timeout_ms,updated_by,updated_at) VALUES(?,?,?,?,?,?,?)",
      REPORT_UPLOAD_ROW_ID,
      username,
      password,
      root,
      timeoutMs,
      userId,
      stamp,
    );
  }
  return { ok: true };
}

/**
 * 清除周报上传配置：整行删掉，回到「周报存储未配置」。
 * 影响面比按账号那份大得多——此后**所有人的**周报上传与新式记录的下载都会 503，
 * 所以设置页把它做成二次确认，并在文案里写清楚。
 */
export function clearReportUploadSettings(): void {
  run(db(), "DELETE FROM report_upload_settings WHERE id=?", REPORT_UPLOAD_ROW_ID);
}

/**
 * 「测试连接」用：地址取环境变量 + 表单当前值（密码留空则用已存的那份），**不落库**。
 * 与按账号那份的唯一区别是「已存密码」的来源是单行表而不是本账号。
 */
export function resolveReportUploadTestConfig(
  input: WebDavSettingsInput,
): { ok: true; config: WebDavSettings } | { ok: false; message: string } {
  const address = webDavAddress();
  if (address.error) return { ok: false, message: address.error };
  if (!address.url) return { ok: false, message: "还没配置 WebDAV 地址：请在 .env 里设置 WEBDAV_URL 后重启服务" };
  try {
    const existing = readReportUploadRow();
    const rawRoot = String(input.root ?? "").trim();
    return {
      ok: true,
      config: {
        url: address.url,
        username: String(input.username ?? "").trim(),
        password: typeof input.password === "string" && input.password !== "" ? input.password : (existing?.password ?? ""),
        root: rawRoot ? normalizeWebDavRoot(rawRoot) : DEFAULT_REPORT_ROOT,
        timeoutMs: normalizeWebDavTimeout(input.timeoutMs),
      },
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "周报上传配置不合法" };
  }
}

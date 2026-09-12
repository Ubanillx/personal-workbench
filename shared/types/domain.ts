export type UserRole = "admin" | "manager" | "member";
export type TaskStatus = "todo" | "in_progress" | "pending_review" | "completed";
export type TaskPriority = "P0" | "P1" | "P2";
export type TaskSource = "manual" | "wecom" | "api" | "assistant";

export interface CurrentUser {
  id: string;
  username: string;
  email: string;
  name: string;
  role: UserRole;
  /** 管理员为 null（全局角色，不隶属组织） */
  orgId: string | null;
  orgName: string | null;
  mustChangePassword: boolean;
}

export type OrganizationStatus = "active" | "archived";

export interface Organization {
  id: string;
  name: string;
  description: string;
  status: OrganizationStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  memberCount?: number;
}

export type JoinRequestKind = "join" | "leave" | "invite";
export type JoinRequestStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface JoinRequest {
  id: string;
  kind: JoinRequestKind;
  userId: string;
  userName: string | null;
  username: string | null;
  orgId: string;
  orgName: string | null;
  status: JoinRequestStatus;
  message: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decisionNote: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  progress: number;
  dueDate: string | null;
  ownerId: string | null;
  createdBy: string;
  source: TaskSource;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt?: string | null;
  ownerName?: string;
  ownerRole?: UserRole;
  /** 任务所属组织；管理员在合并视图（D-28）里靠它区分每行属于哪个组织 */
  orgId?: string | null;
  orgName?: string | null;
}

export interface Todo {
  id: string;
  content: string;
  todoDate: string | null;
  isCompleted: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Note {
  id: string;
  content: string;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ReportDocType = "weekly_report" | "summary" | "other";
export type ReportStatus = "submitted" | "approved" | "returned";

export interface ReportFile {
  id: string;
  reportId: string;
  version: number;
  originalName: string;
  storedName: string;
  sizeBytes: number;
  ext: string;
  mimeType: string | null;
  uploadedBy: string;
  uploadedAt: string;
}

export interface Report {
  id: string;
  ownerId: string;
  ownerName: string | null;
  periodStart: string;
  periodEnd: string;
  docType: ReportDocType;
  note: string;
  status: ReportStatus;
  currentVersion: number;
  uploadedBy: string;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string;
  reviewedAt: string | null;
  returnedAt: string | null;
  files: ReportFile[];
}

/**
 * 「重要文件」的 WebDAV 只读视图（`/api/webdav` 与 /files 页面共用，见 docs/harness/WEBDAV.md）。
 * 放在 shared 里是为了让页面组件能安全引用类型——`app/lib/webdav.server.ts` 是服务端专用模块，
 * 客户端代码不能从它这里导入。
 */

/** `important_files.file_path` 里标识「远端条目」的前缀：`webdav:报价/2026报价单.xlsx` */
export const WEBDAV_PATH_PREFIX = "webdav:";
export interface WebDavBrowseEntry {
  /** 相对可浏览根的路径，例如 `报价/2026报价单.xlsx` */
  path: string;
  name: string;
  isDirectory: boolean;
  size: number | null;
  /** ISO 时间串；远端没给或解析不出来时为 null */
  lastModified: string | null;
  contentType: string | null;
  /** 可直接存进 `important_files.file_path` 的值（`webdav:<path>`），由服务端拼好 */
  filePath: string;
}

export interface WebDavBrowseResult {
  path: string;
  /** 上一级目录；已经在根目录时为 null */
  parent: string | null;
  /** 可浏览根（设置页里的「浏览根目录」），用于面包屑展示 */
  root: string;
  entries: WebDavBrowseEntry[];
}

/**
 * 列一级目录的结果：`root` 由调用方按用途补上（`/api/webdav` 补当前可浏览根；
 * 设置页的「目录选择器」不需要，因为它本来就固定从服务根往下浏览）。
 * 放在 shared 里同样是为了让页面组件不必引用服务端专用模块。
 */
export type WebDavBrowseListing = Omit<WebDavBrowseResult, "root">;

export interface WebDavFileStatus {
  exists: boolean;
  size: number | null;
  lastModified: string | null;
}

/**
 * 设置页「WebDAV」Tab 的视图（见 docs/harness/WEBDAV.md）。
 *
 * 配置分两半：**地址是部署级的**（环境变量 `WEBDAV_URL`，页面只读展示），
 * **用户名 / 密码 / 浏览根目录 / 超时按账号存库**。
 *
 * **刻意不含 password**：密码只在服务端读取用于拼 `Authorization` 头，
 * 页面只知道「有没有存过」（`hasPassword`），表单留空 = 保持原密码。
 */
export interface WebDavSettingsView {
  /** 部署级地址是否已配好（`WEBDAV_URL` 非空且合法）；false = 整个远端通道不可用 */
  addressConfigured: boolean;
  /** 地址不合法时的原因（例如少了协议头）；正常时为 null */
  addressError: string | null;
  /** 部署级地址（来自环境变量），只读展示；未配置时为空串 */
  url: string;
  /** 本账号是否已接入（地址配好 **且** 本账号保存过配置） */
  configured: boolean;
  /** 本账号保存的原始值，用于回填表单（未保存时为空 / 默认值） */
  username: string;
  root: string;
  timeoutMs: number;
  /** 账号里是否存过密码（不回传密码本身） */
  hasPassword: boolean;
}

/**
 * 设置页「WebDAV → 周报上传」区块的视图（D-53，见 docs/harness/REPORTS_WEBDAV.md §4）。
 *
 * 周报正文只写 NAS：**连接共用管理员保存的那份**（D-52），
 * **上传根目录按组织分开配**（D-53）——所以这个视图的作用域是**一个组织**，
 * 组织管理者改自己那份，管理员可以换组织。
 *
 * **刻意不含任何凭据字段**，也不回显连接：连接就显示在正上方那张「WebDAV 连接」卡里。
 */
export interface ReportUploadSettingsView {
  /** 作用域：组织 id；null = 当前没有可配置的组织（组织列表为空 / 本组织已解散） */
  orgId: string | null;
  /** 组织名（页面用来告诉用户「改的是哪个组织的目录」） */
  orgName: string | null;
  /** 有没有可用的 WebDAV 连接（管理员保存的那份）；false = 这张卡整体不可用 */
  connectionReady: boolean;
  /** 本组织**另外挑过**的上传根目录（相对 WebDAV 服务根）；用连接的浏览根时为空串 */
  ownRoot: string;
  /** 是否用连接的浏览根目录（= 没另外挑过，也就是默认行为） */
  followsConnection: boolean;
  /** 本组织实际生效的上传根目录；没有可用连接或没有组织时为空串 */
  root: string;
  /** 最后修改这个目录的账号名；从未改过时为 null */
  updatedByName: string | null;
  updatedAt: string | null;
}

/** 站内通知的客户端视图：SSR 首屏载荷与 SSE 实时推送共用同一字段口径 */
export interface Notification {
  id: string;
  actorId: string | null;
  taskId: string | null;
  reportId: string | null;
  eventType: string;
  title: string;
  message: string;
  createdAt: string;
}

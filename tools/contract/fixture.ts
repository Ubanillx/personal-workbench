import { createHash, scryptSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabaseClient } from "../../server/src/db/client";
// 只导入类型：这里对 cases.ts 是 **type-only** 依赖，编译后不留 import，
// 因此与「cases.ts 反过来 import 本文件的 ACCOUNTS 值」不构成运行时循环依赖。
import type { Role } from "./cases";

/** 固定时间戳：golden 必须与运行时刻无关 */
const STAMP = "2026-09-01T00:00:00.000Z";
/** 归档组织与归档任务的时间戳（解散/归档场景要有一个固定时刻） */
const ARCHIVED_STAMP = "2026-09-02T00:00:00.000Z";
const MIGRATIONS_DIR = path.resolve(process.cwd(), "server/src/db/migrations");

/** 账号 key = `Role` 去掉匿名（`anon` 不带 Cookie，没有凭据） */
export type AccountKey = Exclude<Role, "anon">;

/** 单个账号的登录凭据 */
export type AccountCredential = { username: string; password: string };

/**
 * 夹具账号：契约 runner 用 `username` + `password` 打 `POST /api/auth/login` 换会话
 * （令牌登录已在 B 阶段整体退役，`POST /api/auth/access` 与旧的 `TOKENS` 都不存在了）。
 *
 * 键集由 `Role`（cases.ts 导出）反推，两边不会漂移：
 * `admin` / `managerA` / `memberA` / `memberA2` / `managerB` / `memberB` / `noOrg` / `mustChange`。
 *
 * 密码规则：全部 ≥ 8 位（`validatePassword` 的下限）；库里存 scrypt 哈希。
 * `mustChange` 是**唯一** `must_change_password=1` 的账号：只有它能验证强制改密门禁，
 * 其余账号（含 `noOrg`）一律为 0 —— 否则业务端点会被 403 `PASSWORD_CHANGE_REQUIRED` 挡死，
 * 而入组申请（`POST /api/join-requests`）正是 `noOrg` 的主场，必须是 0。
 */
export const ACCOUNTS: Record<AccountKey, AccountCredential> = {
  admin: { username: "admin", password: "admin-pw-1" },
  managerA: { username: "manager-a", password: "manager-a-pw" },
  memberA: { username: "member-a", password: "member-a-pw" },
  memberA2: { username: "member-a2", password: "member-a2-pw" },
  managerB: { username: "manager-b", password: "manager-b-pw" },
  memberB: { username: "member-b", password: "member-b-pw" },
  noOrg: { username: "no-org", password: "no-org-pw" },
  mustChange: { username: "must-change", password: "must-change-pw" },
};

/** 改密用例用的新密码：`mustChange` 改完才算真正可用（门禁由 requireAuth 兜住） */
export const NEW_PASSWORDS = {
  mustChange: "must-change-pw-2",
  memberA: "member-a-pw-2",
} as const;

/**
 * 种子数据的固定 id，供用例引用。
 *
 * 注意：`runner.ts` 只替换 **path** 里的 `{{变量}}`，请求体与 multipart 字段是原样发送的，
 * 因此用例体里引用固定 id 时必须直接用这份常量（见 cases.ts 里 `IDS.xxx` 的用法）。
 */
export const IDS = {
  // 组织（org-archived 是「伽马组」：已解散，用来验证列表差异与归档不变式）
  orgAlpha: "org-alpha",
  orgBeta: "org-beta",
  orgArchived: "org-archived",
  // 账号（固定 id，便于跨组织用例引用「别人的 id」）
  userAdmin: "user-admin",
  userManagerA: "user-manager-a",
  userMemberA: "user-member-a",
  userMemberA2: "user-member-a2",
  userManagerB: "user-manager-b",
  userMemberB: "user-member-b",
  userNoOrg: "user-no-org",
  userMustChange: "user-must-change",
  // 阿尔法组的业务数据（原夹具那一批：7 个任务覆盖各种状态）
  taskTodo: "t-todo",
  taskDoing: "t-doing",
  taskReview: "t-review",
  taskDone: "t-done",
  taskArchived: "t-archived",
  taskPrivate: "t-private",
  taskOverdue: "t-overdue",
  /** 同组织里别人的任务：验证「member 只看自己负责的」 */
  taskOfA2: "t-of-a2",
  todoOpen: "todo-open",
  noteOne: "note-1",
  fileOne: "file-1",
  /** 指向 `webdav:` 远端的索引（D-49 起给「下载」用例当未配置 503 的靶子） */
  fileRemote: "file-remote",
  /** 个人文件（`visibility='private'`，管理者甲登记的）：钉住 D-55 的可见范围 */
  filePrivate: "file-private",
  reportSubmitted: "report-submitted",
  // 贝塔组的业务数据（最小一批，用来验证隔离）
  taskOfB: "t-of-b",
  todoOfB: "todo-b",
  noteOfB: "note-b",
  fileOfB: "file-b",
  reportOfB: "report-b",
} as const;

export type Fixture = {
  directory: string;
  databasePath: string;
  uploadsDir: string;
  /** 种子数据的固定 id，供用例引用 */
  ids: typeof IDS;
};

/* ------------------------------------------------------------------ 密码哈希 */

/**
 * 夹具用 scrypt 参数：**必须与 `server/src/security/password.ts` 保持一致**
 * （`N=16384, r=8, p=1, keylen=64`，16 字节盐，存储格式 `scrypt$N$r$p$salt$hash`）。
 */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEM = 64 * 1024 * 1024;

/**
 * 同步版密码哈希。
 *
 * `password.ts` 的 `hashPassword` 是异步的（scrypt 回调包成 Promise），而 `createFixture()`
 * 必须保持**同步**：capture / compare / smoke-ui 三个调用方都在同步位置调用它，
 * 而它们属于公共工具、本轮改造不归夹具工作流改。因此这里用 `scryptSync` 复刻同一格式，
 * 参数与格式串对齐 `password.ts`（上面那组常量），登录时能被 `verifyPassword` 正常校验。
 * 盐由密码派生：夹具是确定性种子库，不追求盐的随机性，只求每次跑出来的库完全一致。
 */
function hashPasswordSync(password: string): string {
  const salt = createHash("sha256").update(`contract-fixture:${password}`).digest().subarray(0, SALT_LENGTH);
  const key = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEM });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/* ------------------------------------------------------------------ 种子清单 */

export type SeedOrganization = {
  id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  archivedAt: string | null;
};

export type SeedAccount = {
  key: AccountKey;
  id: string;
  name: string;
  role: "admin" | "manager" | "member";
  orgId: string | null;
  mustChange: 0 | 1;
};

type SeedTask = {
  id: string;
  orgId: string;
  title: string;
  priority: "P0" | "P1" | "P2";
  status: "todo" | "in_progress" | "pending_review" | "completed";
  progress: number;
  dueDate: string | null;
  ownerId: string;
  createdBy: string;
  isPrivate: number;
  archivedAt: string | null;
};

type SeedReport = { id: string; orgId: string; ownerId: string; note: string; fileId: string; originalName: string };

/** 两个可用组织 + 一个已解散组织（列表差异与归档不变式都要靠它） */
export const SEED_ORGANIZATIONS: readonly SeedOrganization[] = [
  { id: IDS.orgAlpha, name: "阿尔法组", description: "契约夹具：主力组织，业务数据齐全", status: "active", archivedAt: null },
  { id: IDS.orgBeta, name: "贝塔组", description: "契约夹具：跨组织隔离的对照组", status: "active", archivedAt: null },
  { id: IDS.orgArchived, name: "伽马组", description: "契约夹具：已解散组织", status: "archived", archivedAt: ARCHIVED_STAMP },
];

export const SEED_ACCOUNTS: readonly SeedAccount[] = [
  { key: "admin", id: IDS.userAdmin, name: "管理员", role: "admin", orgId: null, mustChange: 0 },
  { key: "managerA", id: IDS.userManagerA, name: "阿尔法管理者", role: "manager", orgId: IDS.orgAlpha, mustChange: 0 },
  { key: "memberA", id: IDS.userMemberA, name: "阿尔法成员甲", role: "member", orgId: IDS.orgAlpha, mustChange: 0 },
  { key: "memberA2", id: IDS.userMemberA2, name: "阿尔法成员乙", role: "member", orgId: IDS.orgAlpha, mustChange: 0 },
  { key: "managerB", id: IDS.userManagerB, name: "贝塔管理者", role: "manager", orgId: IDS.orgBeta, mustChange: 0 },
  { key: "memberB", id: IDS.userMemberB, name: "贝塔成员", role: "member", orgId: IDS.orgBeta, mustChange: 0 },
  { key: "noOrg", id: IDS.userNoOrg, name: "待入组用户", role: "member", orgId: null, mustChange: 0 },
  { key: "mustChange", id: IDS.userMustChange, name: "待改密用户", role: "member", orgId: IDS.orgAlpha, mustChange: 1 },
];

const SEED_TASKS: readonly SeedTask[] = [
  // 阿尔法组：待办 / 进行中 / 待验收 / 已完成 / 已归档 / 私密 / 逾期（原夹具那一批）
  {
    id: IDS.taskTodo,
    orgId: IDS.orgAlpha,
    title: "待办任务",
    priority: "P1",
    status: "todo",
    progress: 0,
    dueDate: null,
    ownerId: IDS.userMemberA,
    createdBy: IDS.userManagerA,
    isPrivate: 0,
    archivedAt: null,
  },
  {
    id: IDS.taskDoing,
    orgId: IDS.orgAlpha,
    title: "进行中任务",
    priority: "P0",
    status: "in_progress",
    progress: 40,
    dueDate: "2026-09-30",
    ownerId: IDS.userMemberA,
    createdBy: IDS.userManagerA,
    isPrivate: 0,
    archivedAt: null,
  },
  {
    id: IDS.taskReview,
    orgId: IDS.orgAlpha,
    title: "待验收任务",
    priority: "P1",
    status: "pending_review",
    progress: 100,
    dueDate: "2026-09-30",
    ownerId: IDS.userMemberA,
    createdBy: IDS.userManagerA,
    isPrivate: 0,
    archivedAt: null,
  },
  {
    id: IDS.taskDone,
    orgId: IDS.orgAlpha,
    title: "已完成任务",
    priority: "P2",
    status: "completed",
    progress: 100,
    dueDate: "2026-09-10",
    ownerId: IDS.userMemberA,
    createdBy: IDS.userManagerA,
    isPrivate: 0,
    archivedAt: null,
  },
  {
    id: IDS.taskArchived,
    orgId: IDS.orgAlpha,
    title: "已归档任务",
    priority: "P1",
    status: "todo",
    progress: 0,
    dueDate: null,
    ownerId: IDS.userManagerA,
    createdBy: IDS.userManagerA,
    isPrivate: 0,
    archivedAt: ARCHIVED_STAMP,
  },
  {
    id: IDS.taskPrivate,
    orgId: IDS.orgAlpha,
    title: "私密任务",
    priority: "P2",
    status: "todo",
    progress: 0,
    dueDate: null,
    ownerId: IDS.userManagerA,
    createdBy: IDS.userManagerA,
    isPrivate: 1,
    archivedAt: null,
  },
  {
    id: IDS.taskOverdue,
    orgId: IDS.orgAlpha,
    title: "逾期任务",
    priority: "P0",
    status: "todo",
    progress: 10,
    dueDate: "2020-01-01",
    ownerId: IDS.userMemberA,
    createdBy: IDS.userManagerA,
    isPrivate: 0,
    archivedAt: null,
  },
  // 同组织里另一个成员的任务：验证「member 只看自己负责的」
  {
    id: IDS.taskOfA2,
    orgId: IDS.orgAlpha,
    title: "成员乙的任务",
    priority: "P1",
    status: "todo",
    progress: 0,
    dueDate: null,
    ownerId: IDS.userMemberA2,
    createdBy: IDS.userManagerA,
    isPrivate: 0,
    archivedAt: null,
  },
  // 贝塔组：跨组织隔离的对照组
  {
    id: IDS.taskOfB,
    orgId: IDS.orgBeta,
    title: "贝塔任务",
    priority: "P1",
    status: "todo",
    progress: 0,
    dueDate: null,
    ownerId: IDS.userMemberB,
    createdBy: IDS.userManagerB,
    isPrivate: 0,
    archivedAt: null,
  },
];

/** [id, 收件人, 触发者, 关联任务] —— 让通知域也有跨组织可比对的非空数据 */
const SEED_NOTIFICATIONS: ReadonlyArray<readonly [string, string, string, string]> = [
  ["notif-a1", IDS.userMemberA, IDS.userManagerA, IDS.taskTodo],
  ["notif-b1", IDS.userMemberB, IDS.userManagerB, IDS.taskOfB],
];

const SEED_REPORTS: readonly SeedReport[] = [
  {
    id: IDS.reportSubmitted,
    orgId: IDS.orgAlpha,
    ownerId: IDS.userMemberA,
    note: "第八周",
    fileId: "rf-1",
    originalName: "第八周周报.docx",
  },
  {
    id: IDS.reportOfB,
    orgId: IDS.orgBeta,
    ownerId: IDS.userMemberB,
    note: "贝塔第八周",
    fileId: "rf-b1",
    originalName: "贝塔第八周周报.docx",
  },
];

/* ------------------------------------------------------------------ 建库 */

/**
 * 建立确定性种子库：固定 id、固定时间戳、固定内容、**两个组织 + 一个无组织账号**。
 * 只依赖 node:sqlite 与 server/src/db（均为框架无关代码），迁移前后都可用。
 */
export function createFixture(): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-contract-"));
  const databasePath = path.join(directory, "workbench.sqlite");
  const uploadsDir = path.join(directory, "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });

  const client = createDatabaseClient({ databasePath, readOnly: false, migrationsDirectory: MIGRATIONS_DIR });
  const db = client.getDatabase();

  const insertUser = db.prepare(
    "INSERT INTO users(id,username,email,name,role,org_id,password_hash,must_change_password,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)",
  );
  const insertOrg = db.prepare(
    "INSERT INTO organizations(id,name,description,status,created_by,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,?,?,?)",
  );
  const insertAccount = (account: SeedAccount): void => {
    const credential = ACCOUNTS[account.key];
    // `noOrg` 是 `role='member'` 且 `org_id IS NULL` 的账号：D-20/D-24 的注册流程产生的就是这种行
    // （009 里那条 `CHECK (role = 'admin' OR org_id IS NOT NULL)` 因为会让每次注册都失败已删除，
    // 组织归属改由应用层保证），所以这里直接插即可，不需要任何绕行。
    insertUser.run(
      account.id,
      credential.username,
      // 邮箱沿用迁移的占位风格（RFC 2606 保留 TLD）：唯一且不可达
      `${credential.username}@local.invalid`,
      account.name,
      account.role,
      account.orgId,
      hashPasswordSync(credential.password),
      account.mustChange,
      STAMP,
      STAMP,
    );
  };

  // 顺序是刚需：organizations.created_by 引用 users(id)，而 users.org_id 又引用 organizations(id)。
  // 管理员不隶属组织（org_id 为 NULL），所以先插它，再插组织，最后插其余账号。
  const firstAdmin = SEED_ACCOUNTS.find((account) => account.role === "admin");
  if (!firstAdmin) throw new Error("夹具必须有一个全局管理员账号（organizations.created_by 需要它）");
  insertAccount(firstAdmin);

  for (const org of SEED_ORGANIZATIONS) {
    insertOrg.run(org.id, org.name, org.description, org.status, firstAdmin.id, STAMP, STAMP, org.archivedAt);
  }

  for (const account of SEED_ACCOUNTS) {
    if (account.id !== firstAdmin.id) insertAccount(account);
  }

  const insertTask = db.prepare(
    "INSERT INTO tasks(id,org_id,title,description,priority,status,progress,due_date,owner_id,created_by,source,is_private,created_at,updated_at,completed_at,archived_at,wecom_fingerprint,overdue_notified_at) VALUES(?,?,?,'',?,?,?,?,?,?,'manual',?,?,?,?,?,NULL,NULL)",
  );
  for (const task of SEED_TASKS) {
    insertTask.run(
      task.id,
      task.orgId,
      task.title,
      task.priority,
      task.status,
      task.progress,
      task.dueDate,
      task.ownerId,
      task.createdBy,
      task.isPrivate,
      STAMP,
      STAMP,
      task.status === "completed" ? STAMP : null,
      task.archivedAt,
    );
  }

  db.prepare(
    "INSERT INTO task_progress_logs(id,task_id,author_id,author_name,content,progress_snapshot,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run("log-1", IDS.taskDoing, IDS.userMemberA, "阿尔法成员甲", "已完成一半", 40, STAMP);
  db.prepare("INSERT INTO task_comments(id,task_id,author_id,author_name,author_role,content,created_at) VALUES(?,?,?,?,?,?,?)").run(
    "comment-1",
    IDS.taskDoing,
    IDS.userManagerA,
    "阿尔法管理者",
    "manager",
    "请补充报价单",
    STAMP,
  );
  db.prepare("INSERT INTO task_events(id,task_id,actor_id,actor_name,event_type,content,created_at) VALUES(?,?,?,?,?,?,?)").run(
    "event-1",
    IDS.taskDoing,
    IDS.userManagerA,
    "阿尔法管理者",
    "task_created",
    "创建任务",
    STAMP,
  );

  const insertNotification = db.prepare(
    "INSERT INTO notifications(id,recipient_id,actor_id,task_id,report_id,event_type,title,message,is_read,created_at,read_at) VALUES(?,?,?,?,NULL,'task_assigned',?,?,0,?,NULL)",
  );
  for (const [id, recipientId, actorId, taskId] of SEED_NOTIFICATIONS) {
    insertNotification.run(id, recipientId, actorId, taskId, "收到新任务", "有一项新任务指派给你", STAMP);
  }

  // 待办 / 随手记自 D-54 起是**本人数据**（迁移 017 的 `owner_id`）：夹具必须给出归属人，
  // 否则（owner_id 为 NULL）按「归属字段为空 = 谁都不属于」的口径一条都读不到，用例会全红。
  // 刻意让 `todoOpen` 归**成员甲**、`noteOne` 归**成员甲**：同组织的管理者既看也改不动它们，
  // 这正是「本人数据」最容易写错的一侧（跨组织 404 由另一批用例覆盖）。
  const insertTodo = db.prepare(
    "INSERT INTO todos(id,org_id,owner_id,content,todo_date,is_completed,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,0,NULL,?,?)",
  );
  insertTodo.run(IDS.todoOpen, IDS.orgAlpha, IDS.userMemberA, "跟进报价", "2026-09-01", STAMP, STAMP);
  insertTodo.run(IDS.todoOfB, IDS.orgBeta, IDS.userMemberB, "贝塔跟进", "2026-09-01", STAMP, STAMP);

  const insertNote = db.prepare("INSERT INTO notes(id,org_id,owner_id,content,is_pinned,created_at,updated_at) VALUES(?,?,?,?,0,?,?)");
  insertNote.run(IDS.noteOne, IDS.orgAlpha, IDS.userMemberA, "会议要点", STAMP, STAMP);
  insertNote.run(IDS.noteOfB, IDS.orgBeta, IDS.userMemberB, "贝塔会议要点", STAMP, STAMP);

  /**
   * 重要文件（D-55）：每行显式给 `owner_id` 与 `visibility`。
   * 夹具里刻意两种可见范围都有：
   * - `fileOne` / `fileOfB` 是**组织可见**（默认档，普通成员看得到也改得动）；
   * - `filePrivate` 是**个人文件**（管理者甲登记的），用来钉住「成员看不到 / 组织管理者看不到别人的
   *   个人文件 / 全局管理员看得到但只在**本组织**内 / 创建人自己可改可删」这四件事。
   */
  const insertFile = db.prepare(
    "INSERT INTO important_files(id,org_id,owner_id,visibility,name,file_path,category,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,NULL,?,?)",
  );
  insertFile.run(
    IDS.fileOne,
    IDS.orgAlpha,
    IDS.userManagerA,
    "org",
    "报价单模板",
    "C:\\fixture\\quote-template.xlsx",
    "报价",
    STAMP,
    STAMP,
  );
  insertFile.run(IDS.fileRemote, IDS.orgAlpha, IDS.userManagerA, "org", "2026 报价单", "webdav:报价/2026报价单.xlsx", "报价", STAMP, STAMP);
  insertFile.run(
    IDS.filePrivate,
    IDS.orgAlpha,
    IDS.userManagerA,
    "private",
    "我的报价底稿",
    "C:\\fixture\\private-draft.xlsx",
    "报价",
    STAMP,
    STAMP,
  );
  insertFile.run(IDS.fileOfB, IDS.orgBeta, IDS.userManagerB, "org", "贝塔报价单", "C:\\fixture\\beta-quote.xlsx", "报价", STAMP, STAMP);

  const insertReport = db.prepare(
    "INSERT INTO weekly_reports(id,org_id,owner_id,period_start,period_end,doc_type,note,status,current_version,uploaded_by,review_note,created_at,updated_at,submitted_at,reviewed_at,returned_at) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,NULL,NULL)",
  );
  const insertReportFile = db.prepare(
    "INSERT INTO report_files(id,report_id,version,original_name,stored_name,size_bytes,ext,mime_type,uploaded_by,uploaded_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  for (const report of SEED_REPORTS) {
    insertReport.run(
      report.id,
      report.orgId,
      report.ownerId,
      "2026-08-24",
      "2026-08-30",
      "weekly_report",
      report.note,
      "submitted",
      1,
      report.ownerId,
      STAMP,
      STAMP,
      STAMP,
    );
    // 目录结构保持 data/uploads/reports/<reportId>/ 的形状：UPLOADS_DIR 已经指向 reports 那一层
    const storedName = "v1.docx";
    const reportDir = path.join(uploadsDir, report.id);
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, storedName), "fake-docx-v1");
    insertReportFile.run(
      report.fileId,
      report.id,
      1,
      report.originalName,
      storedName,
      12,
      ".docx",
      "application/msword",
      report.ownerId,
      STAMP,
    );
  }

  // 「周报上传」**共用管理员那份连接**（D-52）：契约与冒烟环境里也必须**有远端可写**，
  // 否则 POST /api/reports 会整体 503，上传/下载类用例就没有黑盒快照了。
  // 地址不在这张表里（来自 WEBDAV_URL，由 runner 注入假 NAS 的地址），这里只放凭据与浏览根；
  // 上传根目录**刻意不预置** `report_upload_settings`：不预置 = 跟随这份连接的浏览根目录（`/`），
  // 也正是「默认是根目录」这条口径，于是正文落在 `/<用户名>/<起止日期>/<文件名>`。
  db.prepare("INSERT INTO webdav_settings(user_id,username,password,root,timeout_ms,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(
    firstAdmin.id,
    "",
    "",
    "/",
    15000,
    STAMP,
    STAMP,
  );

  // 上传根目录**按组织**（D-53）：阿尔法配了 `/阿尔法`，贝塔**故意不配**。
  // 一份夹具同时钉住两条口径：配过的组织各写各的目录，没配的用连接的浏览根（`/`）。
  db.prepare("INSERT INTO report_upload_settings(org_id,root,updated_by,updated_at) VALUES(?,?,?,?)").run(
    IDS.orgAlpha,
    "/阿尔法",
    firstAdmin.id,
    STAMP,
  );

  db.close();
  return { directory, databasePath, uploadsDir, ids: IDS };
}

export function removeFixture(fixture: Fixture): void {
  try {
    fs.rmSync(fixture.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (error) {
    // 临时目录残留无害（系统会自行清 Temp），不要因此让整个验收流程失败
    console.warn(`临时夹具目录未能删除（可忽略）：${error instanceof Error ? error.message : String(error)}`);
  }
}

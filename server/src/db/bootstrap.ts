import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { LOCKED_PASSWORD_HASH } from "../security/password";

/**
 * 数据库自举：保证任何库里都成立「有一个全局管理员」+「有一个默认组织」这两个前提。
 *
 * 为什么需要它：009 迁移只在**已存在主人账号**的旧库上建 `org-default`（原因见 DATA_MODEL.md 记的那个坑），
 * 全新空库迁移完之后是「0 账号 + 0 组织」——系统里没有任何人能创建组织（`POST /api/organizations` 仅 admin 可用），
 * 也没有任何组织可供申请加入，等于开箱即坏。这里在应用启动、迁移之后把它补齐。
 *
 * 三条规则（D-39）：
 * 1. 已有管理员 → 只补组织（一个组织都没有时建 `org-default`，`created_by` 记该管理员）；
 * 2. 没有管理员 → 新建默认管理员 `admin`（`password_hash` 保持 `locked$` 占位，随机 id）再建组织；
 *    新管理员**不隶属组织**（D-26），首次登录前必须跑 `npm run user:init -- --confirm` 拿初始密码；
 * 3. 用户名 `admin` 已被普通账号占用（开放注册下确实可能）→ 什么都不做，不顶替别人的账号。
 *
 * 幂等：管理员与组织各自独立判存在性，重复执行不重复插入、不改动已有数据。
 *
 * 刻意**不**放进 `client.ts` 或迁移文件：夹具与契约工具都是「新建空库 → 自己插种子数据」的流程，
 * 在那里自举会插进一个 username=`admin` 的账号，与 `tools/contract/fixture.ts` 的夹具管理员撞唯一键。
 * 因此自举只挂在应用运行时（`app/lib/context.server.ts`）。
 */

export const DEFAULT_ADMIN_USERNAME = "admin";
export const DEFAULT_ADMIN_NAME = "主人";
export const DEFAULT_ORG_ID = "org-default";
export const DEFAULT_ORG_NAME = "默认组织";
/** RFC 2606 保留 TLD：占位、不可达（与 009 / json-migration 一致） */
const LOCAL_EMAIL_DOMAIN = "local.invalid";
const DEFAULT_ORG_DESCRIPTION = "初始化时自动创建：新库的默认组织，可改名";

export type BootstrapResult = {
  /** 本次新建了默认管理员 */
  createdAdmin: boolean;
  /** 本次新建了默认组织 */
  createdOrganization: boolean;
  /** 新建的管理员还没有密码：调用方应提示跑 `npm run user:init -- --confirm` */
  adminAwaitingPassword: boolean;
  /** 库里当前管理员的用户名；没有管理员时为 null */
  adminUsername: string | null;
};

/** 一个组织都没有时返回 undefined */
function firstOrganizationId(database: DatabaseSync): string | undefined {
  const row = database.prepare("SELECT id FROM organizations ORDER BY created_at, id LIMIT 1").get() as { id: string } | undefined;
  return row?.id;
}

function insertDefaultOrganization(database: DatabaseSync, createdBy: string, stamp: string): void {
  database
    .prepare(
      "INSERT INTO organizations(id,name,description,status,created_by,created_at,updated_at,archived_at) VALUES(?,?,?,'active',?,?,?,NULL)",
    )
    .run(DEFAULT_ORG_ID, DEFAULT_ORG_NAME, DEFAULT_ORG_DESCRIPTION, createdBy, stamp, stamp);
}

export function ensureDefaultAdminAndOrganization(database: DatabaseSync): BootstrapResult {
  database.exec("PRAGMA busy_timeout=5000");
  const existingAdmin = database.prepare("SELECT id, username FROM users WHERE role='admin' ORDER BY created_at, id LIMIT 1").get() as
    { id: string; username: string } | undefined;

  if (existingAdmin) {
    const settled: BootstrapResult = {
      createdAdmin: false,
      createdOrganization: false,
      adminAwaitingPassword: false,
      adminUsername: existingAdmin.username,
    };
    // 常见路径（生产库、夹具库）在这里就返回：不写库，也就不去抢写锁
    if (firstOrganizationId(database) !== undefined) return settled;

    const stamp = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      insertDefaultOrganization(database, existingAdmin.id, stamp);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return { ...settled, createdOrganization: true };
  }

  const usernameTaken = database.prepare("SELECT id FROM users WHERE username=?").get(DEFAULT_ADMIN_USERNAME) !== undefined;
  if (usernameTaken) {
    return { createdAdmin: false, createdOrganization: false, adminAwaitingPassword: false, adminUsername: null };
  }

  const adminId = randomUUID();
  const stamp = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        "INSERT INTO users(id,username,email,name,role,org_id,password_hash,must_change_password,is_active,created_at,updated_at) VALUES(?,?,?,?,'admin',NULL,?,1,1,?,?)",
      )
      .run(
        adminId,
        DEFAULT_ADMIN_USERNAME,
        `${DEFAULT_ADMIN_USERNAME}@${LOCAL_EMAIL_DOMAIN}`,
        DEFAULT_ADMIN_NAME,
        LOCKED_PASSWORD_HASH,
        stamp,
        stamp,
      );
    // 管理员的 org_id 必须为 NULL（D-26 / users 的 CHECK），所以默认组织挂在 created_by 上
    insertDefaultOrganization(database, adminId, stamp);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return {
    createdAdmin: true,
    createdOrganization: true,
    adminAwaitingPassword: true,
    adminUsername: DEFAULT_ADMIN_USERNAME,
  };
}

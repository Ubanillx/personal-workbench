import { ACCOUNTS, IDS, NEW_PASSWORDS } from "./fixture";

/**
 * 账号 key + 匿名。**账号 key 必须与 fixture.ts 的 `ACCOUNTS` 完全一致**：
 * `ACCOUNTS` 的类型就是 `Record<Exclude<Role, "anon">, { username, password }>`，
 * 所以在这里加一个账号 key 却忘了配登录凭据会直接编译报错。
 * runner 用 `ACCOUNTS[role]` 调 `POST /api/auth/login`（username + password）换会话；
 * `anon` = 不带 Cookie，用于验证 401 边界，没有凭据。
 */
export type Role = "admin" | "managerA" | "memberA" | "memberA2" | "managerB" | "memberB" | "noOrg" | "mustChange" | "anon";
export type Method = "GET" | "POST" | "PATCH" | "DELETE";

export type ContractCase = {
  name: string;
  /** anon = 不带 Cookie，用于验证 401 边界 */
  role: Role | "anon";
  method: Method;
  /** 支持 {{变量}} 占位，变量来自 fixture.ids 或前面用例的 capture */
  path: string;
  body?: unknown;
  /** 为该请求新建一个独立会话（用于 logout 这类会销毁会话的用例） */
  freshLogin?: boolean;
  /** 从响应体按点路径提取变量，供后续用例引用，例如 { taskId: "data.id" } */
  capture?: Record<string, string>;
  /** multipart 上传：表单字段 + 文件内容 */
  upload?: { fields: Record<string, string>; filename: string; content: string };
};

/**
 * 约 62 个端点 × 三角色 + 组织隔离与边界用例的契约清单。
 * 只描述"怎么请求"，不描述"期望什么"——期望值由当前实现录制成 golden。
 *
 * 三条容易踩的坑：
 * 1. `{{变量}}` 只在 **path** 里替换：runner 不替换请求体与 multipart 字段，
 *    所以请求体里引用固定 id 必须直接用 `IDS.xxx`（捕获来的变量则只能出现在 path 里）；
 * 2. 用例顺序即执行顺序，`capture` 出来的变量只能被后面的用例引用；
 * 3. 改成员状态（停用/降级/移出组织）会撤销该账号的会话、解散组织会退回全部成员，
 *    这类用例统一放在最后（收尾段），避免把前面角色的会话打废。
 */
export const CASES: ContractCase[] = [
  // ---------- health（3） ----------
  { name: "health.ping.anon", role: "anon", method: "GET", path: "/api/ping" },
  { name: "health.status.anon", role: "anon", method: "GET", path: "/api/health" },
  { name: "health.status.admin", role: "admin", method: "GET", path: "/api/health" },

  // ---------- auth：登录（5） ----------
  {
    name: "auth.login.admin",
    role: "anon",
    method: "POST",
    path: "/api/auth/login",
    body: { username: ACCOUNTS.admin.username, password: ACCOUNTS.admin.password },
  },
  {
    name: "auth.login.mustChange",
    role: "anon",
    method: "POST",
    path: "/api/auth/login",
    body: { username: ACCOUNTS.mustChange.username, password: ACCOUNTS.mustChange.password },
  },
  {
    name: "auth.login.wrong-password",
    role: "anon",
    method: "POST",
    path: "/api/auth/login",
    body: { username: ACCOUNTS.admin.username, password: "wrong-password-1" },
  },
  {
    name: "auth.login.unknown-user",
    role: "anon",
    method: "POST",
    path: "/api/auth/login",
    body: { username: "no-such-account", password: "whatever-pw-1" },
  },
  { name: "auth.login.missing-body", role: "anon", method: "POST", path: "/api/auth/login", body: {} },

  // ---------- auth：注册（5） ----------
  {
    name: "auth.register.ok",
    role: "anon",
    method: "POST",
    path: "/api/auth/register",
    body: { username: "contract-new", email: "contract-new@local.invalid", password: "contract-new-pw", name: "契约新人" },
  },
  {
    name: "auth.register.duplicate-username",
    role: "anon",
    method: "POST",
    path: "/api/auth/register",
    body: { username: ACCOUNTS.admin.username, email: "contract-dup-name@local.invalid", password: "contract-dup-pw", name: "重名" },
  },
  {
    name: "auth.register.duplicate-email",
    role: "anon",
    method: "POST",
    path: "/api/auth/register",
    body: { username: "contract-dup-mail", email: "admin@local.invalid", password: "contract-dup-pw", name: "重邮箱" },
  },
  {
    name: "auth.register.short-password",
    role: "anon",
    method: "POST",
    path: "/api/auth/register",
    body: { username: "contract-short", email: "contract-short@local.invalid", password: "short", name: "短密码" },
  },
  {
    name: "auth.register.bad-username",
    role: "anon",
    method: "POST",
    path: "/api/auth/register",
    body: { username: "a!", email: "contract-bad-name@local.invalid", password: "contract-bad-pw", name: "非法用户名" },
  },

  // ---------- auth：看自己（6，skipPasswordGate：强制改密时也要能读到身份） ----------
  { name: "auth.me.anon", role: "anon", method: "GET", path: "/api/auth/me" },
  { name: "auth.me.admin", role: "admin", method: "GET", path: "/api/auth/me" },
  { name: "auth.me.managerA", role: "managerA", method: "GET", path: "/api/auth/me" },
  { name: "auth.me.memberA", role: "memberA", method: "GET", path: "/api/auth/me" },
  { name: "auth.me.noOrg", role: "noOrg", method: "GET", path: "/api/auth/me" },
  { name: "auth.me.mustChange", role: "mustChange", method: "GET", path: "/api/auth/me" },

  // ---------- auth：强制改密门禁 → 改密 → 门禁解除（9） ----------
  // 门禁必须排在任何改密用例之前：mustChange 改完密码就没有门禁了
  { name: "auth.gate.tasks.mustChange", role: "mustChange", method: "GET", path: "/api/tasks" },
  { name: "auth.gate.organizations.mustChange", role: "mustChange", method: "GET", path: "/api/organizations" },
  {
    name: "auth.password.anon",
    role: "anon",
    method: "POST",
    path: "/api/auth/password",
    body: { currentPassword: "x", newPassword: "whatever-pw-1" },
  },
  {
    name: "auth.password.wrong-current.memberA",
    role: "memberA",
    method: "POST",
    path: "/api/auth/password",
    body: { currentPassword: "wrong-password-1", newPassword: NEW_PASSWORDS.memberA },
  },
  {
    name: "auth.password.too-short.memberA",
    role: "memberA",
    method: "POST",
    path: "/api/auth/password",
    body: { currentPassword: ACCOUNTS.memberA.password, newPassword: "short" },
  },
  {
    name: "auth.password.ok.mustChange",
    role: "mustChange",
    method: "POST",
    path: "/api/auth/password",
    body: { currentPassword: ACCOUNTS.mustChange.password, newPassword: NEW_PASSWORDS.mustChange },
  },
  {
    name: "auth.login.mustChange.new-password",
    role: "anon",
    method: "POST",
    path: "/api/auth/login",
    body: { username: ACCOUNTS.mustChange.username, password: NEW_PASSWORDS.mustChange },
  },
  {
    name: "auth.login.mustChange.old-password",
    role: "anon",
    method: "POST",
    path: "/api/auth/login",
    body: { username: ACCOUNTS.mustChange.username, password: ACCOUNTS.mustChange.password },
  },
  // 改完密码后门禁应当解除：同一个会话再打业务端点就是 200
  { name: "auth.gate.tasks.mustChange.after-change", role: "mustChange", method: "GET", path: "/api/tasks" },

  // ---------- access-info（3，仅 admin 可见） ----------
  { name: "access-info.admin", role: "admin", method: "GET", path: "/api/access-info" },
  { name: "access-info.managerA", role: "managerA", method: "GET", path: "/api/access-info" },
  { name: "access-info.memberA", role: "memberA", method: "GET", path: "/api/access-info" },

  // ---------- dashboard（5） ----------
  { name: "dashboard.admin", role: "admin", method: "GET", path: "/api/dashboard" },
  { name: "dashboard.managerA", role: "managerA", method: "GET", path: "/api/dashboard" },
  { name: "dashboard.memberA", role: "memberA", method: "GET", path: "/api/dashboard" },
  { name: "dashboard.memberB", role: "memberB", method: "GET", path: "/api/dashboard" },
  { name: "dashboard.noOrg", role: "noOrg", method: "GET", path: "/api/dashboard" },

  // ---------- 组织与成员：只读列表（15，全部排在写操作之前） ----------
  { name: "org.list.anon", role: "anon", method: "GET", path: "/api/organizations" },
  { name: "org.list.admin", role: "admin", method: "GET", path: "/api/organizations" },
  { name: "org.list.managerA", role: "managerA", method: "GET", path: "/api/organizations" },
  { name: "org.list.managerB", role: "managerB", method: "GET", path: "/api/organizations" },
  { name: "org.list.memberA", role: "memberA", method: "GET", path: "/api/organizations" },
  { name: "org.list.memberB", role: "memberB", method: "GET", path: "/api/organizations" },
  { name: "org.list.noOrg", role: "noOrg", method: "GET", path: "/api/organizations" },
  { name: "members.list.anon", role: "anon", method: "GET", path: "/api/members" },
  { name: "members.list.admin", role: "admin", method: "GET", path: "/api/members" },
  { name: "members.list.managerA", role: "managerA", method: "GET", path: "/api/members" },
  { name: "members.list.memberA", role: "memberA", method: "GET", path: "/api/members" },
  { name: "members.list.noOrg", role: "noOrg", method: "GET", path: "/api/members" },
  { name: "org.members.list.admin", role: "admin", method: "GET", path: "/api/organizations/{{orgAlpha}}/members" },
  { name: "org.members.list.managerA", role: "managerA", method: "GET", path: "/api/organizations/{{orgAlpha}}/members" },
  { name: "org.members.list.managerB.cross-org", role: "managerB", method: "GET", path: "/api/organizations/{{orgAlpha}}/members" },

  // ---------- 组织：创建与改名（9） ----------
  { name: "org.create.anon", role: "anon", method: "POST", path: "/api/organizations", body: { name: "契约匿名组织" } },
  { name: "org.create.managerA", role: "managerA", method: "POST", path: "/api/organizations", body: { name: "契约管理者组织" } },
  { name: "org.create.memberA", role: "memberA", method: "POST", path: "/api/organizations", body: { name: "契约成员组织" } },
  { name: "org.create.admin.no-name", role: "admin", method: "POST", path: "/api/organizations", body: {} },
  { name: "org.create.admin.duplicate-name", role: "admin", method: "POST", path: "/api/organizations", body: { name: "阿尔法组" } },
  {
    name: "org.create.admin",
    role: "admin",
    method: "POST",
    path: "/api/organizations",
    body: { name: "契约新组织", description: "契约用例创建的组织" },
    capture: { orgNew: "data.id" },
  },
  // 改名只改描述，避免影响前面已经录过的组织名快照
  {
    name: "org.patch.managerA.self",
    role: "managerA",
    method: "PATCH",
    path: "/api/organizations/{{orgAlpha}}",
    body: { description: "阿尔法组描述（契约更新）" },
  },
  {
    name: "org.patch.managerA.cross-org",
    role: "managerA",
    method: "PATCH",
    path: "/api/organizations/{{orgBeta}}",
    body: { name: "想改贝塔组" },
  },
  {
    name: "org.patch.memberA",
    role: "memberA",
    method: "PATCH",
    path: "/api/organizations/{{orgAlpha}}",
    body: { name: "成员想改组织名" },
  },

  // ---------- 组织：拉人入组（8，D-31 直接拉入，无需本人同意） ----------
  // noOrg 是唯一「无组织且可用」的账号，因此「拉入 → 移出」走两遍（管理者一次、管理员一次），
  // 最后必须让它回到「无组织」，后面的入组申请流程要用
  {
    name: "org.invite.memberA",
    role: "memberA",
    method: "POST",
    path: "/api/organizations/{{orgAlpha}}/invite",
    body: { userId: IDS.userNoOrg },
  },
  {
    name: "org.invite.managerB.cross-org",
    role: "managerB",
    method: "POST",
    path: "/api/organizations/{{orgAlpha}}/invite",
    body: { userId: IDS.userNoOrg },
  },
  {
    name: "org.invite.admin.archived-org",
    role: "admin",
    method: "POST",
    path: "/api/organizations/{{orgArchived}}/invite",
    body: { userId: IDS.userNoOrg },
  },
  {
    name: "org.invite.managerA.already-in-org",
    role: "managerA",
    method: "POST",
    path: "/api/organizations/{{orgAlpha}}/invite",
    body: { userId: IDS.userMemberB },
  },
  {
    name: "org.invite.managerA",
    role: "managerA",
    method: "POST",
    path: "/api/organizations/{{orgAlpha}}/invite",
    body: { userId: IDS.userNoOrg },
  },
  { name: "org.members.list.managerA.after-invite", role: "managerA", method: "GET", path: "/api/organizations/{{orgAlpha}}/members" },
  { name: "org.members.delete.managerA.invited", role: "managerA", method: "DELETE", path: "/api/members/{{userNoOrg}}" },
  {
    name: "org.invite.admin",
    role: "admin",
    method: "POST",
    path: "/api/organizations/{{orgNew}}/invite",
    body: { userId: IDS.userNoOrg },
  },

  // ---------- 入组申请 → 审批（17，D-24 / D-30） ----------
  { name: "org.members.list.admin.new-org", role: "admin", method: "GET", path: "/api/organizations/{{orgNew}}/members" },
  { name: "org.members.delete.admin.invited", role: "admin", method: "DELETE", path: "/api/members/{{userNoOrg}}" },
  {
    name: "org.join.request.noOrg",
    role: "noOrg",
    method: "POST",
    path: "/api/join-requests",
    body: { orgId: IDS.orgAlpha, message: "想加入阿尔法组" },
    capture: { joinRequest: "data.id" },
  },
  { name: "org.join.request.noOrg.duplicate", role: "noOrg", method: "POST", path: "/api/join-requests", body: { orgId: IDS.orgBeta } },
  {
    name: "org.join.request.memberA.already-in-org",
    role: "memberA",
    method: "POST",
    path: "/api/join-requests",
    body: { orgId: IDS.orgBeta },
  },
  { name: "org.join.request.admin", role: "admin", method: "POST", path: "/api/join-requests", body: { orgId: IDS.orgAlpha } },
  {
    name: "org.join.request.noOrg.archived-org",
    role: "noOrg",
    method: "POST",
    path: "/api/join-requests",
    body: { orgId: IDS.orgArchived },
  },
  { name: "org.join-requests.list.admin", role: "admin", method: "GET", path: "/api/join-requests" },
  { name: "org.join-requests.list.admin.pending", role: "admin", method: "GET", path: "/api/join-requests?status=pending" },
  { name: "org.join-requests.list.managerA", role: "managerA", method: "GET", path: "/api/join-requests" },
  { name: "org.join-requests.list.managerB.cross-org", role: "managerB", method: "GET", path: "/api/join-requests" },
  { name: "org.join-requests.list.noOrg", role: "noOrg", method: "GET", path: "/api/join-requests" },
  { name: "org.join-requests.cancel.memberA", role: "memberA", method: "DELETE", path: "/api/join-requests/{{joinRequest}}" },
  { name: "org.join-requests.cancel.noOrg", role: "noOrg", method: "DELETE", path: "/api/join-requests/{{joinRequest}}" },
  { name: "org.join-requests.cancel.noOrg.again", role: "noOrg", method: "DELETE", path: "/api/join-requests/{{joinRequest}}" },
  {
    name: "org.join.request.noOrg.again",
    role: "noOrg",
    method: "POST",
    path: "/api/join-requests",
    body: { orgId: IDS.orgAlpha, message: "撤回后重新申请" },
    capture: { joinRequest2: "data.id" },
  },
  {
    name: "org.join-requests.approve.managerB.cross-org",
    role: "managerB",
    method: "POST",
    path: "/api/join-requests/{{joinRequest2}}/approve",
    body: {},
  },

  // ---------- 入组申请：拒绝 → 再申请 → 通过（4） ----------
  {
    name: "org.join-requests.reject.managerA",
    role: "managerA",
    method: "POST",
    path: "/api/join-requests/{{joinRequest2}}/reject",
    body: { note: "名额已满" },
  },
  {
    name: "org.join.request.noOrg.third",
    role: "noOrg",
    method: "POST",
    path: "/api/join-requests",
    body: { orgId: IDS.orgAlpha, message: "被拒后再申请" },
    capture: { joinRequest3: "data.id" },
  },
  {
    name: "org.join-requests.approve.admin",
    role: "admin",
    method: "POST",
    path: "/api/join-requests/{{joinRequest3}}/approve",
    body: { note: "同意加入" },
  },
  { name: "org.members.list.managerA.after-join", role: "managerA", method: "GET", path: "/api/organizations/{{orgAlpha}}/members" },

  // ---------- 退出申请 → 审批（7，D-32 + 最后一名管理者保护） ----------
  {
    name: "org.leave.request.noOrg",
    role: "noOrg",
    method: "POST",
    path: "/api/leave-requests",
    body: { message: "想退出组织" },
    capture: { leaveRequest: "data.id" },
  },
  { name: "org.leave.request.noOrg.duplicate", role: "noOrg", method: "POST", path: "/api/leave-requests", body: {} },
  { name: "org.leave.request.admin", role: "admin", method: "POST", path: "/api/leave-requests", body: {} },
  { name: "org.leave.request.managerA.last-manager", role: "managerA", method: "POST", path: "/api/leave-requests", body: {} },
  { name: "org.join-requests.list.managerA.pending", role: "managerA", method: "GET", path: "/api/join-requests?status=pending" },
  {
    name: "org.leave.approve.managerB.cross-org",
    role: "managerB",
    method: "POST",
    path: "/api/join-requests/{{leaveRequest}}/approve",
    body: {},
  },
  {
    name: "org.leave.approve.managerA",
    role: "managerA",
    method: "POST",
    path: "/api/join-requests/{{leaveRequest}}/approve",
    body: { note: "同意退出" },
  },

  // ---------- tasks 读（可见性：admin 全部组织 / manager 本组织 / member 只看自己负责的） ----------
  { name: "tasks.list.anon", role: "anon", method: "GET", path: "/api/tasks" },
  { name: "tasks.list.admin", role: "admin", method: "GET", path: "/api/tasks" },
  { name: "tasks.list.admin.org-filter", role: "admin", method: "GET", path: "/api/tasks?org={{orgAlpha}}" },
  { name: "tasks.list.admin.archived", role: "admin", method: "GET", path: "/api/tasks?includeArchived=1" },
  { name: "tasks.list.managerA", role: "managerA", method: "GET", path: "/api/tasks" },
  { name: "tasks.list.managerA.archived", role: "managerA", method: "GET", path: "/api/tasks?includeArchived=1" },
  { name: "tasks.list.managerA.status", role: "managerA", method: "GET", path: "/api/tasks?status=pending_review" },
  { name: "tasks.list.memberA", role: "memberA", method: "GET", path: "/api/tasks" },
  { name: "tasks.list.memberA2", role: "memberA2", method: "GET", path: "/api/tasks" },
  { name: "tasks.list.managerB", role: "managerB", method: "GET", path: "/api/tasks" },
  { name: "tasks.list.memberB", role: "memberB", method: "GET", path: "/api/tasks" },
  { name: "tasks.list.noOrg", role: "noOrg", method: "GET", path: "/api/tasks" },

  // ---------- tasks 写 ----------
  {
    name: "tasks.create.admin",
    role: "admin",
    method: "POST",
    path: "/api/tasks",
    body: {
      title: "契约-管理员建阿尔法任务",
      orgId: IDS.orgAlpha,
      ownerId: IDS.userMemberA,
      priority: "P1",
      dueDate: "2026-12-31",
      description: "契约用例",
    },
    capture: { taskCreated: "data.id" },
  },
  // 管理员是全局角色：跨组织建任务必须显式指定 orgId（写进别的组织是合法的）
  {
    name: "tasks.create.admin.beta",
    role: "admin",
    method: "POST",
    path: "/api/tasks",
    body: { title: "契约-管理员建贝塔任务", orgId: IDS.orgBeta, ownerId: IDS.userMemberB, priority: "P1" },
    capture: { taskOfBNew: "data.id" },
  },
  { name: "tasks.create.admin.no-org", role: "admin", method: "POST", path: "/api/tasks", body: { title: "契约-管理员没指定组织" } },
  // 管理员发布、**组织管理者负责**的任务：用来钉「执行者不能验收自己负责的任务」（D-57）。
  // 发布人 ≠ 负责人是这条用例的前提——负责人自己发布的活不会进验收流程（见 tasks.progress.memberA.own-task）。
  {
    name: "tasks.create.admin.for-manager",
    role: "admin",
    method: "POST",
    path: "/api/tasks",
    body: { title: "契约-管理员派给管理者的任务", orgId: IDS.orgAlpha, ownerId: IDS.userManagerA, priority: "P1" },
    capture: { taskManagerExec: "data.id" },
  },
  {
    name: "tasks.create.managerA",
    role: "managerA",
    method: "POST",
    path: "/api/tasks",
    body: { title: "契约-管理者建任务", ownerId: IDS.userMemberA2, priority: "P1" },
    capture: { taskByManager: "data.id" },
  },
  {
    name: "tasks.create.managerA.cross-org-owner",
    role: "managerA",
    method: "POST",
    path: "/api/tasks",
    body: { title: "契约-跨组织指派", ownerId: IDS.userMemberB },
  },
  {
    name: "tasks.create.managerA.private",
    role: "managerA",
    method: "POST",
    path: "/api/tasks",
    body: { title: "契约-管理者私密任务", isPrivate: true },
    capture: { taskPrivateManager: "data.id" },
  },
  // D-54 起私密任务的**负责人可以是别人**（发布人 ≠ 负责人，两个角色这时才真的分得开）：
  // 管理者把私密任务派给成员乙，用来验证「负责人可见 / 同组织其他成员不可见 / 组织管理者不可见」
  {
    name: "tasks.create.managerA.private.other-owner",
    role: "managerA",
    method: "POST",
    path: "/api/tasks",
    body: { title: "契约-派给成员乙的私密任务", isPrivate: true, ownerId: IDS.userMemberA2 },
    capture: { taskPrivateAssigned: "data.id" },
  },
  { name: "tasks.create.managerA.no-title", role: "managerA", method: "POST", path: "/api/tasks", body: {} },
  {
    name: "tasks.create.memberA",
    role: "memberA",
    method: "POST",
    path: "/api/tasks",
    body: { title: "契约-成员甲建任务" },
    capture: { taskByMember: "data.id" },
  },
  // member 只能建给自己的：body 里的 ownerId 会被忽略
  {
    name: "tasks.create.memberA.other-owner",
    role: "memberA",
    method: "POST",
    path: "/api/tasks",
    body: { title: "契约-成员甲想指派给别人", ownerId: IDS.userMemberA2 },
  },
  // member 不能建私密任务（isPrivate 只在管理员/管理者手里生效）
  {
    name: "tasks.create.memberA.private",
    role: "memberA",
    method: "POST",
    path: "/api/tasks",
    body: { title: "契约-成员甲想建私密任务", isPrivate: true },
  },
  {
    name: "tasks.create.managerB",
    role: "managerB",
    method: "POST",
    path: "/api/tasks",
    body: { title: "契约-贝塔管理者建任务", ownerId: IDS.userMemberB },
  },
  { name: "tasks.create.noOrg", role: "noOrg", method: "POST", path: "/api/tasks", body: { title: "契约-未入组创建任务" } },
  {
    name: "tasks.create.managerA.to-delete",
    role: "managerA",
    method: "POST",
    path: "/api/tasks",
    body: { title: "契约-待删除" },
    capture: { taskDel: "data.id" },
  },

  // ---------- 任务：改元信息（跨组织一律 404） ----------
  {
    name: "tasks.patch.managerA",
    role: "managerA",
    method: "PATCH",
    path: "/api/tasks/{{taskCreated}}",
    body: { title: "契约-改名", priority: "P2" },
  },
  {
    name: "tasks.patch.managerA.reject-progress",
    role: "managerA",
    method: "PATCH",
    path: "/api/tasks/{{taskCreated}}",
    body: { progress: 50 },
  },
  {
    name: "tasks.patch.managerA.bad-owner",
    role: "managerA",
    method: "PATCH",
    path: "/api/tasks/{{taskCreated}}",
    body: { ownerId: "no-such-user" },
  },
  {
    name: "tasks.patch.managerA.cross-org-owner",
    role: "managerA",
    method: "PATCH",
    path: "/api/tasks/{{taskCreated}}",
    body: { ownerId: IDS.userMemberB },
  },
  {
    name: "tasks.patch.managerA.archived",
    role: "managerA",
    method: "PATCH",
    path: "/api/tasks/{{taskArchived}}",
    body: { title: "改归档任务" },
  },
  // 私密任务的「私密开关」与「负责人」是可见性规则的两个输入（D-54）：管理者不是发布人，
  // 因此他改不动这两项（403）——否则他可以把别人的私密任务改成公开，或把负责人换成自己。
  // 而且他**先**卡在「看不见这条任务」这道门上：写操作与读操作用的是同一个 `canView`。
  {
    name: "tasks.patch.managerA.private.others-reassign",
    role: "managerA",
    method: "PATCH",
    path: "/api/tasks/{{taskPrivate}}",
    body: { ownerId: IDS.userMemberA2 },
  },
  {
    name: "tasks.patch.managerA.private.unprivate",
    role: "managerA",
    method: "PATCH",
    path: "/api/tasks/{{taskPrivate}}",
    body: { isPrivate: false },
  },
  // 发布人（创建者）改得动自己那条私密任务的负责人
  {
    name: "tasks.patch.managerA.private.own-reassign",
    role: "managerA",
    method: "PATCH",
    path: "/api/tasks/{{taskPrivateManager}}",
    body: { ownerId: IDS.userMemberA },
  },
  // 改回原状：后面 comments.* 还把这条当成「管理者自己发布的私密任务」用
  {
    name: "tasks.patch.managerA.private.own-reassign-back",
    role: "managerA",
    method: "PATCH",
    path: "/api/tasks/{{taskPrivateManager}}",
    body: { ownerId: IDS.userManagerA },
  },
  {
    name: "tasks.patch.memberA",
    role: "memberA",
    method: "PATCH",
    path: "/api/tasks/{{taskCreated}}",
    body: { title: "契约-成员改元信息" },
  },
  {
    name: "tasks.patch.managerB.cross-org",
    role: "managerB",
    method: "PATCH",
    path: "/api/tasks/{{taskDoing}}",
    body: { title: "契约-跨组织改任务" },
  },
  { name: "tasks.patch.missing", role: "managerA", method: "PATCH", path: "/api/tasks/no-such-task", body: { title: "x" } },

  // ---------- 任务：进度与验收（含跨组织 404、同组织越权 403） ----------
  {
    name: "tasks.progress.memberA",
    role: "memberA",
    method: "POST",
    path: "/api/tasks/{{taskCreated}}/progress",
    body: { progress: 30, note: "已完成三成" },
  },
  {
    name: "tasks.submit-review.memberA.too-early",
    role: "memberA",
    method: "POST",
    path: "/api/tasks/{{taskCreated}}/submit-review",
    body: {},
  },
  {
    name: "tasks.progress.memberA.invalid-value",
    role: "memberA",
    method: "POST",
    path: "/api/tasks/{{taskCreated}}/progress",
    body: { progress: 200 },
  },
  {
    name: "tasks.progress.memberA2.others-task",
    role: "memberA2",
    method: "POST",
    path: "/api/tasks/{{taskDoing}}/progress",
    body: { progress: 30 },
  },
  {
    name: "tasks.progress.managerB.cross-org",
    role: "managerB",
    method: "POST",
    path: "/api/tasks/{{taskTodo}}/progress",
    body: { progress: 30 },
  },
  { name: "tasks.submit-review.memberA", role: "memberA", method: "POST", path: "/api/tasks/{{taskCreated}}/submit-review", body: {} },
  { name: "tasks.approve.memberA", role: "memberA", method: "POST", path: "/api/tasks/{{taskCreated}}/approve", body: {} },
  { name: "tasks.approve.managerB.cross-org", role: "managerB", method: "POST", path: "/api/tasks/{{taskCreated}}/approve", body: {} },
  // 验收权归发布人（D-57）：`taskCreated` 由**管理员**发布，组织管理者 managerA 不是发布人 → 403。
  // 这一条曾经是 200（只判角色），也是本次修复的那个漏洞：同组织的管理者、包括任务的负责人自己，都能点「通过验收」。
  {
    name: "tasks.approve.managerA.not-publisher",
    role: "managerA",
    method: "POST",
    path: "/api/tasks/{{taskCreated}}/approve",
    body: { note: "越权验收" },
  },
  // 发布人（此处是管理员）验收同一条任务 → 200；终态与改动前一致（completed），下游用例不受影响
  {
    name: "tasks.approve.admin.publisher",
    role: "admin",
    method: "POST",
    path: "/api/tasks/{{taskCreated}}/approve",
    body: { note: "验收通过" },
  },
  {
    name: "tasks.progress.memberA2",
    role: "memberA2",
    method: "POST",
    path: "/api/tasks/{{taskByManager}}/progress",
    body: { progress: 100, note: "做完了" },
  },
  {
    name: "tasks.return.memberA",
    role: "memberA",
    method: "POST",
    path: "/api/tasks/{{taskByManager}}/return",
    body: { note: "越权退回" },
  },
  {
    name: "tasks.return.managerB.cross-org",
    role: "managerB",
    method: "POST",
    path: "/api/tasks/{{taskByManager}}/return",
    body: { note: "跨组织退回" },
  },
  // 发布人退回自己发布的任务 → 200（退回与通过是同一个验收动作的两面，判据相同）
  {
    name: "tasks.return.managerA",
    role: "managerA",
    method: "POST",
    path: "/api/tasks/{{taskByManager}}/return",
    body: { note: "请补充截图" },
  },
  // 夹具里那条「待验收任务」由 managerA 发布、成员甲负责：发布人验收 → 200（正向锚点）
  {
    name: "tasks.approve.managerA",
    role: "managerA",
    method: "POST",
    path: "/api/tasks/{{taskReview}}/approve",
    body: { note: "验收通过" },
  },

  // ---------- 验收权：执行者不能验收自己负责的任务（D-57） ----------
  // 负责人（组织管理者）把进度推到 100%：发布人是别人 → 待验收。
  // 旧口径按角色判定（管理者自己负责的任务直接完成），于是管理者**永远见不到验收环节**，
  // 也就掩盖了「他自己能验收自己」这件事。
  {
    name: "tasks.progress.managerA.executor",
    role: "managerA",
    method: "POST",
    path: "/api/tasks/{{taskManagerExec}}/progress",
    body: { progress: 100, note: "管理者做完了" },
  },
  // 本次修复的核心：负责人就是执行者，即使他是组织管理者也不能通过/退回自己负责的任务
  {
    name: "tasks.approve.managerA.executor",
    role: "managerA",
    method: "POST",
    path: "/api/tasks/{{taskManagerExec}}/approve",
    body: { note: "自己验收自己" },
  },
  {
    name: "tasks.return.managerA.executor",
    role: "managerA",
    method: "POST",
    path: "/api/tasks/{{taskManagerExec}}/return",
    body: { note: "自己退回自己" },
  },
  // 发布人（管理员）收尾 → 200（全局管理员兜底：发布人离职/停用后总得有人能推进）
  {
    name: "tasks.approve.admin",
    role: "admin",
    method: "POST",
    path: "/api/tasks/{{taskManagerExec}}/approve",
    body: { note: "管理员验收" },
  },
  // 已完成是终态：负责人不能再把它提交回待验收（否则能绕着状态机再走一遍）
  {
    name: "tasks.submit-review.managerA.completed",
    role: "managerA",
    method: "POST",
    path: "/api/tasks/{{taskManagerExec}}/submit-review",
    body: {},
  },
  // 自己发布给自己做的任务（成员只能建给自己的）没有第二个验收人 → 100% 直接完成，不进待验收
  {
    name: "tasks.progress.memberA.own-task",
    role: "memberA",
    method: "POST",
    path: "/api/tasks/{{taskByMember}}/progress",
    body: { progress: 100, note: "自己的活自己结" },
  },

  // ---------- 任务：归档 / 恢复 / 删除 ----------
  { name: "tasks.archive.managerA", role: "managerA", method: "POST", path: "/api/tasks/{{taskCreated}}/archive" },
  { name: "tasks.archive.managerA.again", role: "managerA", method: "POST", path: "/api/tasks/{{taskCreated}}/archive" },
  { name: "tasks.restore.managerA", role: "managerA", method: "POST", path: "/api/tasks/{{taskCreated}}/restore" },
  { name: "tasks.restore.managerA.again", role: "managerA", method: "POST", path: "/api/tasks/{{taskCreated}}/restore" },
  { name: "tasks.archive.memberA", role: "memberA", method: "POST", path: "/api/tasks/{{taskCreated}}/archive" },
  // 管理员可以归档任意组织的任务（全局角色）
  { name: "tasks.archive.admin.cross-org", role: "admin", method: "POST", path: "/api/tasks/{{taskOfBNew}}/archive" },
  { name: "tasks.delete.managerA.not-archived", role: "managerA", method: "DELETE", path: "/api/tasks/{{taskDel}}" },
  { name: "tasks.delete.managerB.cross-org", role: "managerB", method: "DELETE", path: "/api/tasks/{{taskDel}}" },
  { name: "tasks.archive.managerA.to-delete", role: "managerA", method: "POST", path: "/api/tasks/{{taskDel}}/archive" },
  { name: "tasks.delete.managerA", role: "managerA", method: "DELETE", path: "/api/tasks/{{taskDel}}" },
  { name: "tasks.delete.missing", role: "managerA", method: "DELETE", path: "/api/tasks/no-such-task" },

  // ---------- 评论与时间线（间接表必须经 task_id 关联校验） ----------
  { name: "comments.list.managerA", role: "managerA", method: "GET", path: "/api/tasks/{{taskDoing}}/comments" },
  { name: "comments.list.memberA", role: "memberA", method: "GET", path: "/api/tasks/{{taskDoing}}/comments" },
  { name: "comments.list.memberA2.others-task", role: "memberA2", method: "GET", path: "/api/tasks/{{taskDoing}}/comments" },
  { name: "comments.list.memberB.cross-org", role: "memberB", method: "GET", path: "/api/tasks/{{taskDoing}}/comments" },
  {
    name: "comments.create.memberA",
    role: "memberA",
    method: "POST",
    path: "/api/tasks/{{taskDoing}}/comments",
    body: { content: "阿尔法成员甲的评论" },
  },
  {
    name: "comments.create.memberA2.others-task",
    role: "memberA2",
    method: "POST",
    path: "/api/tasks/{{taskDoing}}/comments",
    body: { content: "越权评论" },
  },
  {
    name: "comments.create.managerB.cross-org",
    role: "managerB",
    method: "POST",
    path: "/api/tasks/{{taskDoing}}/comments",
    body: { content: "跨组织评论" },
  },
  {
    name: "comments.create.memberA.private-task",
    role: "memberA",
    method: "POST",
    path: "/api/tasks/{{taskPrivate}}/comments",
    body: { content: "越权评论私密任务" },
  },
  {
    name: "comments.create.managerA.private-task",
    role: "managerA",
    method: "POST",
    path: "/api/tasks/{{taskPrivate}}/comments",
    body: { content: "私密任务由创建者评论" },
  },
  // D-54 私密任务的三个可见方：发布人 / 负责人 / 全局管理员。
  // `taskPrivate` 由管理者发布、管理者负责；`taskPrivateAssigned` 由管理者发布、**成员乙负责**。
  { name: "comments.list.managerA.private-task", role: "managerA", method: "GET", path: "/api/tasks/{{taskPrivate}}/comments" },
  // 成员甲也不是这条的发布人或负责人 → 403（同组织但看不见）
  { name: "comments.list.memberA.private-task", role: "memberA", method: "GET", path: "/api/tasks/{{taskPrivate}}/comments" },
  { name: "comments.list.memberA2.private-task", role: "memberA2", method: "GET", path: "/api/tasks/{{taskPrivate}}/comments" },
  // 直接 PATCH 也过不去：写操作与读操作共用同一个 `canView`（否则「列表看不见、接口改得动」）
  {
    name: "tasks.patch.memberA2.private-task",
    role: "memberA2",
    method: "PATCH",
    path: "/api/tasks/{{taskPrivate}}",
    body: { title: "x" },
  },
  {
    name: "comments.create.memberA2.private-task-not-owner",
    role: "memberA2",
    method: "POST",
    path: "/api/tasks/{{taskPrivate}}/comments",
    body: { content: "成员乙不是这条私密任务的负责人" },
  },
  { name: "comments.list.admin.private-task", role: "admin", method: "GET", path: "/api/tasks/{{taskPrivate}}/comments" },
  // 负责人（成员乙）看得到、也能评论派给自己的私密任务
  { name: "comments.list.memberA2.private-assigned", role: "memberA2", method: "GET", path: "/api/tasks/{{taskPrivateAssigned}}/comments" },
  {
    name: "comments.create.memberA2.private-assigned",
    role: "memberA2",
    method: "POST",
    path: "/api/tasks/{{taskPrivateAssigned}}/comments",
    body: { content: "负责人评论自己的私密任务" },
  },
  { name: "comments.list.managerA.private-assigned", role: "managerA", method: "GET", path: "/api/tasks/{{taskPrivateAssigned}}/comments" },
  { name: "comments.list.memberA.private-assigned", role: "memberA", method: "GET", path: "/api/tasks/{{taskPrivateAssigned}}/comments" },
  // 跨组织访问私密任务同样是 404（这条由**贝塔管理者**发起，路径与上一条刻意一致、只有角色不同）
  {
    name: "comments.list.managerB.private-assigned.cross-org",
    role: "managerB",
    method: "GET",
    path: "/api/tasks/{{taskPrivateAssigned}}/comments",
  },
  {
    name: "comments.create.memberA.empty",
    role: "memberA",
    method: "POST",
    path: "/api/tasks/{{taskDoing}}/comments",
    body: { content: "  " },
  },
  { name: "activity.managerA", role: "managerA", method: "GET", path: "/api/tasks/{{taskDoing}}/activity" },
  { name: "activity.anon", role: "anon", method: "GET", path: "/api/tasks/{{taskDoing}}/activity" },
  { name: "activity.managerB.cross-org", role: "managerB", method: "GET", path: "/api/tasks/{{taskDoing}}/activity" },
  { name: "activity.missing", role: "managerA", method: "GET", path: "/api/tasks/no-such-task/activity" },

  // ---------- 通知（按收件人隔离，两个组织各有一条种子数据） ----------
  { name: "notifications.admin", role: "admin", method: "GET", path: "/api/notifications" },
  { name: "notifications.memberA", role: "memberA", method: "GET", path: "/api/notifications" },
  { name: "notifications.memberA.unread", role: "memberA", method: "GET", path: "/api/notifications?unread=1" },
  { name: "notifications.memberB", role: "memberB", method: "GET", path: "/api/notifications" },
  { name: "notifications.memberB.unread", role: "memberB", method: "GET", path: "/api/notifications?unread=1" },
  {
    name: "notifications.read.task.memberA",
    role: "memberA",
    method: "POST",
    path: "/api/notifications/read",
    body: { taskId: IDS.taskTodo },
  },
  { name: "notifications.read.all.memberB", role: "memberB", method: "POST", path: "/api/notifications/read", body: { all: true } },
  { name: "notifications.read.anon", role: "anon", method: "POST", path: "/api/notifications/read", body: { all: true } },

  // ---------- 验收视图（管理员或组织管理者） ----------
  { name: "review.admin", role: "admin", method: "GET", path: "/api/review" },
  { name: "review.admin.status", role: "admin", method: "GET", path: "/api/review?status=pending_review" },
  { name: "review.admin.range", role: "admin", method: "GET", path: "/api/review?from=2026-09-01&to=2026-09-30" },
  { name: "review.admin.owner", role: "admin", method: "GET", path: "/api/review?ownerId={{userMemberB}}" },
  { name: "review.managerA", role: "managerA", method: "GET", path: "/api/review" },
  { name: "review.managerA.owner", role: "managerA", method: "GET", path: "/api/review?ownerId={{userMemberA2}}" },
  { name: "review.managerB", role: "managerB", method: "GET", path: "/api/review" },
  { name: "review.memberA", role: "memberA", method: "GET", path: "/api/review" },
  { name: "review.noOrg", role: "noOrg", method: "GET", path: "/api/review" },

  // ---------- 企微收件箱 ----------
  {
    name: "inbox.preview.admin",
    role: "admin",
    method: "POST",
    path: "/api/inbox/preview",
    body: { drafts: [{ title: "企微草稿", sender: "张三", priority: "P1", messageAt: "2026-09-01 10:23" }] },
  },
  {
    name: "inbox.preview.managerA",
    role: "managerA",
    method: "POST",
    path: "/api/inbox/preview",
    body: { drafts: [{ title: "企微草稿" }] },
  },
  { name: "inbox.preview.memberA", role: "memberA", method: "POST", path: "/api/inbox/preview", body: { drafts: [{ title: "企微草稿" }] } },
  // 管理员导入必须指定目标组织：`orgId` 在 **body 顶层**（与任务域 createTask 同一口径），
  // 不是每份草稿一个；无组织账号则直接 403
  {
    name: "inbox.import.admin",
    role: "admin",
    method: "POST",
    path: "/api/inbox/import",
    body: { orgId: IDS.orgAlpha, drafts: [{ title: "企微导入", ownerId: IDS.userMemberA, priority: "P1", fingerprint: "fp-contract" }] },
  },
  {
    name: "inbox.import.admin.duplicate",
    role: "admin",
    method: "POST",
    path: "/api/inbox/import",
    body: { orgId: IDS.orgAlpha, drafts: [{ title: "企微导入", ownerId: IDS.userMemberA, priority: "P1", fingerprint: "fp-contract" }] },
  },
  {
    name: "inbox.import.admin.allow-duplicates",
    role: "admin",
    method: "POST",
    path: "/api/inbox/import",
    body: {
      orgId: IDS.orgAlpha,
      drafts: [{ title: "企微导入", ownerId: IDS.userMemberA, priority: "P1", fingerprint: "fp-contract" }],
      allowDuplicates: true,
    },
  },
  {
    name: "inbox.import.memberA",
    role: "memberA",
    method: "POST",
    path: "/api/inbox/import",
    body: { drafts: [{ title: "成员甲导入", fingerprint: "fp-a" }] },
  },
  {
    name: "inbox.import.managerB.cross-org-owner",
    role: "managerB",
    method: "POST",
    path: "/api/inbox/import",
    body: { drafts: [{ title: "跨组织指派", ownerId: IDS.userMemberA, fingerprint: "fp-cross" }] },
  },
  { name: "inbox.import.noOrg", role: "noOrg", method: "POST", path: "/api/inbox/import", body: { drafts: [] } },
  { name: "inbox.import.anon", role: "anon", method: "POST", path: "/api/inbox/import", body: { drafts: [] } },

  // ---------- 待办（D-54：**本人数据**，组织只决定写在哪，管理员也只看得到自己的） ----------
  { name: "todos.list.anon", role: "anon", method: "GET", path: "/api/todos" },
  { name: "todos.list.admin", role: "admin", method: "GET", path: "/api/todos" },
  { name: "todos.list.managerA", role: "managerA", method: "GET", path: "/api/todos" },
  { name: "todos.list.memberA", role: "memberA", method: "GET", path: "/api/todos" },
  { name: "todos.list.managerB", role: "managerB", method: "GET", path: "/api/todos" },
  { name: "todos.list.noOrg", role: "noOrg", method: "GET", path: "/api/todos" },
  {
    name: "todos.create.managerA",
    role: "managerA",
    method: "POST",
    path: "/api/todos",
    body: { content: "契约待办", todoDate: "2026-09-05" },
    capture: { todoId: "data.id" },
  },
  {
    name: "todos.create.memberA",
    role: "memberA",
    method: "POST",
    path: "/api/todos",
    body: { content: "契约待办-成员甲" },
    capture: { todoIdByMember: "data.id" },
  },
  // 请求体里的 ownerId 一律忽略：归属人恒为当前账号（写别人的待办没有入口）
  {
    name: "todos.create.memberA.owner-ignored",
    role: "memberA",
    method: "POST",
    path: "/api/todos",
    body: { content: "想让别人当归属人", ownerId: IDS.userMemberA2 },
  },
  { name: "todos.create.empty", role: "managerA", method: "POST", path: "/api/todos", body: {} },
  { name: "todos.patch.managerA", role: "managerA", method: "PATCH", path: "/api/todos/{{todoId}}", body: { isCompleted: true } },
  // 同组织但不是本人：403（跨组织才是 404，见下一条）
  {
    name: "todos.patch.memberA2.others-todo",
    role: "memberA2",
    method: "PATCH",
    path: "/api/todos/{{todoOpen}}",
    body: { isCompleted: true },
  },
  { name: "todos.patch.managerA.others-todo", role: "managerA", method: "PATCH", path: "/api/todos/{{todoOpen}}", body: { content: "x" } },
  {
    name: "todos.patch.managerB.cross-org",
    role: "managerB",
    method: "PATCH",
    path: "/api/todos/{{todoOpen}}",
    body: { isCompleted: true },
  },
  { name: "todos.patch.missing", role: "managerA", method: "PATCH", path: "/api/todos/no-such-todo", body: { isCompleted: true } },
  { name: "todos.delete.memberA", role: "memberA", method: "DELETE", path: "/api/todos/{{todoIdByMember}}" },
  { name: "todos.delete.memberA.others-todo", role: "memberA", method: "DELETE", path: "/api/todos/{{todoId}}" },
  { name: "todos.delete.managerA", role: "managerA", method: "DELETE", path: "/api/todos/{{todoId}}" },
  { name: "todos.delete.managerA.cross-org", role: "managerA", method: "DELETE", path: "/api/todos/{{todoOfB}}" },
  { name: "todos.delete.missing", role: "managerA", method: "DELETE", path: "/api/todos/no-such-todo" },

  // ---------- 随手记（D-54：同样是本人数据） ----------
  { name: "notes.list.admin", role: "admin", method: "GET", path: "/api/notes" },
  { name: "notes.list.managerA", role: "managerA", method: "GET", path: "/api/notes" },
  { name: "notes.list.memberA", role: "memberA", method: "GET", path: "/api/notes" },
  { name: "notes.list.managerB", role: "managerB", method: "GET", path: "/api/notes" },
  { name: "notes.list.noOrg", role: "noOrg", method: "GET", path: "/api/notes" },
  {
    name: "notes.create.managerA",
    role: "managerA",
    method: "POST",
    path: "/api/notes",
    body: { content: "契约随手记", isPinned: true },
    capture: { noteId: "data.id" },
  },
  { name: "notes.create.empty", role: "managerA", method: "POST", path: "/api/notes", body: {} },
  { name: "notes.patch.managerA", role: "managerA", method: "PATCH", path: "/api/notes/{{noteId}}", body: { content: "改过的随手记" } },
  // 同组织但不是本人：403
  { name: "notes.patch.memberA2.others-note", role: "memberA2", method: "PATCH", path: "/api/notes/{{noteOne}}", body: { content: "x" } },
  {
    name: "notes.patch.managerB.cross-org",
    role: "managerB",
    method: "PATCH",
    path: "/api/notes/{{noteOne}}",
    body: { content: "跨组织改随手记" },
  },
  { name: "notes.patch.missing", role: "managerA", method: "PATCH", path: "/api/notes/no-such-note", body: { content: "x" } },
  { name: "notes.delete.memberA.others-note", role: "memberA", method: "DELETE", path: "/api/notes/{{noteId}}" },
  { name: "notes.delete.managerB.cross-org", role: "managerB", method: "DELETE", path: "/api/notes/{{noteOne}}" },
  { name: "notes.delete.managerA", role: "managerA", method: "DELETE", path: "/api/notes/{{noteId}}" },
  { name: "notes.delete.missing", role: "managerA", method: "DELETE", path: "/api/notes/no-such-note" },

  // ---------- 重要文件（D-54：组织内**所有人**可见、可增、可改；D-55：可见范围逐条自选） ----------
  { name: "files.list.admin", role: "admin", method: "GET", path: "/api/files" },
  { name: "files.list.managerA", role: "managerA", method: "GET", path: "/api/files" },
  { name: "files.list.memberA", role: "memberA", method: "GET", path: "/api/files" },
  { name: "files.list.managerB", role: "managerB", method: "GET", path: "/api/files" },
  { name: "files.list.search.managerA", role: "managerA", method: "GET", path: "/api/files?search=报价" },
  { name: "files.list.category.managerA", role: "managerA", method: "GET", path: "/api/files?category=报价" },
  {
    name: "files.create.managerA",
    role: "managerA",
    method: "POST",
    path: "/api/files",
    body: { name: "契约文件", filePath: "C:\\fixture\\contract.xlsx", category: "报价" },
    capture: { fileId: "data.id" },
  },
  { name: "files.create.empty", role: "managerA", method: "POST", path: "/api/files", body: { name: "", filePath: "" } },
  // 可见范围（D-55）：不传 `visibility` = 「给组织看」（默认档，老客户端行为不变）
  {
    name: "files.create.memberA.default-visibility",
    role: "memberA",
    method: "POST",
    path: "/api/files",
    body: { name: "成员甲建的默认文件", filePath: "C:\\fixture\\member-default.xlsx" },
  },
  // `visibility='private'`：只有**创建人**与**本组织的全局管理员**看得到
  {
    name: "files.create.memberA.private",
    role: "memberA",
    method: "POST",
    path: "/api/files",
    body: { name: "成员甲的个人文件", filePath: "C:\\fixture\\member-private.xlsx", visibility: "private" },
    capture: { filePrivateByMember: "data.id" },
  },
  // 普通成员可以新增与编辑（组织归属由服务端按会话取，不接受请求里的 orgId）
  {
    name: "files.create.memberA",
    role: "memberA",
    method: "POST",
    path: "/api/files",
    body: { name: "契约文件-成员甲", filePath: "C:\\fixture\\contract-member.xlsx", category: "报价" },
    capture: { fileByMember: "data.id" },
  },
  {
    name: "files.edit.memberA.others-file",
    role: "memberA",
    method: "PATCH",
    path: "/api/files/{{fileId}}",
    body: { name: "成员甲改管理者的文件" },
  },
  // 夹具里 `filePrivate`（「我的报价底稿」）归管理者甲、可见范围是 private：
  // 用搜索定位到它这一条，直接比对「谁看得到」——比看整个列表更好读
  { name: "files.list.memberA.private-hidden", role: "memberA", method: "GET", path: "/api/files?search=我的报价底稿" },
  { name: "files.list.managerA.private-visible", role: "managerA", method: "GET", path: "/api/files?search=我的报价底稿" },
  { name: "files.list.admin.private-visible", role: "admin", method: "GET", path: "/api/files?search=我的报价底稿" },
  // 跨组织改别人的个人文件 → 404（组织隔离优先于可见性）
  {
    name: "files.edit.managerB.others-private.cross-org",
    role: "managerB",
    method: "PATCH",
    path: "/api/files/{{filePrivate}}",
    body: { name: "跨组织改个人文件" },
  },
  // 创建人能把组织文件改成个人文件，改完别人就看不到了；再改回来
  {
    name: "files.edit.managerA.org-to-private",
    role: "managerA",
    method: "PATCH",
    path: "/api/files/{{fileRemote}}",
    body: { visibility: "private" },
  },
  { name: "files.use.memberA.after-private", role: "memberA", method: "POST", path: "/api/files/{{fileRemote}}/use" },
  {
    name: "files.edit.managerA.back-to-org",
    role: "managerA",
    method: "PATCH",
    path: "/api/files/{{fileRemote}}",
    body: { visibility: "org" },
  },
  { name: "files.use.managerA", role: "managerA", method: "POST", path: "/api/files/{{fileId}}/use" },
  { name: "files.use.memberA", role: "memberA", method: "POST", path: "/api/files/{{fileId}}/use" },
  { name: "files.use.managerB.cross-org", role: "managerB", method: "POST", path: "/api/files/{{fileOne}}/use" },
  { name: "files.use.missing", role: "managerA", method: "POST", path: "/api/files/no-such-file/use" },
  // 删除是**逐条**判的（D-54 + D-55）：
  // 成员删**自己的**（含个人文件）→ 200；删别人的组织文件 → 403；
  // 组织管理者删本组织的组织文件 → 200、删**别人的个人文件** → 403；跨组织一律 404。
  { name: "files.delete.memberA", role: "memberA", method: "DELETE", path: "/api/files/{{fileByMember}}" },
  { name: "files.delete.memberA.others-org-file", role: "memberA", method: "DELETE", path: "/api/files/{{fileOne}}" },
  // 组织管理者删**自己的**个人文件 → 200（夹具里 `filePrivate` 就是管理者甲登记的）
  { name: "files.delete.managerA.own-private", role: "managerA", method: "DELETE", path: "/api/files/{{filePrivate}}" },
  // 组织管理者删**别人的**个人文件 → 403（`filePrivateByMember` 是成员甲建的，这条要排在成员甲自删之前）
  { name: "files.delete.managerA.others-private", role: "managerA", method: "DELETE", path: "/api/files/{{filePrivateByMember}}" },
  { name: "files.delete.memberA.own-private", role: "memberA", method: "DELETE", path: "/api/files/{{filePrivateByMember}}" },
  { name: "files.delete.managerB.cross-org", role: "managerB", method: "DELETE", path: "/api/files/{{fileOne}}" },
  { name: "files.delete.managerA", role: "managerA", method: "DELETE", path: "/api/files/{{fileId}}" },
  { name: "files.delete.managerA.member-file", role: "managerA", method: "DELETE", path: "/api/files/{{fileByMember}}" },

  // ---------- 重要文件下载（D-49） ----------
  // 远端文件经服务端**流式代理**下载（GET /api/files/:id/download），边界与文件库一致：
  // 401 未登录、400 本机路径不可下载、404 跨组织或不存在、503 本账号未配置 WebDAV。
  // D-54 起**没有 403 这一档了**（组织内所有人都能取，只有删除限管理者）。
  // 夹具里管理者 / 成员账号没有 `webdav_settings`（D-52 之后只有管理员那份是「周报上传共用连接」），
  // 所以这里录的是**确定**的失败面；「上传 → 登记 → 下载」的闭环由 smoke:ui 用假 WebDAV 覆盖
  // （同 reports.download 的口径）。
  { name: "files.download.anon", role: "anon", method: "GET", path: "/api/files/{{fileOne}}/download" },
  // D-54：普通成员也能下载（他不一定配了 WebDAV，所以这里录的是 503 那一侧；
  // 「上传 → 登记 → 下载」的成功链路由 smoke:ui 用假 WebDAV 覆盖）
  { name: "files.download.memberA", role: "memberA", method: "GET", path: "/api/files/{{fileOne}}/download" },
  { name: "files.download.memberA.cross-org", role: "memberA", method: "GET", path: "/api/files/{{fileOfB}}/download" },
  // 别人的个人文件：403（与「跨组织 404」刻意不同）
  { name: "files.download.memberA.others-private", role: "memberA", method: "GET", path: "/api/files/{{filePrivate}}/download" },
  { name: "files.download.local-path", role: "managerA", method: "GET", path: "/api/files/{{fileOne}}/download" },
  { name: "files.download.webdav.disabled", role: "managerA", method: "GET", path: "/api/files/{{fileRemote}}/download" },
  { name: "files.download.managerB.cross-org", role: "managerB", method: "GET", path: "/api/files/{{fileOne}}/download" },
  { name: "files.download.missing", role: "managerA", method: "GET", path: "/api/files/no-such-file/download" },

  // ---------- WebDAV 网关（可选接入）----------
  // 契约夹具里只有**管理员**配了 WebDAV（D-52：周报上传共用他那份连接），
  // 所以这组用例录的是「管理者/成员未配置时的 503 + 管理员已配置时的空目录」；
  // ⚠️ D-54 起「未配置」是**账号维度**的 503，不再代表角色不够（普通成员同样能进这个网关）。
  // 协议细节（PROPFIND 解析、路径越界、上传补建目录）由 test/webdav/client.test.ts 用本地假服务器覆盖。
  { name: "webdav.list.anon", role: "anon", method: "GET", path: "/api/webdav" },
  { name: "webdav.list.memberA", role: "memberA", method: "GET", path: "/api/webdav" },
  { name: "webdav.list.managerA.disabled", role: "managerA", method: "GET", path: "/api/webdav" },
  // 管理员有连接，但假 NAS 上没有「报价」这个目录 → 200 + 空列表（不是 503）
  { name: "webdav.list.admin.missing-dir", role: "admin", method: "GET", path: "/api/webdav?path=%E6%8A%A5%E4%BB%B7" },
  {
    name: "webdav.upload.memberA.disabled",
    role: "memberA",
    method: "POST",
    path: "/api/webdav",
    upload: { fields: { dir: "", register: "0" }, filename: "contract.txt", content: "hello" },
  },
  {
    name: "webdav.upload.managerA.disabled",
    role: "managerA",
    method: "POST",
    path: "/api/webdav",
    upload: { fields: { dir: "", register: "0" }, filename: "contract.txt", content: "hello" },
  },

  // ---------- 周报：读与隔离（D-54：**组织内全可见**，只有「改」还分角色） ----------
  { name: "reports.list.admin", role: "admin", method: "GET", path: "/api/reports" },
  { name: "reports.list.managerA", role: "managerA", method: "GET", path: "/api/reports" },
  { name: "reports.list.memberA", role: "memberA", method: "GET", path: "/api/reports" },
  { name: "reports.list.memberB", role: "memberB", method: "GET", path: "/api/reports" },
  { name: "reports.list.noOrg", role: "noOrg", method: "GET", path: "/api/reports" },
  { name: "reports.detail.managerA", role: "managerA", method: "GET", path: "/api/reports/{{reportSubmitted}}" },
  { name: "reports.detail.memberA", role: "memberA", method: "GET", path: "/api/reports/{{reportSubmitted}}" },
  // 成员乙看得到同组织成员甲的周报（D-54 之前这里也是 200，但列表里根本没有这条——
  // 所以真正钉住新口径的是上面的 reports.list.memberA2）
  { name: "reports.detail.memberA2.others-report", role: "memberA2", method: "GET", path: "/api/reports/{{reportSubmitted}}" },
  { name: "reports.list.memberA2", role: "memberA2", method: "GET", path: "/api/reports" },
  { name: "reports.detail.managerB.cross-org", role: "managerB", method: "GET", path: "/api/reports/{{reportSubmitted}}" },
  { name: "reports.detail.missing", role: "managerA", method: "GET", path: "/api/reports/no-such-report" },
  { name: "reports.download.memberA", role: "memberA", method: "GET", path: "/api/reports/{{reportSubmitted}}/file/1" },
  // 成员乙能下载同组织别人的周报正文（组织内公开）
  { name: "reports.download.memberA2.others-report", role: "memberA2", method: "GET", path: "/api/reports/{{reportSubmitted}}/file/1" },
  { name: "reports.download.managerB.cross-org", role: "managerB", method: "GET", path: "/api/reports/{{reportSubmitted}}/file/1" },
  { name: "reports.download.missing-version", role: "managerA", method: "GET", path: "/api/reports/{{reportSubmitted}}/file/9" },
  // 「改」仍然只给本人：成员乙重传成员甲的周报 → 404（与「没这条周报」同一响应）
  {
    name: "reports.reupload.memberA2.others-report",
    role: "memberA2",
    method: "POST",
    path: "/api/reports/{{reportSubmitted}}/file",
    upload: { fields: {}, filename: "contract-robbed.xlsx", content: "fake-xlsx" },
  },

  // ---------- 周报：审批（managerA 不能碰贝塔组的周报） ----------
  { name: "reports.return.no-note.managerA", role: "managerA", method: "POST", path: "/api/reports/{{reportSubmitted}}/return", body: {} },
  {
    name: "reports.return.memberA",
    role: "memberA",
    method: "POST",
    path: "/api/reports/{{reportSubmitted}}/return",
    body: { note: "越权退回" },
  },
  {
    name: "reports.return.managerA.cross-org",
    role: "managerA",
    method: "POST",
    path: "/api/reports/{{reportOfB}}/return",
    body: { note: "跨组织退回" },
  },
  {
    name: "reports.approve.managerB.cross-org",
    role: "managerB",
    method: "POST",
    path: "/api/reports/{{reportSubmitted}}/approve",
    body: {},
  },
  { name: "reports.approve.memberA", role: "memberA", method: "POST", path: "/api/reports/{{reportSubmitted}}/approve", body: {} },
  {
    name: "reports.approve.managerA",
    role: "managerA",
    method: "POST",
    path: "/api/reports/{{reportSubmitted}}/approve",
    body: { note: "通过" },
  },
  {
    name: "reports.return.managerA.approved",
    role: "managerA",
    method: "POST",
    path: "/api/reports/{{reportSubmitted}}/return",
    body: { note: "已通过不能再退回" },
  },

  // ---------- 周报：上传、退回后重传、下载 ----------
  // 周报正文自 D-46 起只写 NAS（契约环境里是一个本地假 WebDAV），归属人**恒为提交者本人**：
  // 下面这些用例同时盯着「落点写在 NAS 上」与「ownerId 被忽略、代传已取消」两件事。
  // 落点根目录自 D-53 起**按组织**：夹具给阿尔法配了 `/阿尔法`、贝塔不配（用连接的浏览根），
  // 于是快照里能直接看到两个组织的 `storedName` 前缀不同。
  {
    name: "reports.create.memberA.upload",
    role: "memberA",
    method: "POST",
    path: "/api/reports",
    upload: {
      fields: { periodStart: "2026-09-01", periodEnd: "2026-09-07", docType: "weekly_report", note: "契约第一周" },
      filename: "contract-week1.xlsx",
      content: "fake-xlsx-contract",
    },
    capture: { reportNew: "data.id" },
  },
  // ownerId 指向别人也无效：member 只能提交自己的（D-46 后这个字段整体不再读取）
  {
    name: "reports.create.memberA.other-owner",
    role: "memberA",
    method: "POST",
    path: "/api/reports",
    upload: {
      fields: { ownerId: IDS.userMemberA2, periodStart: "2026-09-01", periodEnd: "2026-09-07", docType: "weekly_report" },
      filename: "contract-week1.xlsx",
      content: "fake-xlsx-contract",
    },
  },
  // 组织管理者只能提交**自己的**（代传已取消）：ownerId 写了别人也归自己
  {
    name: "reports.create.managerA.own",
    role: "managerA",
    method: "POST",
    path: "/api/reports",
    upload: {
      fields: { ownerId: IDS.userMemberA2, periodStart: "2026-09-01", periodEnd: "2026-09-07", docType: "summary" },
      filename: "contract-summary.docx",
      content: "fake-docx-contract",
    },
    capture: { reportProxy: "data.id" },
  },
  // 跨组织指派同样失效：归属人就是 managerA 自己（改前是 400「归属人必须属于本组织」）
  {
    name: "reports.create.managerA.owner-ignored",
    role: "managerA",
    method: "POST",
    path: "/api/reports",
    upload: {
      fields: { ownerId: IDS.userMemberB, periodStart: "2026-09-01", periodEnd: "2026-09-07", docType: "summary" },
      filename: "contract-summary.docx",
      content: "fake-docx-contract",
    },
  },
  {
    name: "reports.create.memberB.upload",
    role: "memberB",
    method: "POST",
    path: "/api/reports",
    upload: {
      fields: { periodStart: "2026-09-01", periodEnd: "2026-09-07", docType: "weekly_report", note: "贝塔第一周" },
      filename: "contract-week1.xlsx",
      content: "fake-xlsx-contract",
    },
    capture: { reportOfBNew: "data.id" },
  },
  {
    name: "reports.create.bad-ext",
    role: "memberA",
    method: "POST",
    path: "/api/reports",
    upload: {
      fields: { periodStart: "2026-09-01", periodEnd: "2026-09-07", docType: "weekly_report" },
      filename: "evil.exe",
      content: "x",
    },
  },
  {
    name: "reports.create.noOrg",
    role: "noOrg",
    method: "POST",
    path: "/api/reports",
    upload: {
      fields: { periodStart: "2026-09-01", periodEnd: "2026-09-07", docType: "weekly_report" },
      filename: "contract-week1.xlsx",
      content: "fake-xlsx-contract",
    },
  },
  // 管理员是全局角色（没有组织），D-46 起**不参与提交**：403，页面也不给上传入口
  {
    name: "reports.create.admin.forbidden",
    role: "admin",
    method: "POST",
    path: "/api/reports",
    upload: {
      fields: { periodStart: "2026-09-01", periodEnd: "2026-09-07", docType: "weekly_report" },
      filename: "contract-week1.xlsx",
      content: "fake-xlsx-contract",
    },
  },
  {
    name: "reports.return.managerA.uploaded",
    role: "managerA",
    method: "POST",
    path: "/api/reports/{{reportNew}}/return",
    body: { note: "请补充数据" },
  },
  {
    name: "reports.upload-new-version",
    role: "memberA",
    method: "POST",
    path: "/api/reports/{{reportNew}}/file",
    upload: { fields: {}, filename: "contract-week1-v2.xlsx", content: "fake-xlsx-contract-v2" },
  },
  { name: "reports.download.uploaded", role: "managerA", method: "GET", path: "/api/reports/{{reportNew}}/file/1" },
  { name: "reports.download.uploaded-v2", role: "managerA", method: "GET", path: "/api/reports/{{reportNew}}/file/2" },
  { name: "reports.detail.managerA.proxy", role: "managerA", method: "GET", path: "/api/reports/{{reportProxy}}" },
  // 管理员可以审批任意组织的周报（正向跨组织）
  {
    name: "reports.approve.admin.cross-org",
    role: "admin",
    method: "POST",
    path: "/api/reports/{{reportOfBNew}}/approve",
    body: { note: "管理员审批贝塔周报" },
  },
  { name: "reports.detail.memberB.own", role: "memberB", method: "GET", path: "/api/reports/{{reportOfBNew}}" },
  {
    name: "reports.upload.missing-report",
    role: "managerA",
    method: "POST",
    path: "/api/reports/no-such-report/file",
    upload: { fields: {}, filename: "a.xlsx", content: "x" },
  },

  // ---------- 收尾：成员状态流转（会撤销会话，必须放在所有业务用例之后） ----------
  {
    name: "org.members.patch.managerA.self-role",
    role: "managerA",
    method: "PATCH",
    path: "/api/members/{{userManagerA}}",
    body: { role: "member" },
  },
  {
    name: "org.members.patch.managerA.self-deactivate",
    role: "managerA",
    method: "PATCH",
    path: "/api/members/{{userManagerA}}",
    body: { isActive: false },
  },
  {
    name: "org.members.patch.managerA.promote-admin",
    role: "managerA",
    method: "PATCH",
    path: "/api/members/{{userMemberA}}",
    body: { role: "admin" },
  },
  { name: "org.members.patch.managerA.bad-body", role: "managerA", method: "PATCH", path: "/api/members/{{userMemberA}}", body: {} },
  {
    name: "org.members.patch.managerA.cross-org",
    role: "managerA",
    method: "PATCH",
    path: "/api/members/{{userMemberB}}",
    body: { isActive: false },
  },
  { name: "org.members.patch.memberA", role: "memberA", method: "PATCH", path: "/api/members/{{userMemberA2}}", body: { isActive: true } },
  {
    name: "org.members.patch.managerA.memberA2.deactivate",
    role: "managerA",
    method: "PATCH",
    path: "/api/members/{{userMemberA2}}",
    body: { isActive: false },
  },
  {
    name: "org.members.patch.managerA.memberA2.reactivate",
    role: "managerA",
    method: "PATCH",
    path: "/api/members/{{userMemberA2}}",
    body: { isActive: true },
  },
  { name: "members.list.managerA.after-reactivate", role: "managerA", method: "GET", path: "/api/members" },
  {
    name: "org.members.patch.admin.promote-memberA2",
    role: "admin",
    method: "PATCH",
    path: "/api/members/{{userMemberA2}}",
    body: { role: "manager" },
  },
  {
    name: "org.members.patch.admin.demote-memberA2",
    role: "admin",
    method: "PATCH",
    path: "/api/members/{{userMemberA2}}",
    body: { role: "member" },
  },
  // 不变式 4：admin 不能把自己降级（否则没人能管组织，只能靠本机 CLI 恢复）
  {
    name: "org.members.patch.admin.self-demote",
    role: "admin",
    method: "PATCH",
    path: "/api/members/{{userAdmin}}",
    body: { role: "member" },
  },
  { name: "org.members.delete.managerA.last-manager", role: "managerA", method: "DELETE", path: "/api/members/{{userManagerA}}" },
  { name: "org.members.delete.managerA.cross-org", role: "managerA", method: "DELETE", path: "/api/members/{{userMemberB}}" },
  { name: "org.members.delete.memberA", role: "memberA", method: "DELETE", path: "/api/members/{{userMemberA2}}" },
  {
    name: "org.patch.admin.new-org",
    role: "admin",
    method: "PATCH",
    path: "/api/organizations/{{orgNew}}",
    body: { name: "契约新组织（改名）" },
  },
  {
    name: "org.patch.managerA.missing",
    role: "managerA",
    method: "PATCH",
    path: "/api/organizations/no-such-org",
    body: { name: "不存在的组织" },
  },

  // ---------- 任务：换所属组织（D-47，只有管理员能改） ----------
  // 刻意排在**所有读类用例之后、收尾解散组织之前**：这组用例会写库（改归属 + 写时间线 + 发通知），
  // 放在前面会改变列表顺序与通知列表的载荷，让 golden 的 diff 变得难以审阅。
  // 用的是夹具里没有任何用例引用的 `taskDone`（阿尔法组、负责人成员甲），前后各换一次，最终状态不变。
  {
    name: "tasks.patch.managerA.move-org-rejected",
    role: "managerA",
    method: "PATCH",
    path: "/api/tasks/{{taskDone}}",
    body: { orgId: IDS.orgBeta },
  },
  // 负责人必须属于目标组织：只改组织、不动负责人 → 拒绝
  {
    name: "tasks.patch.admin.move-org.owner-conflict",
    role: "admin",
    method: "PATCH",
    path: "/api/tasks/{{taskDone}}",
    body: { orgId: IDS.orgBeta },
  },
  // 已解散的组织不能再接收任务
  {
    name: "tasks.patch.admin.move-org.archived-org",
    role: "admin",
    method: "PATCH",
    path: "/api/tasks/{{taskDone}}",
    body: { orgId: IDS.orgArchived },
  },
  // 管理员换组织 + 同时改派给目标组织的成员 → 成功
  {
    name: "tasks.patch.admin.move-org",
    role: "admin",
    method: "PATCH",
    path: "/api/tasks/{{taskDone}}",
    body: { orgId: IDS.orgBeta, ownerId: IDS.userMemberB },
  },
  // 换回原组织与原负责人（最终状态与夹具一致）
  {
    name: "tasks.patch.admin.move-org.back",
    role: "admin",
    method: "PATCH",
    path: "/api/tasks/{{taskDone}}",
    body: { orgId: IDS.orgAlpha, ownerId: IDS.userMemberA },
  },
  // 时间线要记下这两次换组织（event_type = task_moved，迁移 013 放开的取值）
  { name: "activity.task-moved", role: "admin", method: "GET", path: "/api/tasks/{{taskDone}}/activity" },

  // ---------- 收尾：解散 / 恢复组织（不变式 5） ----------
  { name: "org.archive.managerA.cross-org", role: "managerA", method: "POST", path: "/api/organizations/{{orgBeta}}/archive" },
  { name: "org.archive.memberA", role: "memberA", method: "POST", path: "/api/organizations/{{orgAlpha}}/archive" },
  { name: "org.archive.admin.new-org", role: "admin", method: "POST", path: "/api/organizations/{{orgNew}}/archive" },
  { name: "org.restore.managerA", role: "managerA", method: "POST", path: "/api/organizations/{{orgNew}}/restore" },
  { name: "org.restore.admin.new-org", role: "admin", method: "POST", path: "/api/organizations/{{orgNew}}/restore" },
  { name: "org.archive.managerB.self", role: "managerB", method: "POST", path: "/api/organizations/{{orgBeta}}/archive" },
  { name: "org.list.admin.after-archive", role: "admin", method: "GET", path: "/api/organizations" },
  { name: "org.list.memberA.after-archive", role: "memberA", method: "GET", path: "/api/organizations" },
  // 已解散组织的数据：成员被退回「未加入」，管理员仍可查看（不变式 5）
  { name: "tasks.list.admin.after-archive", role: "admin", method: "GET", path: "/api/tasks" },
  { name: "tasks.list.memberB.after-archive", role: "memberB", method: "GET", path: "/api/tasks" },
  { name: "auth.me.memberB.after-archive", role: "memberB", method: "GET", path: "/api/auth/me" },
  { name: "org.restore.admin.beta", role: "admin", method: "POST", path: "/api/organizations/{{orgBeta}}/restore" },
  { name: "org.list.admin.after-restore", role: "admin", method: "GET", path: "/api/organizations" },
  { name: "reports.list.managerB.after-restore", role: "managerB", method: "GET", path: "/api/reports" },
  {
    name: "org.patch.managerA.rename-own",
    role: "managerA",
    method: "PATCH",
    path: "/api/organizations/{{orgAlpha}}",
    body: { name: "阿尔法组（改名）" },
  },

  // ---------- 收尾：登出 ----------
  { name: "auth.logout.memberA", role: "memberA", method: "POST", path: "/api/auth/logout", freshLogin: true },
  { name: "auth.logout.anon", role: "anon", method: "POST", path: "/api/auth/logout" },
];

import { db, type User } from "./db.server";
import { listNotes } from "./notes.server";
import { listOrganizations } from "./organization.server";
import { notifyOverdueTasks, visible } from "./tasks.server";
import { listTodos } from "./todos.server";

/**
 * 概览页顶部的「数据范围」文案：管理员看的是合并视图，其他人看的是本组织
 * （`orgName` 为空时按 D-24/D-34 明确写出来，而不是含糊地显示为空）。
 * 「谁看得见什么」的角色判断只出现在 dashboard 域模块里，页面不再自己维护旧的角色映射。
 */
export function dashboardScopeLabel(user: User): string {
  if (user.role === "admin") return "全部组织（合并视图）";
  return `本组织：${user.orgName ?? "尚未加入组织"}`;
}

/**
 * 概览页「快捷新增待办」的可选组织：
 * 管理员是全局角色、不隶属任何组织（§3.2），写入时必须显式指定目标组织
 * （records.server 的 `resolveRecordOrg` 对 admin 要求请求里带 `orgId`），所以这里列出可选的组织，
 * 已解散的组织不能写入（`orgIsActive` 会拒绝）故不列出；
 * 普通用户与组织管理者写自己的组织，没有可选项。
 */
export function dashboardTodoOrgs(user: User): Array<{ id: string; name: string }> {
  if (user.role !== "admin") return [];
  return listOrganizations(user)
    .filter((org) => org.status === "active")
    .map((org) => ({ id: org.id, name: org.name }));
}

/**
 * 概览数据：UI 的 loader 与 GET /api/dashboard 共用这一份实现。
 * 全栈迁移的关键约定——**页面不再通过 HTTP 调自己的 API**，而是与资源路由共用服务端函数，
 * 从而根除"两套实现漂移"的可能。
 *
 * 组织隔离（docs/harness/ACCOUNTS_AND_ORGS.md §14.2）：三块数据都**不在这里写组织条件**，
 * 而是各自复用所在域的读函数——任务走 `tasks.server.visible()`、待办走 `todos.server.listTodos()`、
 * 随手记走 `notes.server.listNotes()`；它们的组织范围都由 `orgScope(user)` 推导
 * （管理员为 null = 全部组织的合并视图，D-28；尚未入组的账号在各域里显式兜底为「什么都看不到」）。
 * dashboard 只做汇总，不重复实现过滤——少写一处、也少一处漏过滤导致跨组织泄露的机会。
 */
export function dashboardData(user: User): {
  user: User;
  tasks: unknown[];
  todos: unknown[];
  notes: unknown[];
  stats: { tasks: number; activeTasks: number; pendingTodos: number; notes: number };
} {
  const database = db();
  notifyOverdueTasks(database);
  const tasks = visible(database, user, false) as unknown[];
  const todos = listTodos(user) as unknown[];
  const notes = listNotes(user) as unknown[];
  return {
    user,
    tasks,
    todos,
    notes,
    stats: {
      tasks: tasks.length,
      activeTasks: tasks.filter((task) => (task as { status?: string }).status !== "completed").length,
      pendingTodos: todos.filter((todo) => Number((todo as { isCompleted?: unknown }).isCompleted) === 0).length,
      notes: notes.length,
    },
  };
}

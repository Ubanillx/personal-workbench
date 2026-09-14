import type { TaskPriority, TaskStatus } from "../../shared/types/domain";
import { db, one, type User } from "./db.server";
import { listFiles } from "./files.server";
import { listNotes } from "./notes.server";
import { notifyOverdueTasks, visible } from "./tasks.server";
import { listTodos } from "./todos.server";

/**
 * 概览页顶部的「数据范围」文案：管理员看的是合并视图，其他人看的是本组织
 * （`orgName` 为空时按 D-24/D-34 明确写出来，而不是含糊地显示为空）。
 * 「谁看得见什么」的角色判断只出现在 dashboard 域模块里，页面不再自己维护旧的角色映射。
 *
 * 措辞与 D-54 对齐：组织成员看到的是**本组织全部非私密任务**（私密任务只有发布人 / 负责人 / 管理员），
 * 待办与随手记则是**只有自己**的 —— 三块数据的范围不同，文案不能笼统写成「本组织数据」。
 */
export function dashboardScopeLabel(user: User): string {
  if (user.role === "admin") return "全部组织（合并视图）";
  return `本组织：${user.orgName ?? "尚未加入组织"}（任务：全部非私密）`;
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
 *
 * ⚠️ 这个返回值就是 `GET /api/dashboard` 的响应载荷（契约 golden 逐字段比对），**字段不能增删改**。
 * 概览页需要的额外展板数据放在下面的 `dashboardBoard()` 里，不进 API。
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

/* ------------------------------------------------------------------ 只读展板（页面专用） */

/** 「需要关注」的时间窗：截止日在今天 + 7 天以内（含已逾期） */
const DUE_SOON_DAYS = 7;
/** 展板每个列表最多渲染多少条 */
const BOARD_LIST_SIZE = 6;

export type BoardTask = {
  id: string;
  title: string;
  priority: TaskPriority;
  status: TaskStatus;
  progress: number;
  dueDate: string | null;
  orgName: string | null;
  ownerName: string | null;
};

export type BoardTodo = { id: string; content: string; todoDate: string | null; isCompleted: number };
export type BoardNote = { id: string; content: string; isPinned: number; updatedAt: string };
export type BoardFile = { id: string; name: string; category: string; lastUsedAt: string | null };
export type AttentionTask = BoardTask & { overdue: boolean };

export type DashboardBoard = {
  /** 口径日期（YYYY-MM-DD），页面上标注「今日」用 */
  today: string;
  stats: {
    overdueTasks: number;
    pendingReview: number;
    todayTodos: number;
    overdueTodos: number;
    unreadNotifications: number;
  };
  statusCounts: Array<{ status: TaskStatus; label: string; count: number }>;
  completionRate: number;
  /** 已逾期 + 未来 7 天内到期的未完成任务，按截止日升序 */
  attentionTasks: AttentionTask[];
  /** 未完成待办，按日期升序（逾期在前，无日期最后） */
  openTodos: BoardTodo[];
  recentNotes: BoardNote[];
  /** 重要文件是组织公共数据（D-54），组织内所有人都看得到；字段保留可空只是为了载荷形状不动 */
  recentFiles: BoardFile[] | null;
};

const STATUS_LABEL: Record<TaskStatus, string> = { todo: "待办", in_progress: "进行中", pending_review: "待验收", completed: "已完成" };
const STATUS_ORDER: TaskStatus[] = ["todo", "in_progress", "pending_review", "completed"];

/**
 * 逾期口径与 `review.server.ts` 的统计一致（截止日早于今天且未完成）；
 * 日期一律用 `YYYY-MM-DD` 串比较，与库里 `due_date` / `todo_date` 的存储格式相同。
 */
function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateAfterDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function text(value: unknown): string {
  return String(value ?? "");
}
function nullableText(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function toBoardTask(row: unknown): BoardTask {
  const task = row as Record<string, unknown>;
  return {
    id: text(task.id),
    title: text(task.title),
    priority: text(task.priority) as TaskPriority,
    status: text(task.status) as TaskStatus,
    progress: Number(task.progress ?? 0),
    dueDate: nullableText(task.dueDate),
    orgName: nullableText(task.orgName),
    ownerName: nullableText(task.ownerName),
  };
}

function toBoardTodo(row: unknown): BoardTodo {
  const todo = row as Record<string, unknown>;
  return {
    id: text(todo.id),
    content: text(todo.content),
    todoDate: nullableText(todo.todoDate),
    isCompleted: Number(todo.isCompleted ?? 0),
  };
}

function toBoardNote(row: unknown): BoardNote {
  const note = row as Record<string, unknown>;
  return {
    id: text(note.id),
    content: text(note.content),
    isPinned: Number(note.isPinned ?? 0),
    updatedAt: text(note.updatedAt),
  };
}

function toBoardFile(row: Record<string, unknown>): BoardFile {
  return {
    id: text(row.id),
    name: text(row.name),
    category: text(row.category),
    lastUsedAt: nullableText(row.lastUsedAt),
  };
}

/** 未读通知数与外壳右上角的铃铛徽标同源（同一张表、同一条件） */
function unreadNotifications(userId: string): number {
  return one<{ n: number }>(db(), "SELECT COUNT(*) AS n FROM notifications WHERE recipient_id=? AND is_read=0", userId)?.n ?? 0;
}

/**
 * 概览页的只读展板：在 `dashboardData()` 的结果上做派生，**不再重复查任务/待办/随手记**
 * （`base` 由调用方传入，页面 loader 只需取一次数据）。
 *
 * 页面只展示、不写入，所以这里没有任何写操作；组织范围仍由 base 里各域的读函数保证，
 * 新增的两处查询（未读通知、重要文件）也各自带着自己的边界：通知按收件人，
 * 文件复用 `files.server.listFiles()`（同 `recordClauses(user)`）且只给管理员 / 组织管理者取。
 */
export function dashboardBoard(user: User, base: { tasks: unknown[]; todos: unknown[]; notes: unknown[] }): DashboardBoard {
  const today = todayString();
  const dueSoon = dateAfterDays(DUE_SOON_DAYS);
  const tasks = base.tasks.map(toBoardTask);
  const todos = base.todos.map(toBoardTodo);
  const notes = base.notes.map(toBoardNote);

  // 未完成任务里「截止日 ≤ 今天 + 7 天」的都要盯（含已逾期，逾期日期必定早于今天）
  const attentionTasks = tasks
    .filter((task) => task.status !== "completed" && task.dueDate !== null && task.dueDate <= dueSoon)
    .map((task) => ({
      id: task.id,
      title: task.title,
      priority: task.priority,
      status: task.status,
      progress: task.progress,
      dueDate: task.dueDate,
      orgName: task.orgName,
      ownerName: task.ownerName,
      overdue: task.dueDate !== null && task.dueDate < today,
    }))
    .toSorted((left, right) => text(left.dueDate).localeCompare(text(right.dueDate)))
    .slice(0, BOARD_LIST_SIZE);

  // 未完成待办按日期升序：逾期的最前面，没有日期的排最后
  const openTodos = todos
    .filter((todo) => todo.isCompleted === 0)
    .toSorted((left, right) => (left.todoDate ?? "9999-12-31").localeCompare(right.todoDate ?? "9999-12-31"))
    .slice(0, BOARD_LIST_SIZE);

  // 置顶优先，其次按更新时间（listNotes 已按 updated_at DESC 排序）
  const recentNotes = notes.toSorted((left, right) => right.isPinned - left.isPinned).slice(0, BOARD_LIST_SIZE);

  /**
   * 重要文件是**组织公共数据**（D-54）：组织内所有人（含普通成员）都看得到，
   * 只有删除限组织管理者与管理员 —— 概览展板只读，因此这里不再按角色收窄。
   */
  const recentFiles = listFiles(user, "", "", null).slice(0, BOARD_LIST_SIZE).map(toBoardFile);
  const completed = tasks.filter((task) => task.status === "completed").length;

  return {
    today,
    stats: {
      overdueTasks: tasks.filter((task) => task.status !== "completed" && task.dueDate !== null && task.dueDate < today).length,
      pendingReview: tasks.filter((task) => task.status === "pending_review").length,
      todayTodos: todos.filter((todo) => todo.isCompleted === 0 && todo.todoDate === today).length,
      overdueTodos: todos.filter((todo) => todo.isCompleted === 0 && todo.todoDate !== null && todo.todoDate < today).length,
      unreadNotifications: unreadNotifications(user.id),
    },
    statusCounts: STATUS_ORDER.map((status) => ({
      status,
      label: STATUS_LABEL[status],
      count: tasks.filter((task) => task.status === status).length,
    })),
    completionRate: tasks.length ? Math.round((completed / tasks.length) * 100) : 0,
    attentionTasks,
    openTodos,
    recentNotes,
    recentFiles,
  };
}

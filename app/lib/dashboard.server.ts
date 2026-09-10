import { db, rows, type User } from "./db.server";
import { notifyOverdueTasks, visible } from "./tasks.server";

/**
 * 概览数据：UI 的 loader 与 GET /api/dashboard 共用这一份实现。
 * 全栈迁移的关键约定——**页面不再通过 HTTP 调自己的 API**，而是与资源路由共用服务端函数，
 * 从而根除"两套实现漂移"的可能。
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
  const todos =
    user.role === "owner"
      ? rows(
          database,
          "SELECT id,content,todo_date AS todoDate,is_completed AS isCompleted,completed_at AS completedAt,created_at AS createdAt,updated_at AS updatedAt FROM todos ORDER BY created_at DESC",
        )
      : [];
  const notes =
    user.role === "owner"
      ? rows(
          database,
          "SELECT id,content,is_pinned AS isPinned,created_at AS createdAt,updated_at AS updatedAt FROM notes ORDER BY updated_at DESC",
        )
      : [];
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

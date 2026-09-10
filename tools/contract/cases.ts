export type Role = "owner" | "assistant" | "assistantB" | "viewer";
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
 * 48 个端点 × 三角色 + 边界用例的契约清单。
 * 只描述"怎么请求"，不描述"期望什么"——期望值由当前实现录制成 golden。
 */
export const CASES: ContractCase[] = [
  // ---------- health（2） ----------
  { name: "health.ping.anon", role: "anon", method: "GET", path: "/api/ping" },
  { name: "health.status.anon", role: "anon", method: "GET", path: "/api/health" },
  { name: "health.status.owner", role: "owner", method: "GET", path: "/api/health" },

  // ---------- auth（4） ----------
  { name: "auth.access.bad-token", role: "anon", method: "POST", path: "/api/auth/access", body: { token: "not-a-token" } },
  { name: "auth.access.owner", role: "owner", method: "POST", path: "/api/auth/access", body: { token: "owner-token" }, freshLogin: true },
  { name: "auth.access.missing-body", role: "anon", method: "POST", path: "/api/auth/access", body: {} },
  { name: "auth.me.anon", role: "anon", method: "GET", path: "/api/auth/me" },
  { name: "auth.me.owner", role: "owner", method: "GET", path: "/api/auth/me" },
  { name: "auth.me.assistant", role: "assistant", method: "GET", path: "/api/auth/me" },
  { name: "auth.me.viewer", role: "viewer", method: "GET", path: "/api/auth/me" },
  { name: "access-info.owner", role: "owner", method: "GET", path: "/api/access-info" },
  { name: "access-info.assistant", role: "assistant", method: "GET", path: "/api/access-info" },
  { name: "access-info.viewer", role: "viewer", method: "GET", path: "/api/access-info" },

  // ---------- dashboard（1） ----------
  { name: "dashboard.owner", role: "owner", method: "GET", path: "/api/dashboard" },
  { name: "dashboard.assistant", role: "assistant", method: "GET", path: "/api/dashboard" },
  { name: "dashboard.viewer", role: "viewer", method: "GET", path: "/api/dashboard" },

  // ---------- tasks 读（含可见性） ----------
  { name: "tasks.list.anon", role: "anon", method: "GET", path: "/api/tasks" },
  { name: "tasks.list.owner", role: "owner", method: "GET", path: "/api/tasks" },
  { name: "tasks.list.owner.archived", role: "owner", method: "GET", path: "/api/tasks?includeArchived=1" },
  { name: "tasks.list.assistant", role: "assistant", method: "GET", path: "/api/tasks" },
  { name: "tasks.list.assistant.archived", role: "assistant", method: "GET", path: "/api/tasks?includeArchived=1" },
  { name: "tasks.list.assistantB", role: "assistantB", method: "GET", path: "/api/tasks" },
  { name: "tasks.list.viewer", role: "viewer", method: "GET", path: "/api/tasks" },

  // ---------- tasks 写 ----------
  {
    name: "tasks.create.owner",
    role: "owner",
    method: "POST",
    path: "/api/tasks",
    body: { title: "契约-主人创建", ownerId: "assistant-a", priority: "P1", dueDate: "2026-12-31", description: "契约用例" },
    capture: { taskCreated: "data.id" },
  },
  { name: "tasks.create.owner.private", role: "owner", method: "POST", path: "/api/tasks", body: { title: "契约-私密", isPrivate: true } },
  {
    name: "tasks.create.owner.private-to-assistant",
    role: "owner",
    method: "POST",
    path: "/api/tasks",
    body: { title: "契约-私密给助理", isPrivate: true, ownerId: "assistant-a" },
  },
  { name: "tasks.create.owner.no-title", role: "owner", method: "POST", path: "/api/tasks", body: {} },
  {
    name: "tasks.create.assistant",
    role: "assistant",
    method: "POST",
    path: "/api/tasks",
    body: { title: "契约-助理创建", ownerId: "assistant-b" },
  },
  { name: "tasks.create.viewer", role: "viewer", method: "POST", path: "/api/tasks", body: { title: "契约-查看者创建" } },
  {
    name: "tasks.create.owner.to-delete",
    role: "owner",
    method: "POST",
    path: "/api/tasks",
    body: { title: "契约-待删除" },
    capture: { taskDel: "data.id" },
  },

  {
    name: "tasks.patch.owner",
    role: "owner",
    method: "PATCH",
    path: "/api/tasks/{{taskCreated}}",
    body: { title: "契约-改名", priority: "P2" },
  },
  { name: "tasks.patch.reject-progress", role: "owner", method: "PATCH", path: "/api/tasks/{{taskCreated}}", body: { progress: 50 } },
  { name: "tasks.patch.archived", role: "owner", method: "PATCH", path: "/api/tasks/{{taskArchived}}", body: { title: "改归档任务" } },
  { name: "tasks.patch.bad-owner", role: "owner", method: "PATCH", path: "/api/tasks/{{taskCreated}}", body: { ownerId: "nobody" } },
  { name: "tasks.patch.missing", role: "owner", method: "PATCH", path: "/api/tasks/no-such-task", body: { title: "x" } },
  { name: "tasks.patch.assistant", role: "assistant", method: "PATCH", path: "/api/tasks/{{taskCreated}}", body: { title: "x" } },

  // ---------- 任务流转 ----------
  {
    name: "tasks.progress.assistant",
    role: "assistant",
    method: "POST",
    path: "/api/tasks/{{taskCreated}}/progress",
    body: { progress: 30, content: "已完成三成" },
  },
  { name: "tasks.progress.other-task", role: "assistant", method: "POST", path: "/api/tasks/{{taskOfB}}/progress", body: { progress: 30 } },
  {
    name: "tasks.progress.invalid-value",
    role: "assistant",
    method: "POST",
    path: "/api/tasks/{{taskCreated}}/progress",
    body: { progress: 200 },
  },
  { name: "tasks.submit-review.assistant", role: "assistant", method: "POST", path: "/api/tasks/{{taskCreated}}/submit-review", body: {} },
  { name: "tasks.approve.owner", role: "owner", method: "POST", path: "/api/tasks/{{taskCreated}}/approve", body: {} },
  { name: "tasks.return.owner", role: "owner", method: "POST", path: "/api/tasks/{{taskCreated}}/return", body: { note: "请补充截图" } },
  { name: "tasks.return.viewer", role: "viewer", method: "POST", path: "/api/tasks/{{taskCreated}}/return", body: { note: "x" } },
  { name: "tasks.archive.owner", role: "owner", method: "POST", path: "/api/tasks/{{taskCreated}}/archive" },
  { name: "tasks.archive.again", role: "owner", method: "POST", path: "/api/tasks/{{taskCreated}}/archive" },
  { name: "tasks.restore.owner", role: "owner", method: "POST", path: "/api/tasks/{{taskCreated}}/restore" },
  { name: "tasks.restore.again", role: "owner", method: "POST", path: "/api/tasks/{{taskCreated}}/restore" },
  { name: "tasks.delete.missing", role: "owner", method: "DELETE", path: "/api/tasks/no-such-task" },

  // ---------- 评论与时间线 ----------
  { name: "comments.list.owner", role: "owner", method: "GET", path: "/api/tasks/{{taskDoing}}/comments" },
  {
    name: "comments.create.assistant",
    role: "assistant",
    method: "POST",
    path: "/api/tasks/{{taskDoing}}/comments",
    body: { content: "助理评论" },
  },
  {
    name: "comments.create.other-task",
    role: "assistant",
    method: "POST",
    path: "/api/tasks/{{taskOfB}}/comments",
    body: { content: "越权评论" },
  },
  {
    name: "comments.create.viewer",
    role: "viewer",
    method: "POST",
    path: "/api/tasks/{{taskDoing}}/comments",
    body: { content: "查看者评论" },
  },
  {
    name: "comments.create.private-task",
    role: "viewer",
    method: "POST",
    path: "/api/tasks/{{taskPrivate}}/comments",
    body: { content: "越权评论" },
  },
  { name: "comments.create.empty", role: "owner", method: "POST", path: "/api/tasks/{{taskDoing}}/comments", body: { content: "  " } },
  { name: "activity.owner", role: "owner", method: "GET", path: "/api/tasks/{{taskDoing}}/activity" },
  { name: "activity.anon", role: "anon", method: "GET", path: "/api/tasks/{{taskDoing}}/activity" },
  { name: "activity.missing", role: "owner", method: "GET", path: "/api/tasks/no-such-task/activity" },

  // ---------- 通知 ----------
  { name: "notifications.owner", role: "owner", method: "GET", path: "/api/notifications" },
  { name: "notifications.owner.unread", role: "owner", method: "GET", path: "/api/notifications?unread=1" },
  { name: "notifications.assistant.unread", role: "assistant", method: "GET", path: "/api/notifications?unread=1" },
  { name: "notifications.viewer", role: "viewer", method: "GET", path: "/api/notifications" },
  { name: "notifications.read.task", role: "owner", method: "POST", path: "/api/notifications/read", body: { taskId: "{{taskDoing}}" } },
  { name: "notifications.read.all", role: "owner", method: "POST", path: "/api/notifications/read", body: {} },

  // ---------- 验收视图 ----------
  { name: "review.owner", role: "owner", method: "GET", path: "/api/review" },
  { name: "review.owner.status", role: "owner", method: "GET", path: "/api/review?status=pending_review" },
  { name: "review.owner.range", role: "owner", method: "GET", path: "/api/review?from=2026-09-01&to=2026-09-30" },
  { name: "review.owner.ownerId", role: "owner", method: "GET", path: "/api/review?ownerId=assistant-a" },
  { name: "review.assistant", role: "assistant", method: "GET", path: "/api/review" },

  // ---------- 企微收件箱 ----------
  {
    name: "inbox.preview.owner",
    role: "owner",
    method: "POST",
    path: "/api/inbox/preview",
    body: { drafts: [{ title: "企微草稿", sender: "张三", priority: "P1", messageAt: "2026-09-01 10:23" }] },
  },
  {
    name: "inbox.preview.assistant",
    role: "assistant",
    method: "POST",
    path: "/api/inbox/preview",
    body: { drafts: [{ title: "企微草稿" }] },
  },
  { name: "inbox.preview.viewer", role: "viewer", method: "POST", path: "/api/inbox/preview", body: { drafts: [{ title: "企微草稿" }] } },
  {
    name: "inbox.import.owner",
    role: "owner",
    method: "POST",
    path: "/api/inbox/import",
    body: { drafts: [{ title: "企微导入", ownerId: "assistant-b", priority: "P1", fingerprint: "fp-contract" }] },
  },
  {
    name: "inbox.import.duplicate",
    role: "owner",
    method: "POST",
    path: "/api/inbox/import",
    body: { drafts: [{ title: "企微导入", ownerId: "assistant-b", priority: "P1", fingerprint: "fp-contract" }] },
  },
  {
    name: "inbox.import.allow-duplicates",
    role: "owner",
    method: "POST",
    path: "/api/inbox/import",
    body: { drafts: [{ title: "企微导入", ownerId: "assistant-b", priority: "P1", fingerprint: "fp-contract" }], allowDuplicates: true },
  },
  {
    name: "inbox.import.assistant",
    role: "assistant",
    method: "POST",
    path: "/api/inbox/import",
    body: { drafts: [{ title: "助理导入", fingerprint: "fp-a" }] },
  },
  { name: "inbox.import.viewer", role: "viewer", method: "POST", path: "/api/inbox/import", body: { drafts: [] } },

  // ---------- 成员管理 ----------
  { name: "users.list.owner", role: "owner", method: "GET", path: "/api/users" },
  { name: "users.list.assistant", role: "assistant", method: "GET", path: "/api/users" },
  {
    name: "users.create.owner",
    role: "owner",
    method: "POST",
    path: "/api/users",
    body: { name: "契约成员", role: "assistant" },
    capture: { newUserId: "data.user.id" },
  },
  { name: "users.create.no-name", role: "owner", method: "POST", path: "/api/users", body: { name: "", role: "assistant" } },
  { name: "users.create.bad-role", role: "owner", method: "POST", path: "/api/users", body: { name: "契约成员2", role: "boss" } },
  { name: "users.create.assistant", role: "assistant", method: "POST", path: "/api/users", body: { name: "越权成员", role: "assistant" } },
  { name: "users.deactivate", role: "owner", method: "PATCH", path: "/api/users/{{newUserId}}", body: { isActive: false } },
  { name: "users.deactivate.owner", role: "owner", method: "PATCH", path: "/api/users/owner", body: { isActive: false } },
  { name: "users.deactivate.missing", role: "owner", method: "PATCH", path: "/api/users/no-such-user", body: { isActive: false } },
  { name: "users.rotate-token", role: "owner", method: "POST", path: "/api/users/{{newUserId}}/token" },
  { name: "users.rotate-token.missing", role: "owner", method: "POST", path: "/api/users/no-such-user/token" },
  { name: "users.reactivate", role: "owner", method: "PATCH", path: "/api/users/{{newUserId}}", body: { isActive: true } },

  // ---------- 待办 ----------
  { name: "todos.list.owner", role: "owner", method: "GET", path: "/api/todos" },
  { name: "todos.list.assistant", role: "assistant", method: "GET", path: "/api/todos" },
  { name: "todos.list.viewer", role: "viewer", method: "GET", path: "/api/todos" },
  {
    name: "todos.create.owner",
    role: "owner",
    method: "POST",
    path: "/api/todos",
    body: { content: "契约待办", todoDate: "2026-09-05" },
    capture: { todoId: "data.id" },
  },
  { name: "todos.create.empty", role: "owner", method: "POST", path: "/api/todos", body: {} },
  { name: "todos.patch.owner", role: "owner", method: "PATCH", path: "/api/todos/{{todoId}}", body: { isCompleted: true } },
  { name: "todos.patch.missing", role: "owner", method: "PATCH", path: "/api/todos/no-such-todo", body: { isCompleted: true } },
  { name: "todos.delete.viewer", role: "viewer", method: "DELETE", path: "/api/todos/{{todoId}}" },
  { name: "todos.delete.owner", role: "owner", method: "DELETE", path: "/api/todos/{{todoId}}" },
  { name: "todos.delete.missing", role: "owner", method: "DELETE", path: "/api/todos/no-such-todo" },

  // ---------- 随手记 ----------
  { name: "notes.list.owner", role: "owner", method: "GET", path: "/api/notes" },
  { name: "notes.list.assistant", role: "assistant", method: "GET", path: "/api/notes" },
  {
    name: "notes.create.owner",
    role: "owner",
    method: "POST",
    path: "/api/notes",
    body: { content: "契约随手记", isPinned: true },
    capture: { noteId: "data.id" },
  },
  { name: "notes.create.empty", role: "owner", method: "POST", path: "/api/notes", body: {} },
  { name: "notes.patch.owner", role: "owner", method: "PATCH", path: "/api/notes/{{noteId}}", body: { content: "改过的随手记" } },
  { name: "notes.patch.missing", role: "owner", method: "PATCH", path: "/api/notes/no-such-note", body: { content: "x" } },
  { name: "notes.delete.owner", role: "owner", method: "DELETE", path: "/api/notes/{{noteId}}" },
  { name: "notes.delete.missing", role: "owner", method: "DELETE", path: "/api/notes/no-such-note" },

  // ---------- 重要文件 ----------
  { name: "files.list.owner", role: "owner", method: "GET", path: "/api/files" },
  { name: "files.list.search", role: "owner", method: "GET", path: "/api/files?search=报价" },
  { name: "files.list.category", role: "owner", method: "GET", path: "/api/files?category=报价" },
  { name: "files.list.assistant", role: "assistant", method: "GET", path: "/api/files" },
  {
    name: "files.create.owner",
    role: "owner",
    method: "POST",
    path: "/api/files",
    body: { name: "契约文件", filePath: "C:\\fixture\\contract.xlsx", category: "报价" },
    capture: { fileId: "data.id" },
  },
  { name: "files.create.empty", role: "owner", method: "POST", path: "/api/files", body: { name: "", filePath: "" } },
  { name: "files.use.owner", role: "owner", method: "POST", path: "/api/files/{{fileId}}/use" },
  { name: "files.use.missing", role: "owner", method: "POST", path: "/api/files/no-such-file/use" },
  { name: "files.delete.owner", role: "owner", method: "DELETE", path: "/api/files/{{fileId}}" },

  // ---------- 周报 ----------
  { name: "reports.list.viewer", role: "viewer", method: "GET", path: "/api/reports" },
  { name: "reports.list.owner", role: "owner", method: "GET", path: "/api/reports" },
  { name: "reports.list.assistant", role: "assistant", method: "GET", path: "/api/reports" },
  { name: "reports.detail.owner", role: "owner", method: "GET", path: "/api/reports/{{reportSubmitted}}" },
  { name: "reports.detail.assistant", role: "assistant", method: "GET", path: "/api/reports/{{reportSubmitted}}" },
  { name: "reports.detail.missing", role: "assistant", method: "GET", path: "/api/reports/no-such-report" },
  { name: "reports.download.v1", role: "owner", method: "GET", path: "/api/reports/{{reportSubmitted}}/file/1" },
  { name: "reports.download.missing-version", role: "owner", method: "GET", path: "/api/reports/{{reportSubmitted}}/file/9" },
  { name: "reports.return.no-note", role: "owner", method: "POST", path: "/api/reports/{{reportSubmitted}}/return", body: {} },
  {
    name: "reports.return.owner",
    role: "owner",
    method: "POST",
    path: "/api/reports/{{reportSubmitted}}/return",
    body: { note: "请补充数据" },
  },
  { name: "reports.approve.assistant", role: "assistant", method: "POST", path: "/api/reports/{{reportSubmitted}}/approve", body: {} },
  {
    name: "reports.approve.owner",
    role: "owner",
    method: "POST",
    path: "/api/reports/{{reportSubmitted}}/approve",
    body: { note: "通过" },
  },
  {
    name: "reports.create.assistant-upload",
    role: "assistant",
    method: "POST",
    path: "/api/reports",
    upload: {
      fields: { periodStart: "2026-09-01", periodEnd: "2026-09-07", docType: "weekly_report", note: "契约第一周" },
      filename: "contract-week1.xlsx",
      content: "fake-xlsx-contract",
    },
    capture: { reportNew: "data.id" },
  },
  {
    name: "reports.create.viewer-upload",
    role: "viewer",
    method: "POST",
    path: "/api/reports",
    upload: {
      fields: { periodStart: "2026-09-01", periodEnd: "2026-09-07", docType: "weekly_report" },
      filename: "contract-week1.xlsx",
      content: "fake-xlsx-contract",
    },
  },
  {
    name: "reports.create.owner-proxy",
    role: "owner",
    method: "POST",
    path: "/api/reports",
    upload: {
      fields: { ownerId: "assistant-b", periodStart: "2026-09-01", periodEnd: "2026-09-07", docType: "summary" },
      filename: "contract-summary.docx",
      content: "fake-docx-contract",
    },
    capture: { reportProxy: "data.id" },
  },
  {
    name: "reports.create.bad-ext",
    role: "assistant",
    method: "POST",
    path: "/api/reports",
    upload: {
      fields: { periodStart: "2026-09-01", periodEnd: "2026-09-07", docType: "weekly_report" },
      filename: "evil.exe",
      content: "x",
    },
  },
  {
    name: "reports.upload-new-version",
    role: "assistant",
    method: "POST",
    path: "/api/reports/{{reportNew}}/file",
    upload: { fields: {}, filename: "contract-week1-v2.xlsx", content: "fake-xlsx-contract-v2" },
  },
  { name: "reports.download.uploaded", role: "owner", method: "GET", path: "/api/reports/{{reportNew}}/file/1" },
  { name: "reports.download.uploaded-v2", role: "owner", method: "GET", path: "/api/reports/{{reportNew}}/file/2" },
  { name: "reports.detail.other-owner", role: "assistant", method: "GET", path: "/api/reports/{{reportProxy}}" },
  {
    name: "reports.upload.missing-report",
    role: "owner",
    method: "POST",
    path: "/api/reports/no-such-report/file",
    upload: { fields: {}, filename: "a.xlsx", content: "x" },
  },

  // ---------- 收尾：删除任务与登出 ----------
  { name: "tasks.delete.owner", role: "owner", method: "DELETE", path: "/api/tasks/{{taskDel}}" },
  { name: "auth.logout.viewer", role: "viewer", method: "POST", path: "/api/auth/logout", freshLogin: true },
  { name: "auth.logout.anon", role: "anon", method: "POST", path: "/api/auth/logout" },
];

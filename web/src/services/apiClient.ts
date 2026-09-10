import type { ApiResponse } from "../../../shared/types/api";

export class ApiClientError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    }
  });
  let payload: ApiResponse<T> | null = null;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiClientError("服务返回了无法解析的响应", response.status, "INVALID_RESPONSE");
  }

  if (!response.ok || !payload.ok) {
    const error = payload.ok ? { code: "HTTP_ERROR", message: "请求失败" } : payload.error;
    throw new ApiClientError(error.message, response.status, error.code);
  }
  return payload.data;
}

export function access(token: string): Promise<{ user: import("../../../shared/types/domain").CurrentUser }> {
  return request<{ user: import("../../../shared/types/domain").CurrentUser }>("/auth/access", { method: "POST", body: JSON.stringify({ token }) });
}

export function getHealth(): Promise<unknown> {
  return request("/health");
}

export type DashboardData = {
  user: import("../../../shared/types/domain").CurrentUser;
  tasks: import("../../../shared/types/domain").Task[];
  todos: import("../../../shared/types/domain").Todo[];
  notes: import("../../../shared/types/domain").Note[];
  stats: { tasks: number; activeTasks: number; pendingTodos: number; notes: number };
};

export const getMe = () => request<{ user: import("../../../shared/types/domain").CurrentUser }>("/auth/me");
export type AccessInfo = { port: number; host: string; localUrl: string; lanUrls: string[]; warning: string };
export const getAccessInfo = () => request<AccessInfo>("/access-info");
export const getDashboard = () => request<DashboardData>("/dashboard");
export const getTasks = (filters: { includeArchived?: boolean; status?: string; assignee?: string } = {}) => request<import("../../../shared/types/domain").Task[]>(`/tasks?${new URLSearchParams({ ...(filters.includeArchived ? { includeArchived: "1" } : {}), ...(filters.status ? { status: filters.status } : {}), ...(filters.assignee ? { assignee: filters.assignee } : {}) }).toString()}`);
export const createTask = (input: Record<string, unknown>) => request<import("../../../shared/types/domain").Task>("/tasks", { method: "POST", body: JSON.stringify(input) });
export const updateTask = (id: string, input: Record<string, unknown>) => request<import("../../../shared/types/domain").Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const deleteTask = (id: string) => request<null>(`/tasks/${id}`, { method: "DELETE" });
export type ActivityItem = { id: string; kind: string; authorId: string | null; authorName: string | null; content: string; progress: number | null; createdAt: string };
export const getTaskActivity = (id: string) => request<ActivityItem[]>(`/tasks/${id}/activity`);
export const postTaskProgress = (id: string, input: { progress: number; note?: string }) => request<import("../../../shared/types/domain").Task>(`/tasks/${id}/progress`, { method: "POST", body: JSON.stringify(input) });
export const submitTaskReview = (id: string, note?: string) => request<import("../../../shared/types/domain").Task>(`/tasks/${id}/submit-review`, { method: "POST", body: JSON.stringify({ note }) });
export const approveTask = (id: string, note?: string) => request<import("../../../shared/types/domain").Task>(`/tasks/${id}/approve`, { method: "POST", body: JSON.stringify({ note }) });
export const returnTask = (id: string, note: string) => request<import("../../../shared/types/domain").Task>(`/tasks/${id}/return`, { method: "POST", body: JSON.stringify({ note }) });
export const archiveTask = (id: string) => request<null>(`/tasks/${id}/archive`, { method: "POST" });
export const restoreTask = (id: string) => request<import("../../../shared/types/domain").Task>(`/tasks/${id}/restore`, { method: "POST" });
export const addTaskComment = (id: string, content: string) => request<ActivityItem>(`/tasks/${id}/comments`, { method: "POST", body: JSON.stringify({ content }) });
export const getTodos = () => request<import("../../../shared/types/domain").Todo[]>("/todos");
export const createTodo = (input: Record<string, unknown>) => request<import("../../../shared/types/domain").Todo>("/todos", { method: "POST", body: JSON.stringify(input) });
export const updateTodo = (id: string, input: Record<string, unknown>) => request<import("../../../shared/types/domain").Todo>(`/todos/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const deleteTodo = (id: string) => request<null>(`/todos/${id}`, { method: "DELETE" });
export const getNotes = () => request<import("../../../shared/types/domain").Note[]>("/notes");
export const createNote = (input: Record<string, unknown>) => request<import("../../../shared/types/domain").Note>("/notes", { method: "POST", body: JSON.stringify(input) });
export const deleteNote = (id: string) => request<null>(`/notes/${id}`, { method: "DELETE" });
export type ImportantFile = { id: string; name: string; filePath: string; category: string; lastUsedAt: string | null; createdAt: string; updatedAt: string };
export type Collaborator = { id: string; name: string; role: "owner" | "assistant" | "viewer"; isActive: boolean; createdAt: string; updatedAt: string };
export const getFiles = (search = "", category = "") => request<ImportantFile[]>(`/files?${new URLSearchParams({ ...(search ? { search } : {}), ...(category ? { category } : {}) }).toString()}`);
export const createFile = (input: { name: string; filePath: string; category?: string }) => request<ImportantFile>("/files", { method: "POST", body: JSON.stringify(input) });
export const markFileUsed = (id: string) => request<ImportantFile>(`/files/${id}/use`, { method: "POST" });
export const deleteFile = (id: string) => request<null>(`/files/${id}`, { method: "DELETE" });
export const getUsers = () => request<Collaborator[]>("/users");
export const createUser = (input: { name: string; role: "assistant" | "viewer" }) => request<{ user: Collaborator; token: string }>("/users", { method: "POST", body: JSON.stringify(input) });
export const updateUser = (id: string, isActive: boolean) => request<null>(`/users/${id}`, { method: "PATCH", body: JSON.stringify({ isActive }) });
export const rotateUserToken = (id: string) => request<{ token: string }>(`/users/${id}/token`, { method: "POST" });
export type InboxDraft = { title: string; dueDate: string | null; description?: string; priority?: string; ownerId?: string; fingerprint?: string; sender?: string; messageAt?: string; duplicate?: boolean };
export const previewInbox = (drafts: InboxDraft[]) => request<InboxDraft[]>("/inbox/preview", { method: "POST", body: JSON.stringify({ drafts }) });
export const importInbox = (drafts: InboxDraft[]) => request<{ created: import("../../../shared/types/domain").Task[]; skipped: Array<{ title: string; reason: string }> }>("/inbox/import", { method: "POST", body: JSON.stringify({ drafts }) });
export type ReviewData = { tasks: import("../../../shared/types/domain").Task[]; summary: { total: number; completed: number; active: number; overdue: number; completionRate: number } };
export const getReview = (filters: { from?: string; to?: string; ownerId?: string; status?: string } = {}) => request<ReviewData>(`/review?${new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, value]) => Boolean(value))) as Record<string, string>).toString()}`);
export const logout = () => request<null>("/auth/logout", { method: "POST" });
export type Notification = { id: string; recipientId: string; actorId: string | null; taskId: string | null; reportId: string | null; eventType: string; title: string; message: string; isRead: boolean | number; createdAt: string; readAt: string | null };
export const getNotifications = (unread = false) => request<Notification[]>(`/notifications${unread ? "?unread=1" : ""}`);
export const markNotificationsRead = (input: { all?: boolean; taskId?: string; ids?: string[] }) => request<null>("/notifications/read", { method: "POST", body: JSON.stringify(input) });

export type Report = import("../../../shared/types/domain").Report;
export type ReportDocType = import("../../../shared/types/domain").ReportDocType;
export const getReports = () => request<Report[]>("/reports");
export const getReport = (id: string) => request<Report>(`/reports/${id}`);
export const approveReport = (id: string, note?: string) => request<Report>(`/reports/${id}/approve`, { method: "POST", body: JSON.stringify({ note }) });
export const returnReport = (id: string, note: string) => request<Report>(`/reports/${id}/return`, { method: "POST", body: JSON.stringify({ note }) });
export const reportFileUrl = (id: string, version: number) => `/api/reports/${id}/file/${version}`;

export function uploadReport(input: { file: File; ownerId: string; periodStart: string; periodEnd: string; docType: ReportDocType; note?: string }): Promise<Report> {
  const form = new FormData();
  form.append("file", input.file);
  form.append("ownerId", input.ownerId);
  form.append("periodStart", input.periodStart);
  form.append("periodEnd", input.periodEnd);
  form.append("docType", input.docType);
  form.append("note", input.note ?? "");
  return uploadForm<Report>("/reports", form);
}

export function uploadReportVersion(id: string, file: File): Promise<Report> {
  const form = new FormData();
  form.append("file", file);
  return uploadForm<Report>(`/reports/${id}/file`, form);
}

async function uploadForm<T>(path: string, formData: FormData): Promise<T> {
  const response = await fetch(`/api${path}`, { method: "POST", credentials: "include", body: formData });
  let payload: ApiResponse<T> | null = null;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiClientError("服务返回了无法解析的响应", response.status, "INVALID_RESPONSE");
  }
  if (!response.ok || !payload.ok) {
    const error = payload.ok ? { code: "HTTP_ERROR", message: "请求失败" } : payload.error;
    throw new ApiClientError(error.message, response.status, error.code);
  }
  return payload.data;
}

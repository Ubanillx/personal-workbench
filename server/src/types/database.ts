import { createHash } from "node:crypto";

export type UserRole = "owner" | "assistant" | "viewer";
export type LegacyTaskStatus = "todo" | "doing" | "in_progress" | "done" | "completed";
export type TaskStatus = "todo" | "in_progress" | "pending_review" | "completed";
export type TaskPriority = "P0" | "P1" | "P2";
export type TaskSource = "manual" | "wecom" | "api" | "assistant";

export type LegacyMember = {
  id: string;
  name: string;
  token: string;
  createdAt?: number;
};

export type LegacyTaskLog = { t: number; text: string; by?: string; progress?: number };
export type LegacyTaskComment = { t: number; text: string; by?: string; role?: UserRole };

export type LegacyTask = {
  id: string;
  title: string;
  desc?: string;
  priority: TaskPriority;
  status: LegacyTaskStatus;
  progress: number;
  due?: string | null;
  assignee?: string;
  logs?: LegacyTaskLog[];
  comments?: LegacyTaskComment[];
  source?: TaskSource;
  createdAt: number;
  doneAt?: number | null;
};

export type LegacyTodo = { id: string; text: string; done: boolean; date?: string | null; createdAt: number; doneAt?: number | null };
export type LegacyNote = { id: string; text: string; pinned?: boolean; createdAt: number };
export type LegacyFile = { id: string; name: string; path: string; createdAt: number };

export type LegacyWorkbench = {
  tasks: LegacyTask[];
  todos: LegacyTodo[];
  notes: LegacyNote[];
  files: LegacyFile[];
  settings: {
    apiToken?: string | undefined;
    ownerToken?: string | undefined;
    shareToken?: string | undefined;
    assistants: LegacyMember[];
    viewers: LegacyMember[];
  };
};

export type MigrationStatistics = {
  tasks: number;
  todos: number;
  notes: number;
  assistants: number;
  viewers: number;
  logs: number;
  comments: number;
  files: number;
  correctedStatuses: number;
  fallbackCreators: number;
};

export function createEmptyStatistics(): MigrationStatistics {
  return { tasks: 0, todos: 0, notes: 0, assistants: 0, viewers: 0, logs: 0, comments: 0, files: 0, correctedStatuses: 0, fallbackCreators: 0 };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isoFromMillis(value: number | null | undefined, fallback: string): string {
  if (!Number.isFinite(value)) return fallback;
  return new Date(value as number).toISOString();
}

export function assertNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

export function normalizeLegacyWorkbench(value: unknown): LegacyWorkbench {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Legacy JSON root must be an object");
  const raw = value as Partial<LegacyWorkbench>;
  const settings: Partial<LegacyWorkbench["settings"]> = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
  return {
    tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    todos: Array.isArray(raw.todos) ? raw.todos : [],
    notes: Array.isArray(raw.notes) ? raw.notes : [],
    files: Array.isArray(raw.files) ? raw.files : [],
    settings: {
      apiToken: typeof settings.apiToken === "string" ? settings.apiToken : undefined,
      ownerToken: typeof settings.ownerToken === "string" ? settings.ownerToken : undefined,
      shareToken: typeof settings.shareToken === "string" ? settings.shareToken : undefined,
      assistants: Array.isArray(settings.assistants) ? settings.assistants : [],
      viewers: Array.isArray(settings.viewers) ? settings.viewers : []
    }
  };
}

export function normalizeTaskStatus(progress: number, sourceStatus: LegacyTaskStatus): { status: TaskStatus; corrected: boolean } {
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) throw new Error("Task progress must be an integer between 0 and 100");
  const status: TaskStatus = progress >= 100 ? "completed" : progress > 0 ? "in_progress" : "todo";
  const canonical = sourceStatus === "doing" ? "in_progress" : sourceStatus === "done" ? "completed" : sourceStatus;
  return { status, corrected: canonical !== status };
}

export function normalizeTaskSource(source: unknown): TaskSource {
  if (source === "manual" || source === "wecom" || source === "api" || source === "assistant") return source;
  return "manual";
}

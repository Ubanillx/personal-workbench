export type UserRole = "owner" | "assistant" | "viewer";
export type TaskStatus = "todo" | "in_progress" | "pending_review" | "completed";
export type TaskPriority = "P0" | "P1" | "P2";
export type TaskSource = "manual" | "wecom" | "api" | "assistant";

export interface CurrentUser {
  id: string;
  name: string;
  role: UserRole;
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

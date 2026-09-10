export type UserRole = "admin" | "manager" | "member";
export type TaskStatus = "todo" | "in_progress" | "pending_review" | "completed";
export type TaskPriority = "P0" | "P1" | "P2";
export type TaskSource = "manual" | "wecom" | "api" | "assistant";

export interface CurrentUser {
  id: string;
  username: string;
  email: string;
  name: string;
  role: UserRole;
  /** 管理员为 null（全局角色，不隶属组织） */
  orgId: string | null;
  orgName: string | null;
  mustChangePassword: boolean;
}

export type OrganizationStatus = "active" | "archived";

export interface Organization {
  id: string;
  name: string;
  description: string;
  status: OrganizationStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  memberCount?: number;
}

export type JoinRequestKind = "join" | "leave" | "invite";
export type JoinRequestStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface JoinRequest {
  id: string;
  kind: JoinRequestKind;
  userId: string;
  userName: string | null;
  username: string | null;
  orgId: string;
  orgName: string | null;
  status: JoinRequestStatus;
  message: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decisionNote: string;
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
  /** 任务所属组织；管理员在合并视图（D-28）里靠它区分每行属于哪个组织 */
  orgId?: string | null;
  orgName?: string | null;
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

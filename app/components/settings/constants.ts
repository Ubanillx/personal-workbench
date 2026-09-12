import type { JoinRequestKind, JoinRequestStatus, OrganizationStatus, UserRole } from "../../../shared/types/domain";

/**
 * 设置页（`/settings`）的公共枚举与文案。
 *
 * 这三个 Tab 原本各自复制了一份 `ROLE_LABEL` / `STATUS_LABEL`，合并后统一放在这里，
 * 避免同一份文案多处漂移（账号改造前 `/admin`、`/organization`、`/collaboration` 各写一份）。
 */

/** Tab 顺序即展示顺序；`members` 是所有角色都能看到的默认 Tab */
export const SETTINGS_TABS = ["members", "webdav", "orgs", "accounts"] as const;
export type SettingsTabKey = (typeof SETTINGS_TABS)[number];
export const DEFAULT_SETTINGS_TAB: SettingsTabKey = "members";

/** 只有管理员能打开的 Tab（组织总览 / 账号总览）；`members` 与 `webdav` 管理者也能用 */
export const ADMIN_ONLY_TABS: readonly SettingsTabKey[] = ["orgs", "accounts"];

export function isSettingsTab(value: string): value is SettingsTabKey {
  return (SETTINGS_TABS as readonly string[]).includes(value);
}

/** 当前角色能否打开该 Tab：管理员全部可开，管理者只能开非管理员专属 Tab */
export function canOpenSettingsTab(tab: SettingsTabKey, isAdmin: boolean): boolean {
  return isAdmin || !ADMIN_ONLY_TABS.includes(tab);
}

export const ROLE_LABEL: Record<UserRole, string> = { admin: "管理员", manager: "组织管理者", member: "普通用户" };
export const ROLE_COLOR: Record<UserRole, string> = { admin: "blue", manager: "green", member: "default" };

export const ORG_STATUS_LABEL: Record<OrganizationStatus, string> = { active: "正常", archived: "已解散" };
export const ORG_STATUS_COLOR: Record<OrganizationStatus, string> = { active: "green", archived: "default" };

export const KIND_LABEL: Record<JoinRequestKind, string> = { join: "入组申请", leave: "退出申请", invite: "直接加入" };
export const REQUEST_STATUS_LABEL: Record<JoinRequestStatus, string> = {
  pending: "待审批",
  approved: "已通过",
  rejected: "已拒绝",
  cancelled: "已作废",
};
export const REQUEST_STATUS_COLOR: Record<JoinRequestStatus, string> = {
  pending: "gold",
  approved: "green",
  rejected: "red",
  cancelled: "default",
};

/** 本组织成员只有 manager / member 两种角色（admin 不隶属组织） */
export const ROLE_FILTER_OPTIONS = [
  { value: "all", label: "全部角色" },
  { value: "manager", label: "组织管理者" },
  { value: "member", label: "普通用户" },
];

/** 全局账号总览包含 admin */
export const ACCOUNT_ROLE_FILTER_OPTIONS = [
  { value: "all", label: "全部角色" },
  { value: "admin", label: "管理员" },
  { value: "manager", label: "组织管理者" },
  { value: "member", label: "普通用户" },
];

export const STATE_FILTER_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "active", label: "启用中" },
  { value: "inactive", label: "已停用" },
];

/** URL 查询串里的「全部」哨兵值 */
export const FILTER_ALL = "all";
/** URL 查询串里的「未加入任何组织」哨兵值 */
export const FILTER_NONE = "none";

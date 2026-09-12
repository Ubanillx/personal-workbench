import type { UserRole } from "../../../shared/types/domain";

/**
 * 账号 / 成员列表的视图行（SQL 的 `is_active`、`must_change_password` 是 0/1）。
 *
 * 原 `/admin`、`/organization`、`/collaboration` 各自定义了一份同名字段一致的视图类型，
 * 这里合并为一份，页面与 Tab 组件统一引用。
 */
export type MemberRow = {
  id: string;
  username: string;
  email: string;
  name: string;
  role: UserRole;
  orgId: string | null;
  orgName: string | null;
  isActive: number;
  mustChangePassword: number;
  createdAt: string;
};

/** 当前登录账号（设置页只需要这几个字段，不暴露邮箱等完整档案） */
export type Me = {
  id: string;
  name: string;
  username: string;
  role: UserRole;
  orgId: string | null;
};

/** 页面向 action 提交 payload 的统一入口（由外壳的 `useSubmit` 提供） */
export type PostPayload = (payload: Record<string, unknown>) => void;

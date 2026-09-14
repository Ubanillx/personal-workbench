import type { UserRole } from "../../shared/types/domain";

/**
 * 任务「谁能动」的判据，**前后端共用**。
 *
 * 为什么是普通 `.ts` 而不是 `.server.ts`：页面要在渲染按钮之前算出「这个人能不能验收这条任务」，
 * 判据必须能进浏览器包。这里只有入参与返回、不碰数据库，所以是纯函数；服务端的
 * `tasks.server.ts` / `task-service.server.ts` 也 import 同一份，规则不会两边各写一遍而漂移。
 */

/** 能管理任务的角色：admin（全局）/ manager（组织管理者）。具体到某个组织管不管得着由 `assertOrgAccess` 判定 */
export function canManageRole(role: UserRole): boolean {
  return role === "admin" || role === "manager";
}

/** 验收判据要看的两个字段（都来自 `tasks` 行）：发布人 `created_by` 与负责人 `owner_id` */
export type ReviewTarget = { createdBy: string; ownerId: string | null };

/**
 * 任务验收权（`approve` / `return`）：**组织管理者只能验收自己发布的任务**，全局管理员保留应急兜底。
 *
 * 正常业务链路是「组织管理者发布 → 成员完成 → 发布该任务的组织管理者验收」；
 * 全局管理员不参与日常发布，只在发布人离职/停用等异常情况下兜底。唯一的关系限制是
 * 负责人不能验收自己负责的任务，防止执行者把自己的进度直接判为通过。
 *
 * 三条判据，顺序即优先级：
 * 1. 不是 admin / manager ⇒ false。路由层的 `requireManager` 是第一道门，这里是第二道
 *    （页面 action 不经路由层，也要在这里被挡住）；
 * 2. **执行者不能验收自己负责的任务**——即便他就是发布人；这条是服务端与页面共同的
 *    关系约束，避免「按钮看得见、接口调得通」的自验收路径；
 * 3. 组织管理者必须是任务发布人；**全局管理员保留应急兜底**（管理员不隶属任何组织，D-26）。
 */
export function canReviewTask(actor: { id: string; role: UserRole }, task: ReviewTarget): boolean {
  if (!canManageRole(actor.role)) return false;
  if (task.ownerId === actor.id) return false;
  return task.createdBy === actor.id || actor.role === "admin";
}

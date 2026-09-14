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
 * 任务验收权（`approve` / `return`）：**只有任务的发布人可以验收**。
 *
 * 起因是一次真实裂缝：这里原先只判「角色是不是 admin/manager」，于是同组织的**任何**管理者
 * 都能验收，**包括这条任务的负责人自己**——执行者把进度推到 100% 提交验收后，页面上会出现
 * 「通过验收」按钮，他点一下就自己把自己验收通过了。
 *
 * 三条判据，顺序即优先级：
 * 1. 不是 admin / manager ⇒ false。路由层的 `requireManager` 是第一道门，这里是第二道
 *    （页面 action 不经路由层，也要在这里被挡住）；
 * 2. **执行者不能验收自己负责的任务**——即便他就是发布人。「自己发布给自己做」的任务在
 *    `reportProgress` 里根本不会进 `pending_review`（没有第二方需要验收），所以这条主要挡异常数据，
 *    但它是「执行者永不验收」这条不变式的兜底；
 * 3. 发布人本人可以验收；**全局管理员保留应急兜底**——管理员不隶属任何组织（D-26），
 *    发布人账号停用/离场后总得有人能把卡在待验收的任务推完（这也是 D-54 里「管理员是应急通道」的同一口径）。
 */
export function canReviewTask(actor: { id: string; role: UserRole }, task: ReviewTarget): boolean {
  if (!canManageRole(actor.role)) return false;
  if (task.ownerId === actor.id) return false;
  return task.createdBy === actor.id || actor.role === "admin";
}

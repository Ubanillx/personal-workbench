import { redirect } from "react-router";
import { appConfig } from "./context.server";
import type { User } from "./db.server";
import { optionalUser } from "./session.server";

/**
 * 页面级认证：与 API 的 requireAuth 不同，这里对未登录的处理是**重定向到登录页**，
 * 而不是返回 401 JSON——页面路由要给人看的。
 *
 * 三道门（顺序不能颠倒）：
 * 1. 未登录 → `/login?redirectTo=…`
 * 2. 必须改密（`must_change_password=1`）→ `/password`（否则初始密码会长期不换）
 * 3. 没有组织且不是管理员 → `/join`（D-34：未入组只能看组织列表与申请页）
 */

export function currentUser(request: Request): User | null {
  return optionalUser(request, appConfig().sessionCookieName);
}

function pathOf(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

export function requireUserOrRedirect(request: Request, options: { skipPasswordGate?: boolean; skipOrgGate?: boolean } = {}): User {
  const user = currentUser(request);
  if (!user) {
    const target = pathOf(request);
    throw redirect(`/login${target === "/" ? "" : `?redirectTo=${encodeURIComponent(target)}`}`);
  }
  if (user.mustChangePassword && !options.skipPasswordGate) throw redirect("/password");
  if (!options.skipOrgGate && user.role !== "admin" && !user.orgId) throw redirect("/join");
  return user;
}

/** 页面级管理员门禁：不是管理员就送回首页（页面要给人看，不用 403） */
export function requireAdminOrRedirect(request: Request): User {
  const user = requireUserOrRedirect(request);
  if (user.role !== "admin") throw redirect("/");
  return user;
}

/** 页面级组织管理员门禁：管理员或组织管理者；普通成员送回首页 */
export function requireManagerOrRedirect(request: Request): User {
  const user = requireUserOrRedirect(request);
  if (user.role !== "admin" && user.role !== "manager") throw redirect("/");
  return user;
}

/** 已登录用户访问登录/注册页时直接送回目标页（待改密的先送去改密） */
export function redirectIfAuthenticated(request: Request, to = "/"): void {
  const user = currentUser(request);
  if (!user) return;
  if (user.mustChangePassword) throw redirect("/password");
  throw redirect(to);
}

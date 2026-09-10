import { redirect } from "react-router";
import { appConfig } from "./context.server";
import type { User } from "./db.server";
import { optionalUser } from "./session.server";

/**
 * 页面级认证：与 API 的 requireAuth 不同，这里对未登录的处理是**重定向到登录页**，
 * 而不是返回 401 JSON——页面路由要给人看的。
 */
export function currentUser(request: Request): User | null {
  return optionalUser(request, appConfig().sessionCookieName);
}

export function requireUserOrRedirect(request: Request): User {
  const user = currentUser(request);
  if (!user) {
    const url = new URL(request.url);
    const target = `${url.pathname}${url.search}`;
    throw redirect(`/access${target === "/" ? "" : `?redirectTo=${encodeURIComponent(target)}`}`);
  }
  return user;
}

/** 已登录用户访问登录页时直接送回目标页 */
export function redirectIfAuthenticated(request: Request, to = "/"): void {
  if (currentUser(request)) throw redirect(to);
}

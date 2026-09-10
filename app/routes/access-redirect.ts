import { redirect } from "react-router";

/**
 * `/access` 是令牌时代的登录地址，现在登录页改名为 `/login`。
 * 这个路由只为老书签做 302，别再往这里加逻辑。
 */
export function loader({ request }: { request: Request }): Response {
  const url = new URL(request.url);
  const redirectTo = url.searchParams.get("redirectTo");
  throw redirect(redirectTo ? `/login?redirectTo=${encodeURIComponent(redirectTo)}` : "/login");
}

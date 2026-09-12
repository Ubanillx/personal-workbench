import { redirect } from "react-router";

/**
 * `/inbox` → `/tasks`：企微导入已并入「任务进展」页（页头「从企微导入」抽屉，见
 * `app/components/wecom-import-drawer.tsx`），不再单独占一个导航页面。
 * 保留这条跳转是为了老书签 / 老链接不落到 404，而不是让这个功能继续以页面的形式存在。
 */
export function loader(): Response {
  return redirect("/tasks");
}

import { createFixture, removeFixture } from "./fixture";
import { findFreePort, startServer } from "./runner";

/**
 * SSR 冒烟测试：不开浏览器也能验证"登录 → 外壳 → 各页面数据"整条链路。
 *
 *   npm run smoke:ui                                   # 默认自己拉起 rr:start + 注入夹具库
 *   npm run smoke:ui -- --base-url http://127.0.0.1:18995
 *   npm run smoke:ui -- --paths /tasks,/todos --require-migrated
 *
 * --require-migrated：把"仍是占位页"也算失败，用于验收某页是否真的迁移完成。
 * 退出码 0 = 全部检查通过。
 */

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const pages: Array<{ path: string; status: number; migrated: boolean }> = [];

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
function check(name: string, ok: boolean, detail?: string): void {
  checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
}

/**
 * 每个页面在夹具库下必然渲染出的**页面正文**特征串：用来验证 loader 真的取到数据并渲染，
 * 而不是只返回 200 空壳。注意不能用导航标签（外壳里也有），要用页面正文或夹具数据里的独有内容。
 */
const PAGE_MARKERS: Record<string, string[]> = {
  "/tasks": ["逾期任务", "待验收任务"],
  "/todos": ["跟进报价"],
  "/notes": ["会议要点"],
  "/inbox": ["粘贴聊天记录"],
  "/reports": ["第八周", "上传周报"],
  "/collaboration": ["长期令牌"],
  "/files": ["报价单模板"],
  "/review": ["任务明细"],
};

const DEFAULT_PAGES = "/tasks,/todos,/notes,/inbox,/reports,/collaboration,/files,/review";

async function main(): Promise<void> {
  const baseUrlArg = argValue("--base-url", "");
  const serveNpm = argValue("--serve-npm", baseUrlArg ? "" : "rr:start");
  const pagePaths = argValue("--paths", DEFAULT_PAGES)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const requireMigrated = process.argv.includes("--require-migrated");

  const fixture = baseUrlArg ? null : createFixture();
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  let base = baseUrlArg;
  if (fixture) {
    const port = await findFreePort();
    server = await startServer({ serveNpm, fixture, port });
    base = `http://127.0.0.1:${port}`;
  }
  base = base.replace(/\/$/u, "");

  try {
    // 1) 未登录访问首页 → 应重定向到登录页
    const anon = await fetch(`${base}/`, { redirect: "manual" });
    check(
      "未登录访问 / 重定向到 /access",
      anon.status === 302 && (anon.headers.get("location") ?? "").startsWith("/access"),
      `status=${anon.status}`,
    );

    // 2) 登录页 SSR 渲染
    const loginPage = await fetch(`${base}/access`);
    const loginHtml = await loginPage.text();
    check("GET /access 返回 200", loginPage.status === 200, `status=${loginPage.status}`);
    check("登录页含标题与 antd 样式类", loginHtml.includes("访问个人工作台") && loginHtml.includes("ant-"));

    // 3) 令牌换取会话
    const login = await fetch(`${base}/access`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=owner-token&redirectTo=%2F",
    });
    const setCookie = login.headers.getSetCookie?.()[0] ?? login.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0] ?? "";
    check("POST /access 成功并下发会话 Cookie", login.status === 302 && cookie.includes("workbench_session="), `status=${login.status}`);

    // 4) 会话对 API 与页面同时生效
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    check("GET /api/auth/me 用该会话返回 200", me.status === 200, `status=${me.status}`);

    const home = await fetch(`${base}/`, { headers: { cookie } });
    const homeHtml = await home.text();
    check("带会话 GET / 返回 200", home.status === 200, `status=${home.status}`);
    for (const needle of ["每日概览", "进行中任务", "待办清单", "退出"]) {
      check(`首页含「${needle}」`, homeHtml.includes(needle));
    }

    // 5) 页面 action：首页快捷新增待办（走共享服务，不是打 API）
    //    索引路由的表单必须带 ?index（RR8 的 <Form> 会自动补，裸 fetch 要自己加），否则 405。
    const marker = `冒烟待办-${Date.now()}`;
    const add = await fetch(`${base}/?index`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `content=${encodeURIComponent(marker)}`,
    });
    check("POST /?index 快捷新增待办被接受（非 405）", add.status !== 405, `status=${add.status}`);
    const after = await fetch(`${base}/`, { headers: { cookie } });
    check("新增后首页出现该待办", (await after.text()).includes(marker));

    // 6) 逐页检查：状态码 + 是否仍为占位页 + 是否渲染出夹具数据
    for (const path of pagePaths) {
      const response = await fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });
      const html = response.status === 200 ? await response.text() : "";
      const migrated = response.status === 200 && !html.includes("迁移中");
      pages.push({ path, status: response.status, migrated });
      check(`GET ${path} 返回 200`, response.status === 200, `status=${response.status}`);
      if (requireMigrated) check(`${path} 已完成迁移（非占位页）`, migrated);
      if (migrated) {
        const markers = PAGE_MARKERS[path] ?? [];
        const missing = markers.filter((needle) => !html.includes(needle));
        check(
          `${path} 渲染出页面数据（${markers.join("/") || "无标记"}）`,
          missing.length === 0,
          missing.length ? `缺少 ${missing.join(", ")}` : undefined,
        );
      }
    }

    // 7) 退出登录并确认会话失效
    const logout = await fetch(`${base}/logout`, { method: "POST", redirect: "manual", headers: { cookie } });
    check("POST /logout 重定向回登录页", logout.status === 302, `status=${logout.status}`);
    const afterLogout = await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" });
    check("退出后会话失效（/ 再次重定向）", afterLogout.status === 302, `status=${afterLogout.status}`);
  } finally {
    await server?.stop();
    if (fixture) removeFixture(fixture);
  }

  const failed = checks.filter((item) => !item.ok);
  for (const item of checks) {
    console.log(`${item.ok ? "✓" : "✗"} ${item.name}${item.detail === undefined ? "" : `  [${item.detail}]`}`);
  }
  if (pages.length > 0) {
    const pending = pages.filter((item) => !item.migrated).map((item) => item.path);
    console.log(`\n页面迁移进度：${pages.length - pending.length}/${pages.length} 已完成`);
    if (pending.length > 0) console.log(`仍是占位页：${pending.join(", ")}`);
  }
  console.log(`\n共 ${checks.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) process.exitCode = 1;
}

void main();

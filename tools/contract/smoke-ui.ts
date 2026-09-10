import fs from "node:fs";
import path from "node:path";
import { ACCOUNTS, IDS, createFixture, removeFixture } from "./fixture";
import { findFreePort, startServer } from "./runner";

/**
 * SSR 冒烟测试：不开浏览器也能验证"登录 → 外壳 → 各页面数据"整条链路。
 *
 *   npm run smoke:ui                                   # 默认自己拉起 npm run serve + 注入夹具库
 *   npm run smoke:ui -- --base-url http://127.0.0.1:18995
 *   npm run smoke:ui -- --paths /tasks,/todos --require-migrated
 *
 * --require-migrated：把"仍是占位页"也算失败，用于验收某页是否真的迁移完成。
 * 退出码 0 = 全部检查通过。
 *
 * ⚠️ 必须先 `npm run build`：`startServer` 跑的是 `npm run serve`（= react-router-serve
 * build/server/index.js），**不会重新构建**。`npm test` 已有 pretest 自动 build；
 * 手工跑本脚本时若源码比产物新，会在结果开头打印提醒（否则会拿旧产物报一堆莫名其妙的失败）。
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
function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}
function setCookieOf(response: Response): string {
  const raw = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

/** 目录下最新的源码修改时间（只看会进 build 的后缀） */
function newestSourceMtime(directory: string): number {
  try {
    let newest = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) newest = Math.max(newest, newestSourceMtime(full));
      else if (/\.(ts|tsx|css)$/u.test(entry.name)) newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
    return newest;
  } catch {
    return 0;
  }
}

/**
 * 源码是否比 build 产物新。返回空串表示一致；否则返回一句给人看的提醒。
 * 只在"服务的产物"这条路径上有意义（--base-url 模式下测的是别人起的服务，不做判断）。
 */
function staleBuildNote(): string {
  const entry = path.join(process.cwd(), "build", "server", "index.js");
  if (!fs.existsSync(entry)) return "未找到 build/server/index.js：请先 `npm run build`，否则测的是旧产物或根本没有产物";
  const builtAt = fs.statSync(entry).mtimeMs;
  const newest = Math.max(...["app", "server", "shared"].map((name) => newestSourceMtime(path.join(process.cwd(), name))));
  return newest > builtAt ? "源码比 build 产物新：本次结果反映的可能不是当前代码，请先 `npm run build`" : "";
}

/** 用夹具账号走一次页面登录：POST /login（表单编码）→ 期望 302 + workbench_session Cookie */
async function loginAs(base: string, account: { username: string; password: string }): Promise<{ status: number; cookie: string }> {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ username: account.username, password: account.password, redirectTo: "/" }),
  });
  return { status: response.status, cookie: setCookieOf(response) };
}

/**
 * 每个页面在夹具库下必然渲染出的**页面正文**特征串：用来验证 loader 真的取到数据并渲染，
 * 而不是只返回 200 空壳。注意不能用导航标签（外壳里也有），要用页面正文或夹具数据里的独有内容。
 * `/collaboration` 在账号改造后从「长期令牌」改成组织成员展示，因此标记改为成员相关内容。
 *
 * 每个页面除了夹具数据，还带一个「新版列表页骨架」的结构标记（页头主操作或工具栏搜索框），
 * 这样页面被改回空壳、或统一骨架被拆掉时，冒烟测试会立刻报出来。
 */
const PAGE_MARKERS: Record<string, string[]> = {
  "/tasks": ["逾期任务", "待验收任务", "新建任务", "搜索任务标题或负责人"],
  "/todos": ["跟进报价", "新建待办", "搜索待办内容"],
  "/notes": ["会议要点", "新建记录", "搜索记录内容"],
  "/inbox": ["粘贴聊天记录", "解析消息"],
  "/reports": ["第八周", "上传周报", "全部类型"],
  "/collaboration": ["成员"],
  "/files": ["报价单模板", "添加文件", "搜索文件名称或路径"],
  "/review": ["任务明细", "完成率"],
};

const DEFAULT_PAGES = "/tasks,/todos,/notes,/inbox,/reports,/collaboration,/files,/review";

async function main(): Promise<void> {
  const baseUrlArg = argValue("--base-url", "");
  const serveNpm = argValue("--serve-npm", baseUrlArg ? "" : "serve");
  const pagePaths = argValue("--paths", DEFAULT_PAGES)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const requireMigrated = process.argv.includes("--require-migrated");

  const fixture = baseUrlArg ? null : createFixture();
  const buildNote = fixture ? staleBuildNote() : "";
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  let base = baseUrlArg;
  if (fixture) {
    const port = await findFreePort();
    server = await startServer({ serveNpm, fixture, port });
    base = `http://127.0.0.1:${port}`;
  }
  base = base.replace(/\/$/u, "");

  // 页面 action 与 GET 的小工具：base 在这里才确定，所以定义在 main 内
  const pagePost = async (url: string, fields: Record<string, string>, cookie: string, json = false): Promise<string> => {
    const response = await fetch(`${base}${url}`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": json ? "application/json" : "application/x-www-form-urlencoded" },
      body: json ? JSON.stringify(fields) : formBody(fields),
    });
    return response.status === 200 ? await response.text() : "";
  };
  const pageHtml = async (url: string, cookie: string): Promise<string> => {
    const response = await fetch(`${base}${url}`, { headers: { cookie }, redirect: "manual" });
    return response.status === 200 ? await response.text() : "";
  };

  try {
    // 1) 未登录访问首页 → 应重定向到登录页（/login；老的 /access 仍会 302 到 /login）
    const anon = await fetch(`${base}/`, { redirect: "manual" });
    const anonLocation = anon.headers.get("location") ?? "";
    check(
      "未登录访问 / 重定向到登录页",
      anon.status === 302 && (anonLocation.startsWith("/login") || anonLocation.startsWith("/access")),
      `status=${anon.status} location=${anonLocation}`,
    );

    // 1b) 未入组用户唯一能访问的页面是 /join，未登录同样要落到登录页
    const anonJoin = await fetch(`${base}/join`, { redirect: "manual" });
    check(
      "未登录访问 /join 重定向到 /login",
      anonJoin.status === 302 && (anonJoin.headers.get("location") ?? "").startsWith("/login"),
      `status=${anonJoin.status}`,
    );

    // 2) 登录页 SSR 渲染（替代旧的 /access 令牌页）
    const loginPage = await fetch(`${base}/login`);
    const loginHtml = await loginPage.text();
    check("GET /login 返回 200", loginPage.status === 200, `status=${loginPage.status}`);
    check("登录页含标题与 antd 样式类", loginHtml.includes("登录个人工作台") && loginHtml.includes("ant-"));

    // 2b) 老书签 /access 保留 302 到 /login
    const legacy = await fetch(`${base}/access`, { redirect: "manual" });
    check(
      "GET /access 仍 302 到 /login",
      legacy.status === 302 && (legacy.headers.get("location") ?? "").startsWith("/login"),
      `status=${legacy.status} location=${legacy.headers.get("location") ?? ""}`,
    );

    // 2c) 注册页 SSR 渲染
    const registerPage = await fetch(`${base}/register`);
    const registerHtml = await registerPage.text();
    check("GET /register 返回 200", registerPage.status === 200, `status=${registerPage.status}`);
    check("注册页含标题与表单", registerHtml.includes("注册新账号") && registerHtml.includes("ant-"));

    // 2d) 令牌登录已整体退役：旧端点不再可用（不再下发任何会话）
    const tokenLogin = await fetch(`${base}/api/auth/access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "owner-token" }),
    });
    check("旧令牌端点 /api/auth/access 已退役", tokenLogin.status >= 400, `status=${tokenLogin.status}`);

    // 3) 用户名 + 密码换取会话（账号取自夹具：tools/contract/fixture.ts 的 ACCOUNTS）
    const badLogin = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ username: ACCOUNTS.admin.username, password: "definitely-wrong", redirectTo: "/" }),
    });
    check("错误密码登录被拒绝（不下发会话 Cookie）", badLogin.status !== 302 && setCookieOf(badLogin) === "", `status=${badLogin.status}`);

    const login = await loginAs(base, ACCOUNTS.admin);
    const cookie = login.cookie;
    check("POST /login 成功并下发会话 Cookie", login.status === 302 && cookie.includes("workbench_session="), `status=${login.status}`);

    // 4) 会话对 API 与页面同时生效
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    const meBody = (await me.json().catch(() => null)) as {
      ok?: boolean;
      data?: { user?: { username?: string; orgId?: string | null; mustChangePassword?: boolean } };
    } | null;
    check(
      "GET /api/auth/me 返回账号上下文（username/orgId/mustChangePassword）",
      me.status === 200 && meBody?.data?.user?.username === ACCOUNTS.admin.username,
      `status=${me.status} username=${meBody?.data?.user?.username ?? ""}`,
    );

    const home = await fetch(`${base}/`, { headers: { cookie } });
    const homeHtml = await home.text();
    check("带会话 GET / 返回 200", home.status === 200, `status=${home.status}`);
    for (const needle of ["每日概览", "未完成任务", "待办清单", "退出"]) {
      check(`首页含「${needle}」`, homeHtml.includes(needle));
    }

    // 4b) 新增的登录后页面：改密页与入组页
    const passwordPage = await fetch(`${base}/password`, { headers: { cookie } });
    const passwordHtml = await passwordPage.text();
    check("GET /password 返回 200", passwordPage.status === 200, `status=${passwordPage.status}`);
    check("改密页含标题与三个密码输入框", passwordHtml.includes("修改密码") && passwordHtml.includes("确认新密码"));

    const joinPage = await fetch(`${base}/join`, { headers: { cookie } });
    const joinHtml = await joinPage.text();
    check("GET /join 返回 200", joinPage.status === 200, `status=${joinPage.status}`);
    check("入组页含组织列表与我的申请", joinHtml.includes("组织列表") && joinHtml.includes("我的申请"));

    // 4c) 强制改密门禁：登录本身放行（否则没入口改密），但除改密与登出外一律送到 /password
    const mustChange = await loginAs(base, ACCOUNTS.mustChange);
    check(
      "待改密账号可以登录（否则没有入口改密）",
      mustChange.status === 302 && mustChange.cookie.includes("workbench_session="),
      `status=${mustChange.status}`,
    );
    const gateHome = await fetch(`${base}/`, { headers: { cookie: mustChange.cookie }, redirect: "manual" });
    check(
      "待改密账号访问 / 被送到 /password",
      gateHome.status === 302 && (gateHome.headers.get("location") ?? "").startsWith("/password"),
      `status=${gateHome.status} location=${gateHome.headers.get("location") ?? ""}`,
    );
    const gateJoin = await fetch(`${base}/join`, { headers: { cookie: mustChange.cookie }, redirect: "manual" });
    check(
      "待改密账号访问 /join 也被送到 /password",
      gateJoin.status === 302 && (gateJoin.headers.get("location") ?? "").startsWith("/password"),
      `status=${gateJoin.status} location=${gateJoin.headers.get("location") ?? ""}`,
    );
    const gatePassword = await fetch(`${base}/password`, { headers: { cookie: mustChange.cookie } });
    const gatePasswordHtml = await gatePassword.text();
    check(
      "待改密账号能打开 /password 并看到强制改密提示",
      gatePassword.status === 200 && gatePasswordHtml.includes("首次登录需要修改初始密码"),
      `status=${gatePassword.status}`,
    );
    const gateMe = await fetch(`${base}/api/auth/me`, { headers: { cookie: mustChange.cookie } });
    check("待改密账号仍能读 /api/auth/me（看自己不受门禁限制）", gateMe.status === 200, `status=${gateMe.status}`);

    // 4d) 未加入组织（D-34）：只能待在 /join，其它页面一律重定向回来
    const noOrg = await loginAs(base, ACCOUNTS.noOrg);
    const noOrgHome = await fetch(`${base}/`, { headers: { cookie: noOrg.cookie }, redirect: "manual" });
    check(
      "未入组账号访问 / 被送到 /join",
      noOrgHome.status === 302 && (noOrgHome.headers.get("location") ?? "").startsWith("/join"),
      `status=${noOrgHome.status} location=${noOrgHome.headers.get("location") ?? ""}`,
    );
    const noOrgTasks = await fetch(`${base}/tasks`, { headers: { cookie: noOrg.cookie }, redirect: "manual" });
    check(
      "未入组账号访问 /tasks 被送到 /join",
      noOrgTasks.status === 302 && (noOrgTasks.headers.get("location") ?? "").startsWith("/join"),
      `status=${noOrgTasks.status} location=${noOrgTasks.headers.get("location") ?? ""}`,
    );
    const noOrgJoin = await fetch(`${base}/join`, { headers: { cookie: noOrg.cookie } });
    const noOrgJoinHtml = await noOrgJoin.text();
    check(
      "未入组账号能打开 /join 并看到组织列表与入组申请表单",
      noOrgJoin.status === 200 &&
        noOrgJoinHtml.includes("申请加入组织") &&
        noOrgJoinHtml.includes("组织列表") &&
        noOrgJoinHtml.includes("阿尔法组"),
      `status=${noOrgJoin.status}`,
    );

    // 4e) 两个组织管理页：/admin（仅管理员）与 /organization（管理员或组织管理者）
    const adminPage = await fetch(`${base}/admin`, { headers: { cookie } });
    const adminPageHtml = await adminPage.text();
    check("管理员 GET /admin 返回 200", adminPage.status === 200, `status=${adminPage.status}`);
    check(
      "/admin 渲染出组织总览与账号总览（含夹具组织）",
      adminPageHtml.includes("全局管理") && adminPageHtml.includes("组织总览") && adminPageHtml.includes("阿尔法组"),
    );

    const manager = await loginAs(base, ACCOUNTS.managerA);
    const managerOrgPage = await fetch(`${base}/organization`, { headers: { cookie: manager.cookie } });
    const managerOrgHtml = await managerOrgPage.text();
    check("组织管理者 GET /organization 返回 200", managerOrgPage.status === 200, `status=${managerOrgPage.status}`);
    check(
      "/organization 渲染出成员列表与待审批申请（含夹具成员）",
      managerOrgHtml.includes("组织管理") &&
        managerOrgHtml.includes("成员列表") &&
        managerOrgHtml.includes("待审批申请") &&
        managerOrgHtml.includes("阿尔法成员甲"),
    );

    const adminByManager = await fetch(`${base}/admin`, { headers: { cookie: manager.cookie }, redirect: "manual" });
    check(
      "组织管理者访问 /admin 被送回首页（不是 200/403）",
      adminByManager.status === 302 && (adminByManager.headers.get("location") ?? "") === "/",
      `status=${adminByManager.status} location=${adminByManager.headers.get("location") ?? ""}`,
    );
    const member = await loginAs(base, ACCOUNTS.memberA);
    const orgByMember = await fetch(`${base}/organization`, { headers: { cookie: member.cookie }, redirect: "manual" });
    check(
      "普通成员访问 /organization 被送回首页",
      orgByMember.status === 302 && (orgByMember.headers.get("location") ?? "") === "/",
      `status=${orgByMember.status} location=${orgByMember.headers.get("location") ?? ""}`,
    );

    /* ------------------------------------------------ 5) 记录页面的 action 与组织口径 */

    // 概览页/待办/随手记/重要文件四个页面共用 app/lib/records.server.ts 的
    // `resolveRecordOrg`：组织管理者与普通成员写自己的组织，**管理员不隶属组织，必须显式指定**，
    // 否则写入被拒（页面 action 会把它渲染成提示文案）。四页口径必须一致，因此逐页验证两遍：
    // 不带 orgId → 拒绝；带 orgId → 写成功并能在列表里看到。
    // 索引路由的表单必须带 ?index（RR8 的 <Form> 会自动补，裸 fetch 要自己加），否则 405。
    const noOrgHint = "管理员必须指定记录所属组织";
    const stamp = Date.now();

    // 概览页：待办快捷新增
    const dashMarker = `冒烟待办-${stamp}`;
    const dashNoOrg = await pagePost("/?index", { content: dashMarker, todoDate: "2026-09-01" }, cookie);
    check("概览页新增待办不带 orgId → 提示必须指定组织", dashNoOrg.includes(noOrgHint));
    const dashAdd = await pagePost("/?index", { content: dashMarker, todoDate: "2026-09-01", orgId: IDS.orgAlpha }, cookie);
    check("概览页新增待办带 orgId → 不报错", dashAdd !== "" && !dashAdd.includes(noOrgHint));
    check("新增后概览页出现该待办", (await pageHtml("/", cookie)).includes(dashMarker));

    // 待办清单页（JSON 提交，payload.intent=create）
    const todoMarker = `冒烟待办页-${stamp}`;
    const todoNoOrg = await pagePost("/todos", { intent: "create", content: todoMarker, todoDate: "2026-09-01" }, cookie, true);
    check("/todos 新增不带 orgId → 提示必须指定组织", todoNoOrg.includes(noOrgHint));
    const todoAdd = await pagePost(
      "/todos",
      { intent: "create", content: todoMarker, todoDate: "2026-09-01", orgId: IDS.orgAlpha },
      cookie,
      true,
    );
    check("/todos 新增带 orgId → 不报错", todoAdd !== "" && !todoAdd.includes(noOrgHint));
    check("新增后 /todos 出现该待办", (await pageHtml("/todos", cookie)).includes(todoMarker));

    // 随手记页（JSON 提交，payload.intent=create）
    const noteMarker = `冒烟随手记-${stamp}`;
    const noteNoOrg = await pagePost("/notes", { intent: "create", content: noteMarker }, cookie, true);
    check("/notes 新增不带 orgId → 提示必须指定组织", noteNoOrg.includes(noOrgHint));
    const noteAdd = await pagePost("/notes", { intent: "create", content: noteMarker, orgId: IDS.orgAlpha }, cookie, true);
    check("/notes 新增带 orgId → 不报错", noteAdd !== "" && !noteAdd.includes(noOrgHint));
    check("新增后 /notes 出现该随手记", (await pageHtml("/notes", cookie)).includes(noteMarker));

    // 重要文件页（普通表单提交，字段名 name/filePath/category/orgId）
    const fileMarker = `冒烟文件-${stamp}`;
    const fileNoOrg = await pagePost("/files", { name: fileMarker, filePath: "C:\\fixture\\smoke.txt", category: "临时" }, cookie);
    check("/files 新增不带 orgId → 提示必须指定组织", fileNoOrg.includes(noOrgHint));
    const fileAdd = await pagePost(
      "/files",
      { name: fileMarker, filePath: "C:\\fixture\\smoke.txt", category: "临时", orgId: IDS.orgAlpha },
      cookie,
    );
    check("/files 新增带 orgId → 不报错", fileAdd !== "" && !fileAdd.includes(noOrgHint));
    check("新增后 /files 出现该文件", (await pageHtml("/files", cookie)).includes(fileMarker));

    // 6) 逐页检查：状态码 + 是否仍为占位页 + 是否渲染出夹具数据
    for (const pagePath of pagePaths) {
      const response = await fetch(`${base}${pagePath}`, { headers: { cookie }, redirect: "manual" });
      const html = response.status === 200 ? await response.text() : "";
      const migrated = response.status === 200 && !html.includes("迁移中");
      pages.push({ path: pagePath, status: response.status, migrated });
      check(`GET ${pagePath} 返回 200`, response.status === 200, `status=${response.status}`);
      if (requireMigrated) check(`${pagePath} 已完成迁移（非占位页）`, migrated);
      if (migrated) {
        const markers = PAGE_MARKERS[pagePath] ?? [];
        const missing = markers.filter((needle) => !html.includes(needle));
        check(
          `${pagePath} 渲染出页面数据（${markers.join("/") || "无标记"}）`,
          missing.length === 0,
          missing.length ? `缺少 ${missing.join(", ")}` : undefined,
        );
      }
    }

    // 回顾统计：「全部」筛选不能被解释为 owner_id='' 或日期上界=''。
    const reviewAll = await pageHtml("/review?range=all", cookie);
    check("回顾统计全部时间包含不同负责人的任务", reviewAll.includes("待办任务") && reviewAll.includes("成员乙的任务"));
    const reviewOwner = await pageHtml(`/review?range=all&ownerId=${IDS.userMemberA}`, cookie);
    check("回顾统计可按负责人筛选", reviewOwner.includes("待办任务") && !reviewOwner.includes("成员乙的任务"));

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
  if (buildNote) console.log(`⚠️  ${buildNote}\n`);
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

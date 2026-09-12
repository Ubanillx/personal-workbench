import fs from "node:fs";
import path from "node:path";
import { startFakeWebDav } from "../webdav/fake-server";
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
 * `/settings` 是三个旧管理页（`/admin`、`/organization`、`/collaboration`）合并后的默认 Tab。
 *
 * 每个页面除了夹具数据，还带一个「新版列表页骨架」的结构标记（页头主操作或工具栏搜索框），
 * 这样页面被改回空壳、或统一骨架被拆掉时，冒烟测试会立刻报出来。
 */
const PAGE_MARKERS: Record<string, string[]> = {
  // 「最近更新」列与「更新时间范围」筛选器一一对应（D-47）：筛选字段必须在列表里看得见。
  // 企微导入（粘贴解析 → 批量导入）已并入本页页头的抽屉，因此这里盯着它的入口按钮
  "/tasks": ["逾期任务", "待验收任务", "新建任务", "从企微导入", "搜索任务标题或负责人", "完成率", "全部时间", "最近更新", "所属组织"],
  "/todos": ["跟进报价", "新建待办", "搜索待办内容", "所属组织"],
  "/notes": ["会议要点", "新建记录", "搜索记录内容", "所属组织"],
  // 这一轮用的是**管理员**会话：D-46 起管理员不提交周报，页面上不该有「上传周报」入口，
  // 「上传入口按身份出现/隐藏」由后面的专项断言盯着
  "/reports": ["第八周", "全部类型", "全部状态", "归属人"],
  "/settings": ["组织与成员", "成员列表", "待审批申请", "阿尔法成员甲"],
  "/files": ["报价单模板", "添加文件", "搜索文件名称或路径", "所属组织"],
};

const DEFAULT_PAGES = "/tasks,/todos,/notes,/reports,/settings,/files";

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
  // 周报上传自 D-46 起要往 NAS 写（设置页/周报页的 SSR 断言与它相关），
  // 这里给夹具一个本地假远端，免得页面上出现「周报存储未配置」的告警
  const webdav = fixture ? await startFakeWebDav() : null;
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  let base = baseUrlArg;
  if (fixture) {
    const port = await findFreePort();
    // `exactOptionalPropertyTypes` 下不能显式传 undefined，所以按需展开
    server = await startServer({ serveNpm, fixture, port, ...(webdav ? { webdavUrl: webdav.baseUrl } : {}) });
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
    check(
      "未入组 /join 为全屏页（无工作台侧栏）",
      !noOrgJoinHtml.includes("每日概览") &&
        !noOrgJoinHtml.includes("app-sider") &&
        noOrgJoinHtml.includes("join-screen") &&
        noOrgJoinHtml.includes("退出登录"),
    );

    // 4e) 设置页：三个旧管理页（/admin、/organization、/collaboration）合并为 /settings
    const settingsPage = await fetch(`${base}/settings`, { headers: { cookie } });
    const settingsHtml = await settingsPage.text();
    check("管理员 GET /settings 返回 200", settingsPage.status === 200, `status=${settingsPage.status}`);
    check(
      "/settings 默认 Tab 渲染出组织信息、成员列表与待审批申请（含夹具成员）",
      settingsHtml.includes("设置") &&
        settingsHtml.includes("组织与成员") &&
        settingsHtml.includes("成员列表") &&
        settingsHtml.includes("待审批申请") &&
        settingsHtml.includes("阿尔法成员甲"),
    );

    const settingsOrgsHtml = await pageHtml("/settings?tab=orgs", cookie);
    check(
      "/settings?tab=orgs 渲染出组织总览（含夹具组织）",
      settingsOrgsHtml.includes("组织总览") && settingsOrgsHtml.includes("阿尔法组"),
    );
    const settingsAccountsHtml = await pageHtml("/settings?tab=accounts", cookie);
    check(
      "/settings?tab=accounts 渲染出账号总览（含夹具账号）",
      settingsAccountsHtml.includes("账号总览") && settingsAccountsHtml.includes("阿尔法成员甲"),
    );

    // WebDAV 配置按账号走：管理员与组织管理者都能打开这个 Tab（D-43）；
    // 「周报上传」卡的作用域是**一个组织**（D-53）：组织管理者配本组织，管理员可换组织。
    // 这张卡**不回显连接信息**——它就显示在正上方那张卡里，重复一遍属于信息层级错误。
    const settingsWebdavHtml = await pageHtml("/settings?tab=webdav", cookie);
    check(
      "管理员 /settings?tab=webdav 渲染出 WebDAV 配置表单",
      settingsWebdavHtml.includes("WebDAV 地址") && settingsWebdavHtml.includes("测试连接"),
    );
    check(
      "管理员能看到「周报上传」配置卡（上传根目录 + 组织，不填账号密码、也不回显连接）",
      settingsWebdavHtml.includes("周报上传") &&
        settingsWebdavHtml.includes("上传根目录") &&
        !settingsWebdavHtml.includes("统一上传账号") &&
        !settingsWebdavHtml.includes("共用连接"),
    );
    check(
      "管理员这张卡默认落在第一个组织上（阿尔法组）",
      settingsWebdavHtml.includes("周报上传") && settingsWebdavHtml.includes("阿尔法组"),
    );
    check("夹具里管理员那份连接就是周报用的连接 → 周报上传开箱可用", settingsWebdavHtml.includes("已启用"));

    // 「周报上传」的保存 / 恢复默认链路（页面 action，D-53）——组织管理者上线后点的第一步。
    // 这张卡只改目录：连接用上面那份，作用域是当前组织（管理员的 orgId 由卡片里的选择器带上）。
    const uploadConfig = { intent: "save-report-upload", orgId: IDS.orgAlpha, root: "/周报" };
    const savedUpload = await pagePost("/settings?tab=webdav", uploadConfig, cookie, true);
    check("管理员保存本组织的「周报上传」目录成功（action 返回页面）", savedUpload.includes("周报上传目录已保存"));
    check("保存后「周报上传」回填所选目录", (await pageHtml("/settings?tab=webdav", cookie)).includes('value="/周报"'));
    const resetUpload = await pagePost("/settings?tab=webdav", { intent: "reset-report-upload", orgId: IDS.orgAlpha }, cookie, true);
    check("管理员恢复默认上传目录成功", resetUpload.includes("已恢复默认"));
    const resetUploadHtml = await pageHtml("/settings?tab=webdav", cookie);
    check(
      "恢复默认后目录清空、卡片仍为已启用（默认即用连接的浏览根目录）",
      resetUploadHtml.includes("已启用") &&
        resetUploadHtml.includes("留空则使用连接的浏览根目录") &&
        !resetUploadHtml.includes('value="/周报"'),
    );

    // 目录按组织分开（D-53）：管理员给贝塔组配一个，阿尔法组的页面**不该**跟着变
    const betaConfig = { intent: "save-report-upload", orgId: IDS.orgBeta, root: "/贝塔周报" };
    check("管理员可以给指定组织保存目录", (await pagePost(`/settings?tab=webdav&org=${IDS.orgBeta}`, betaConfig, cookie, true)) !== "");
    const betaHtml = await pageHtml(`/settings?tab=webdav&org=${IDS.orgBeta}`, cookie);
    const alphaHtml = await pageHtml(`/settings?tab=webdav&org=${IDS.orgAlpha}`, cookie);
    check("贝塔组的页面上能看到刚保存的目录", betaHtml.includes('value="/贝塔周报"'));
    check("阿尔法组的页面看不到贝塔组的目录（各组织各一份）", !alphaHtml.includes('value="/贝塔周报"'));

    // 「重要文件」的 WebDAV 通道（D-41 / D-48）：按账号保存凭据后才亮起；
    // 新建/编辑抽屉里的「选择文件」与页头的「浏览 WebDAV」都依赖它（SSR 只验证入口与说明文案，
    // 抽屉里的浏览 / 选择是客户端交互，运行时验证仍缺——见 DEBT-16 / TODO-12）。
    // 夹具给管理员预置了连接（周报上传要用它），所以先清掉验证「未保存」那一侧的降级，
    // 保存回来再验证「已保存」那一侧——顺带把 clear / save 两条 action 都走一遍。
    const clearedWebdav = await pagePost("/settings?tab=webdav", { intent: "clear-webdav" }, cookie, true);
    check("管理员清除本账号 WebDAV 凭据成功", clearedWebdav !== "");
    const filesBeforeWebdav = await pageHtml("/files", cookie);
    check(
      "本账号未保存 WebDAV 凭据时 /files 只有「配置 WebDAV」，没有远端入口",
      !filesBeforeWebdav.includes("浏览 WebDAV") && filesBeforeWebdav.includes("配置 WebDAV"),
    );
    check("清掉连接后「周报上传」提示先保存连接", (await pageHtml("/settings?tab=webdav", cookie)).includes("未配置 WebDAV 连接"));
    const savedWebdav = await pagePost(
      "/settings?tab=webdav",
      { intent: "save-webdav", username: "", password: "", root: "/", timeoutMs: "15000" },
      cookie,
      true,
    );
    check("管理员保存本账号 WebDAV 凭据成功（假 WebDAV 匿名可用）", savedWebdav !== "");
    const filesWithWebdav = await pageHtml("/files", cookie);
    check(
      "/files 配置后亮出「浏览 WebDAV」入口与远端说明",
      filesWithWebdav.includes("浏览 WebDAV") && filesWithWebdav.includes("从 WebDAV"),
    );

    // 下载闭环（D-49）：上传到假 NAS 并登记索引 → 走 /api/files/:id/download 取回，内容与文件名一致；
    // 本机路径的 400、跨组织的 404 等失败面由契约的 files.download.* 用例盯，这里只验成功链路
    const uploadBody = new FormData();
    uploadBody.append("dir", "冒烟下载");
    uploadBody.append("register", "1");
    uploadBody.append("category", "临时");
    uploadBody.append("orgId", IDS.orgAlpha);
    uploadBody.append("file", new File(["冒烟下载内容"], "smoke-download.txt", { type: "text/plain" }), "smoke-download.txt");
    const uploaded = await fetch(`${base}/api/webdav`, { method: "POST", headers: { cookie }, body: uploadBody });
    const uploadResult = (await uploaded.json().catch(() => null)) as {
      ok?: boolean;
      data?: { path?: string; registered?: boolean; file?: { id?: string } };
    } | null;
    check(
      "上传到假 WebDAV 并登记索引成功（下载的前置）",
      uploaded.status === 201 && uploadResult?.ok === true && uploadResult.data?.registered === true,
    );
    const downloaded = await fetch(`${base}/api/files/${uploadResult?.data?.file?.id ?? "missing"}/download`, {
      headers: { cookie },
    });
    const downloadText = downloaded.status === 200 ? await downloaded.text() : "";
    check(
      "下载端点取回的内容与上传一致",
      downloaded.status === 200 && downloadText === "冒烟下载内容",
      `status=${downloaded.status} body=${JSON.stringify(downloadText)}`,
    );
    const downloadDisposition = downloaded.headers.get("content-disposition") ?? "";
    check(
      "下载响应带 attachment 与 UTF-8 文件名",
      downloadDisposition.includes("attachment") && downloadDisposition.includes("smoke-download.txt"),
      `disposition=${JSON.stringify(downloadDisposition)}`,
    );
    const filesWithDownload = await pageHtml("/files", cookie);
    check("远端条目在列表里有「下载」入口（本机条目没有）", filesWithDownload.includes('aria-label="下载"'));

    // 这里**不再**清掉管理员的连接：D-52 之后它就是「周报上传」共用的那份，
    // 清掉会让后面所有涉及周报正文的检查整体 503。「清除 → 降级」那一侧已在上面验过。

    const manager = await loginAs(base, ACCOUNTS.managerA);
    const managerSettings = await fetch(`${base}/settings`, { headers: { cookie: manager.cookie }, redirect: "manual" });
    const managerSettingsHtml = await managerSettings.text();
    check("组织管理者 GET /settings 返回 200", managerSettings.status === 200, `status=${managerSettings.status}`);
    check(
      "/settings 对组织管理者渲染出本组织成员与待审批申请（含夹具成员）",
      managerSettingsHtml.includes("组织与成员") &&
        managerSettingsHtml.includes("成员列表") &&
        managerSettingsHtml.includes("待审批申请") &&
        managerSettingsHtml.includes("阿尔法成员甲"),
    );
    const managerOrgs = await fetch(`${base}/settings?tab=orgs`, { headers: { cookie: manager.cookie }, redirect: "manual" });
    const managerOrgsHtml = await managerOrgs.text();
    check(
      "组织管理者访问 ?tab=orgs 回落到「组织与成员」，看不到组织总览",
      managerOrgs.status === 200 && managerOrgsHtml.includes("组织与成员") && !managerOrgsHtml.includes("组织总览"),
      `status=${managerOrgs.status}`,
    );
    const managerWebdavHtml = await pageHtml("/settings?tab=webdav", manager.cookie);
    check(
      "组织管理者也能打开 WebDAV 配置 Tab（本账号连接按账号走）",
      managerWebdavHtml.includes("WebDAV 地址") && !managerWebdavHtml.includes("组织总览"),
    );
    // 「周报上传」按组织配置（D-53）：组织管理者看得到、改得动**本组织**那一份
    check(
      "组织管理者能看到「周报上传」卡，且作用域是自己的组织（阿尔法组）",
      managerWebdavHtml.includes("周报上传") && managerWebdavHtml.includes("阿尔法组"),
    );
    const managerUpload = await pagePost(
      "/settings?tab=webdav",
      { intent: "save-report-upload", root: "/阿尔法周报" },
      manager.cookie,
      true,
    );
    check("组织管理者保存本组织的「周报上传」目录成功", managerUpload !== "");
    check("保存后本组织页面回填所选目录", (await pageHtml("/settings?tab=webdav", manager.cookie)).includes('value="/阿尔法周报"'));
    // 组织管理者传别人的 orgId 不生效：action 只用会话里的组织（与其它设置动作同一口径）
    await pagePost("/settings?tab=webdav", { intent: "save-report-upload", orgId: IDS.orgBeta, root: "/冒充贝塔" }, manager.cookie, true);
    const betaAfterManager = await pageHtml(`/settings?tab=webdav&org=${IDS.orgBeta}`, cookie);
    check("组织管理者改不动别的组织：贝塔组的目录没被写成 /冒充贝塔", !betaAfterManager.includes('value="/冒充贝塔"'));
    check(
      "那条请求落回了组织管理者自己的组织（orgId 被忽略）",
      (await pageHtml("/settings?tab=webdav", manager.cookie)).includes('value="/冒充贝塔"'),
    );

    const member = await loginAs(base, ACCOUNTS.memberA);
    const settingsByMember = await fetch(`${base}/settings`, { headers: { cookie: member.cookie }, redirect: "manual" });
    check(
      "普通成员访问 /settings 被送回首页",
      settingsByMember.status === 302 && (settingsByMember.headers.get("location") ?? "") === "/",
      `status=${settingsByMember.status} location=${settingsByMember.headers.get("location") ?? ""}`,
    );

    // 周报上传入口按身份出现/隐藏，且上传表单里不再有「归属人」（D-46）
    const adminReportsHtml = await pageHtml("/reports", cookie);
    check("/reports 管理员看不到「上传周报」入口", !adminReportsHtml.includes("上传周报"));
    const managerReportsHtml = await pageHtml("/reports", manager.cookie);
    check("/reports 组织管理者能看到「上传周报」入口", managerReportsHtml.includes("上传周报"));
    const memberReportsHtml = await pageHtml("/reports", member.cookie);
    check("/reports 普通成员能看到「上传周报」入口", memberReportsHtml.includes("上传周报"));

    // 旧管理页已合并删除（不做重定向）：直接 404
    for (const legacyPath of ["/admin", "/organization", "/collaboration"]) {
      const legacyPage = await fetch(`${base}${legacyPath}`, { headers: { cookie }, redirect: "manual" });
      check(`已合并的旧页面 ${legacyPath} 不再存在（404）`, legacyPage.status === 404, `status=${legacyPage.status}`);
    }

    /* ------------------------------------------------ 5) 记录页面的 action 与组织口径 */

    // 概览页/待办/随手记/重要文件四个页面共用 app/lib/records.server.ts 的
    // `resolveRecordOrg`：组织管理者与普通成员写自己的组织，**管理员不隶属组织，必须显式指定**，
    // 否则写入被拒（页面 action 会把它渲染成提示文案）。四页口径必须一致，因此逐页验证两遍：
    // 不带 orgId → 拒绝；带 orgId → 写成功并能在列表里看到。
    // 索引路由的表单必须带 ?index（RR8 的 <Form> 会自动补，裸 fetch 要自己加），否则 405。
    const noOrgHint = "管理员必须指定记录所属组织";
    const stamp = Date.now();

    // 概览页（D-40）：改成只读展板，新增待办的 action 已移除 —— POST / 必须写不进去。
    // 展板内容本身由上面第 4 步的首页标记与下面的文案检查覆盖。
    const dashPost = await fetch(`${base}/?index`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ content: `冒烟待办-${stamp}`, todoDate: "2026-09-01", orgId: IDS.orgAlpha }),
    });
    check("概览页已移除新增待办（POST / 被拒绝，不再有 action）", dashPost.status >= 400, `status=${dashPost.status}`);
    const dashBoard = await pageHtml("/", cookie);
    check(
      "概览页为只读展板（含任务状态分布、需要关注的任务、最近随手记）",
      dashBoard.includes("任务状态分布") && dashBoard.includes("需要关注的任务") && dashBoard.includes("最近随手记"),
    );

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
    const legacyReview = await fetch(`${base}/review?range=all&ownerId=${IDS.userMemberA}`, { headers: { cookie }, redirect: "manual" });
    check(
      "旧回顾链接保留筛选并跳转任务页",
      legacyReview.status === 302 && legacyReview.headers.get("location") === `/tasks?range=all&assignee=${IDS.userMemberA}`,
    );
    const reviewAll = await pageHtml("/tasks?range=all", cookie);
    check("回顾统计全部时间包含不同负责人的任务", reviewAll.includes("待办任务") && reviewAll.includes("成员乙的任务"));
    const reviewOwner = await pageHtml(`/tasks?range=all&assignee=${IDS.userMemberA}`, cookie);
    check("回顾统计可按负责人筛选", reviewOwner.includes("待办任务") && !reviewOwner.includes("成员乙的任务"));
    const emptyRange = await pageHtml("/tasks?range=custom&from=1900-01-01&to=1900-01-02", cookie);
    check(
      "自定义更新时间筛选作用于任务列表",
      emptyRange.includes("没有符合条件的任务") && emptyRange.includes("完成率") && !emptyRange.includes("成员乙的任务"),
    );
    check("导航不再重复显示回顾统计入口", !reviewAll.includes('href="/review"'));
    // 企微导入并入「任务进展」后：导航里不再有独立页面入口，老链接仍然落到任务页
    const legacyInbox = await fetch(`${base}/inbox`, { headers: { cookie }, redirect: "manual" });
    check(
      "旧企微收件箱链接跳转任务页",
      legacyInbox.status === 302 && legacyInbox.headers.get("location") === "/tasks",
      `status=${legacyInbox.status} location=${legacyInbox.headers.get("location")}`,
    );
    check("导航不再单独显示企微收件箱入口", !reviewAll.includes("企微收件箱"));

    // 7) 退出登录并确认会话失效
    const logout = await fetch(`${base}/logout`, { method: "POST", redirect: "manual", headers: { cookie } });
    check("POST /logout 重定向回登录页", logout.status === 302, `status=${logout.status}`);
    const afterLogout = await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" });
    check("退出后会话失效（/ 再次重定向）", afterLogout.status === 302, `status=${afterLogout.status}`);
  } finally {
    await server?.stop();
    await webdav?.close();
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

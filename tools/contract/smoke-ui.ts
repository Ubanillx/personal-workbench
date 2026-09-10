/**
 * SSR 冒烟测试：不开浏览器也能验证"登录 → 外壳 → 页面数据"整条链路。
 *
 *   npx tsx tools/contract/smoke-ui.ts [baseUrl]
 *
 * 需要服务已启动，且 DATABASE_PATH 指向夹具库（见 make-fixture.ts，令牌 owner-token）。
 * 退出码 0 = 全部通过；非 0 = 有检查失败（逐条打印）。
 */

const base = (process.argv[2] ?? "http://127.0.0.1:18995").replace(/\/$/u, "");

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
}

async function main(): Promise<void> {
  // 1) 未登录访问首页 → 应重定向到登录页
  const anon = await fetch(`${base}/`, { redirect: "manual" });
  check(
    "未登录访问 / 重定向到 /access",
    anon.status === 302 && (anon.headers.get("location") ?? "").startsWith("/access"),
    `status=${anon.status} location=${anon.headers.get("location")}`,
  );

  // 2) 登录页 SSR 渲染
  const loginPage = await fetch(`${base}/access`);
  const loginHtml = await loginPage.text();
  check("GET /access 返回 200", loginPage.status === 200, `status=${loginPage.status}`);
  check("登录页含标题与 antd 样式类", loginHtml.includes("访问个人工作台") && loginHtml.includes("ant-"));

  // 3) 提交令牌换取会话
  const login = await fetch(`${base}/access`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "token=owner-token&redirectTo=%2F",
  });
  const setCookie = login.headers.getSetCookie?.()[0] ?? login.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  check(
    "POST /access 成功并下发会话 Cookie",
    login.status === 302 && cookie.includes("workbench_session="),
    `status=${login.status} cookie=${cookie.slice(0, 24)}`,
  );

  // 4) 会话可用性：API 与页面应一致
  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  check("GET /api/auth/me 用该会话返回 200", me.status === 200, `status=${me.status}`);

  const home = await fetch(`${base}/`, { headers: { cookie } });
  const homeHtml = await home.text();
  check("带会话 GET / 返回 200", home.status === 200, `status=${home.status}`);
  for (const needle of ["每日概览", "进行中任务", "待办清单", "退出"]) {
    check(`首页含「${needle}」`, homeHtml.includes(needle));
  }

  // 5) 页面 action：首页快捷新增待办（走共享服务，不是打 API）
  //    注意：向索引路由提交表单必须带 ?index（RR8 的 <Form> 会自动补，裸 fetch 需要自己加），
  //    否则会被父级 layout 路由吞掉并返回 405。
  const marker = `冒烟待办-${Date.now()}`;
  const add = await fetch(`${base}/?index`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `content=${encodeURIComponent(marker)}`,
  });
  check("POST /?index 快捷新增待办被接受（非 405）", add.status !== 405, `status=${add.status}`);

  const after = await fetch(`${base}/`, { headers: { cookie } });
  const afterHtml = await after.text();
  check("新增后首页出现该待办", afterHtml.includes(marker));

  // 6) 退出登录并确认会话失效
  const logout = await fetch(`${base}/logout`, { method: "POST", redirect: "manual", headers: { cookie } });
  check("POST /logout 重定向回登录页", logout.status === 302, `status=${logout.status}`);
  const afterLogout = await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" });
  check("退出后会话失效（/ 再次重定向）", afterLogout.status === 302, `status=${afterLogout.status}`);

  const failed = checks.filter((item) => !item.ok);
  for (const item of checks) {
    console.log(`${item.ok ? "✓" : "✗"} ${item.name}${item.detail === undefined ? "" : `  [${item.detail}]`}`);
  }
  console.log(`\n共 ${checks.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) process.exitCode = 1;
}

void main();

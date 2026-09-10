import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { createDatabaseClient } from "../../server/src/db/client";
import { setAccountPassword } from "../../server/src/security/account";
import { findFreePort, startServer } from "../../tools/contract/runner";

/**
 * 认证域端到端：用临时库 + 真实服务（`npm run serve`，跑 build/ 产物）验证
 * 「注册 → 登录 → 强制改密门禁 → 改密 → 业务端点恢复」这条 B 阶段主链路。
 *
 * 前提：先 `npm run build`（与 test:api / test:ui 相同）。改完代码不重新 build，
 * 这里跑的仍是上一次构建的产物。
 */

const migrationsDirectory = path.resolve(process.cwd(), "server/src/db/migrations");
const COOKIE = "workbench_session";
/** 迁移出来的账号拿到的是临时初始密码，登录后必须先改密 */
const INITIAL_PASSWORD = "initial-password-123";
const NEW_PASSWORD = "changed-password-456";

type Envelope = { ok: boolean; data?: unknown; error?: { code: string; message: string } };
type LoginResult = { status: number; cookie: string; body: Envelope };

let directory = "";
let databasePath = "";
let baseUrl = "";
let server: { stop: () => Promise<void>; output: () => string } | undefined;

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "workbench-auth-http-"));
  databasePath = path.join(directory, "workbench.sqlite");
  const uploadsDir = path.join(directory, "uploads");
  // 先把库迁到最新 schema 再交给服务；服务本身也会应用迁移，这里只是让测试的写入路径更明确
  const database = createDatabaseClient({ databasePath, migrationsDirectory });
  await database.close();

  const port = await findFreePort();
  server = await startServer({ serveNpm: "serve", fixture: { databasePath, uploadsDir }, port });
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await server?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function post(pathname: string, payload: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return fetch(`${baseUrl}${pathname}`, { method: "POST", headers, body: JSON.stringify(payload) });
}

function get(pathname: string, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, { headers: cookie ? { cookie } : {} });
}

/** 一律读完响应体：既拿到断言用的数据，也不留下没消费的 socket */
async function envelope(response: Response): Promise<Envelope> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Envelope;
  } catch {
    // 路由不存在时返回的可能是 HTML 错误页：给一条能看懂的失败信息，而不是 JSON 解析异常
    return { ok: false, error: { code: "NOT_JSON", message: text.slice(0, 200) } };
  }
}

function sessionCookie(response: Response): string {
  const raw = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

async function login(username: string, password: string): Promise<LoginResult> {
  const response = await post("/api/auth/login", { username, password });
  return { status: response.status, cookie: sessionCookie(response), body: await envelope(response) };
}

async function register(username: string, email: string, password: string, name: string): Promise<{ status: number; body: Envelope }> {
  const response = await post("/api/auth/register", { username, email, password, name });
  return { status: response.status, body: await envelope(response) };
}

/** 注册/登录的成功状态码文档没有钉死（新端点），200 与 201 都算成功 */
function assertAccepted(status: number, body: Envelope, what: string): void {
  assert.ok(status === 200 || status === 201, `${what}应成功，实际 ${status}：${JSON.stringify(body)}`);
  assert.equal(body.ok, true);
}

test("注册 → 登录 → 强制改密前业务端点 403 → 改密 → 业务端点可用", async () => {
  // 1. 注册（D-20：开放注册，注册成功即建会话）
  const registered = await register("newcomer", "newcomer@example.test", "register-password", "新同学");
  assertAccepted(registered.status, registered.body, "注册");

  // 2. 登录：用户名 + 密码 → 会话 Cookie
  const first = await login("newcomer", "register-password");
  assert.equal(first.status, 200, `注册后应能用用户名 + 密码登录：${JSON.stringify(first.body)}`);
  assert.ok(first.cookie.startsWith(`${COOKIE}=`), `登录应下发 ${COOKIE} Cookie，实际：${first.cookie}`);

  // 3. 把账号切成「迁移后拿到临时初始密码」的状态：must_change_password=1
  //    （注册时填的是本人密码，本来不需要强制改密；门禁只对初始/临时密码生效）
  await setAccountPassword({ databasePath, username: "newcomer", password: INITIAL_PASSWORD });

  const gated = await login("newcomer", INITIAL_PASSWORD);
  assert.equal(gated.status, 200, `临时密码也应能登录，只是业务端点会被门禁挡住：${JSON.stringify(gated.body)}`);
  const gatedCookie = gated.cookie;
  assert.ok(gatedCookie.startsWith(`${COOKIE}=`), `登录应下发 ${COOKIE} Cookie，实际：${gatedCookie}`);

  // 4. 「看自己」不受门禁限制，并如实暴露 mustChangePassword
  const me = await get("/api/auth/me", gatedCookie);
  const meBody = await envelope(me);
  assert.equal(me.status, 200, `「看自己」不应被强制改密门禁挡住：${JSON.stringify(meBody)}`);
  const meUser = (meBody.data as { user?: { username?: string; mustChangePassword?: boolean } } | undefined)?.user;
  assert.equal(meUser?.username, "newcomer");
  assert.equal(meUser?.mustChangePassword, true, "/api/auth/me 应报告必须改密");

  // 5. 未改密时业务端点一律 403 PASSWORD_CHANGE_REQUIRED
  const blocked = await get("/api/organizations", gatedCookie);
  const blockedBody = await envelope(blocked);
  assert.equal(blocked.status, 403, `未改密的会话访问业务端点应 403：${JSON.stringify(blockedBody)}`);
  assert.equal(blockedBody.error?.code, "PASSWORD_CHANGE_REQUIRED");

  // 6. 改密（需要旧密码）：成功后当前会话保留，其他会话被撤销
  const changed = await post("/api/auth/password", { currentPassword: INITIAL_PASSWORD, newPassword: NEW_PASSWORD }, gatedCookie);
  const changedBody = await envelope(changed);
  assert.equal(changed.status, 200, `改密应成功，实际 ${changed.status}：${JSON.stringify(changedBody)}`);
  assert.equal(changedBody.ok, true);

  // 7. 改密后同一个会话就能访问业务端点了
  const allowed = await get("/api/organizations", gatedCookie);
  const allowedBody = await envelope(allowed);
  assert.equal(allowed.status, 200, `改密后业务端点应恢复可用：${JSON.stringify(allowedBody)}`);

  // 8. 旧临时密码失效、新密码可登录
  assert.equal((await login("newcomer", INITIAL_PASSWORD)).status, 401, "改密后旧临时密码应失效");
  assert.equal((await login("newcomer", NEW_PASSWORD)).status, 200, "新密码应能登录");
});

test("登录失败一律 401：密码错与用户名不存在返回同一条消息", async () => {
  const registered = await register("existing", "existing@example.test", "existing-password", "已有账号");
  assertAccepted(registered.status, registered.body, "注册");

  const wrongPassword = await login("existing", "definitely-wrong");
  assert.equal(wrongPassword.status, 401, `密码错应 401：${JSON.stringify(wrongPassword.body)}`);
  assert.equal(wrongPassword.body.ok, false);
  assert.equal(wrongPassword.body.error?.code, "UNAUTHENTICATED");

  const unknownUser = await login("no-such-user", "whatever-password");
  assert.equal(unknownUser.status, 401, `用户名不存在应 401：${JSON.stringify(unknownUser.body)}`);
  assert.equal(unknownUser.body.error?.code, "UNAUTHENTICATED");
  // 不区分「账号不存在」与「密码错」，避免枚举账号
  assert.equal(unknownUser.body.error?.message, wrongPassword.body.error?.message, "两种失败必须返回同一条消息");

  const anonymous = await get("/api/organizations");
  const anonymousBody = await envelope(anonymous);
  assert.equal(anonymous.status, 401, `没有会话访问业务端点应 401：${JSON.stringify(anonymousBody)}`);
});

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";
import { ACCOUNTS, createFixture, IDS, removeFixture, type Fixture } from "../../tools/contract/fixture";
import { findFreePort, startServer } from "../../tools/contract/runner";

type Task = { id: string; title: string; ownerId: string | null; createdBy: string };
type Envelope<T> = { ok: boolean; data: T; error?: { code: string; message: string } };
type Account = { id: string; orgId: string | null; assigned: Task; own: Task };
let fixture: Fixture;
let server: Awaited<ReturnType<typeof startServer>>;
let database: DatabaseSync;
let base: string;
const cookies: Record<string, string> = {};
const accounts: Record<string, Account> = {};
const members = ["isolation_a", "isolation_b", "isolation_c"];

async function api<T>(actor: string, pathname: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { cookie: cookies[actor] ?? "", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Envelope<T> };
}

async function html(actor: string, pathname: string): Promise<string> {
  const response = await fetch(`${base}${pathname}`, { headers: { cookie: cookies[actor] ?? "" } });
  assert.equal(response.status, 200);
  return response.text();
}

async function create(actor: string, title: string, extra: Record<string, unknown> = {}): Promise<Task> {
  const response = await api<Task>(actor, "/api/tasks", "POST", { title, ...extra });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

before(async () => {
  fixture = createFixture();
  database = new DatabaseSync(fixture.databasePath);
  const port = await findFreePort();
  server = await startServer({ serveNpm: "serve", fixture, port });
  base = `http://127.0.0.1:${port}`;
  for (const actor of ["admin", "managerA", "managerB"] as const) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ACCOUNTS[actor]),
    });
    assert.equal(response.status, 200);
    cookies[actor] = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    await response.text();
  }

  // Exercise registration and invitations, not direct user inserts, so sessions see the real membership changes.
  for (const [index, actor] of [...members, "isolation_unjoined"].entries()) {
    const credentials = {
      username: actor,
      password: "isolation-test-password",
      email: `${actor}@example.test`,
      name: `隔离用户${index + 1}`,
    };
    const registered = await api<{ user: { id: string; role: string; orgId: string | null } }>(
      actor,
      "/api/auth/register",
      "POST",
      credentials,
    );
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    assert.equal(registered.body.data.user.role, "member");
    assert.equal(registered.body.data.user.orgId, null);
    const loggedIn = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials),
    });
    assert.equal(loggedIn.status, 200);
    cookies[actor] = (loggedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    await loggedIn.text();
    assert.deepEqual((await api<Task[]>(actor, "/api/tasks")).body.data, []);
    if (actor === "isolation_unjoined") continue;
    const orgId = index < 2 ? IDS.orgAlpha : IDS.orgBeta;
    const manager = index < 2 ? "managerA" : "managerB";
    const id = registered.body.data.user.id;
    assert.equal((await api(manager, `/api/organizations/${orgId}/invite`, "POST", { userId: id })).status, 200);
    const assigned = await create(manager, `隔离检查-${actor}-上级分派`, { ownerId: id });
    const own = await create(actor, `隔离检查-${actor}-本人创建`);
    assert.equal(assigned.ownerId, id);
    assert.equal(own.ownerId, id);
    accounts[actor] = { id, orgId, assigned, own };
  }
});

after(async () => {
  await server?.stop();
  database?.close();
  if (fixture) removeFixture(fixture);
});

test("真实注册4个账号、邀请3个成员、分配任务：同组和跨组列表/清单/首页互不可见", async () => {
  for (const actor of members) {
    const own = accounts[actor]!;
    const expected = [own.assigned.id, own.own.id].toSorted();
    for (const query of ["", "?includeArchived=1", `?assignee=${accounts.isolation_b!.id}`, `?org=${IDS.orgBeta}`]) {
      const response = await api<Task[]>(actor, `/api/tasks${query}`);
      assert.equal(response.status, 200);
      assert.ok(
        response.body.data.every((item) => expected.includes(item.id)),
        `${actor}: filter must not broaden access`,
      );
      if (!query) assert.deepEqual(response.body.data.map((item) => item.id).toSorted(), expected);
    }
    const dashboard = await api<{ tasks: Task[]; stats: { tasks: number } }>(actor, "/api/dashboard");
    assert.equal(dashboard.body.data.stats.tasks, 2);
    assert.deepEqual(dashboard.body.data.tasks.map((item) => item.id).toSorted(), expected);
    for (const pathname of ["/tasks", "/tasks?view=checklist", "/"]) {
      const markup = await html(actor, pathname);
      assert.ok(markup.includes(own.assigned.title));
      for (const other of members.filter((item) => item !== actor)) {
        assert.ok(!markup.includes(accounts[other]!.assigned.title), `${actor} must not see ${other} on ${pathname}`);
        assert.ok(!markup.includes(accounts[other]!.own.title));
      }
    }
  }
  assert.deepEqual((await api<Task[]>("isolation_unjoined", "/api/tasks")).body.data, []);
});

test("猜测其他用户任务ID：详情、评论、时间线、个人维度均拒绝，错误响应不含任务内容", async () => {
  for (const actor of members) {
    for (const other of members.filter((item) => item !== actor)) {
      const target = accounts[other]!;
      const status = accounts[actor]!.orgId === target.orgId ? 403 : 404;
      for (const suffix of ["comments", "activity", "personal"]) {
        const response = await api(actor, `/api/tasks/${target.assigned.id}/${suffix}`);
        assert.equal(response.status, status, `${actor} -> ${other}/${suffix}`);
        assert.equal(response.body.ok, false);
        assert.ok(!JSON.stringify(response.body).includes(target.assigned.title));
      }
      const markup = await html(actor, `/tasks?view=checklist&task=${target.assigned.id}&q=${encodeURIComponent(target.assigned.title)}`);
      assert.ok(markup.includes("该任务不存在，或你没有查看权限"));
      // Search input may echo the query; task data and detail must not be rendered.
      const direct = await html(actor, `/tasks?view=checklist&task=${target.assigned.id}`);
      assert.ok(!direct.includes(target.assigned.title));
      const search = await html(actor, `/tasks?q=${encodeURIComponent(target.assigned.title)}`);
      assert.equal([...search.matchAll(/data-row-key="([^"]+)"/gu)].length, 0, "search must not recover a hidden task");
    }
  }
});

test("越权修改/评论/汇报/验收/删除全部拒绝，数据库任务和流水不变", async () => {
  const snapshots = () =>
    ["tasks", "task_comments", "task_events", "task_progress_logs", "task_dimension_links", "personal_task_handling"].map((table) =>
      database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
  const beforeRows = snapshots();
  for (const actor of members) {
    for (const other of members.filter((item) => item !== actor)) {
      const target = accounts[other]!.assigned;
      const requests: Array<[string, string, unknown]> = [
        ["comments", "POST", { content: "越权评论" }],
        ["progress", "POST", { progress: 100, note: "越权完成" }],
        ["personal", "PATCH", { handled: true }],
        ["submit-review", "POST", {}],
        ["approve", "POST", {}],
        ["return", "POST", { note: "越权退回" }],
        ["remind", "POST", {}],
        ["archive", "POST", {}],
        ["restore", "POST", {}],
        ["", "PATCH", { title: "越权改名", ownerId: accounts[actor]!.id }],
        ["", "DELETE", undefined],
      ];
      for (const [suffix, method, body] of requests) {
        const response = await api(actor, `/api/tasks/${target.id}${suffix ? `/${suffix}` : ""}`, method, body);
        assert.ok(response.status === 403 || response.status === 404, `${actor} -> ${other}/${suffix}: ${response.status}`);
        assert.equal(response.body.ok, false);
      }
      for (const intent of ["progress", "comment", "personal-task", "update", "approve", "delete"]) {
        const response = await fetch(`${base}/tasks`, {
          method: "POST",
          headers: { cookie: cookies[actor] ?? "", "content-type": "application/json" },
          body: JSON.stringify({
            intent,
            taskId: target.id,
            progress: 100,
            content: "页面越权评论",
            note: "页面越权完成",
            title: "页面越权改名",
            handled: true,
          }),
        });
        assert.equal(response.status, 200);
        const markup = await response.text();
        assert.ok(/无权|权限|未找到|不存在|只有管理员或组织管理者可以执行此操作/u.test(markup), `page action ${intent} must report denial`);
        assert.ok(!markup.includes(target.title));
      }
    }
  }
  assert.deepEqual(snapshots(), beforeRows);
});

test("本人可汇报，上级可管理；管理员跨组可见，管理者不能读他人私密任务", async () => {
  for (const actor of members) {
    assert.equal(
      (await api(actor, `/api/tasks/${accounts[actor]!.assigned.id}/progress`, "POST", { progress: 25, note: "本人进展" })).status,
      200,
    );
  }
  const adminTasks = (await api<Task[]>("admin", "/api/tasks")).body.data;
  for (const actor of members) assert.ok(adminTasks.some((item) => item.id === accounts[actor]!.assigned.id));
  assert.equal((await api("managerB", `/api/tasks/${accounts.isolation_a!.assigned.id}/activity`)).status, 404);
  assert.equal((await api("managerA", `/api/tasks/${accounts.isolation_a!.assigned.id}/activity`)).status, 200);
  const privateTask = await create("admin", "隔离检查-管理员发布的私密任务", {
    orgId: IDS.orgAlpha,
    ownerId: accounts.isolation_a!.id,
    isPrivate: true,
  });
  assert.equal((await api("isolation_a", `/api/tasks/${privateTask.id}/activity`)).status, 200);
  assert.equal((await api("admin", `/api/tasks/${privateTask.id}/activity`)).status, 200);
  for (const actor of ["managerA", "isolation_b"]) {
    assert.equal((await api(actor, `/api/tasks/${privateTask.id}/activity`)).status, 403);
    assert.ok(!(await html(actor, "/tasks")).includes(privateTask.title));
  }
});

test("改派即时撤销原负责人可见性和通知，发布人仍保留可见性", async () => {
  const a = accounts.isolation_a!;
  const b = accounts.isolation_b!;
  assert.equal((await api("managerA", `/api/tasks/${a.assigned.id}`, "PATCH", { ownerId: b.id })).status, 200);
  assert.equal((await api("isolation_a", `/api/tasks/${a.assigned.id}/activity`)).status, 403);
  assert.equal((await api("isolation_b", `/api/tasks/${a.assigned.id}/activity`)).status, 200);
  for (const pathname of ["/tasks", "/tasks?view=checklist", "/"]) {
    assert.ok(!(await html("isolation_a", pathname)).includes(a.assigned.title));
  }
  for (const query of ["", "?unread=1"]) {
    const notices = await api<Array<{ taskId: string | null }>>("isolation_a", `/api/notifications${query}`);
    assert.ok(!notices.body.data.some((item) => item.taskId === a.assigned.id));
  }
  assert.equal((await api("managerA", `/api/tasks/${a.own.id}`, "PATCH", { ownerId: b.id })).status, 200);
  assert.equal((await api("isolation_a", `/api/tasks/${a.own.id}/activity`)).status, 200);
  assert.equal((await api("isolation_b", `/api/tasks/${a.own.id}/activity`)).status, 200);
  assert.equal((await api("isolation_a", `/api/tasks/${a.own.id}/progress`, "POST", { progress: 50 })).status, 403);
});

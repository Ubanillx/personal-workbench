import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { before, after } from "node:test";
import { ACCOUNTS, createFixture, IDS, removeFixture, type Fixture } from "../../tools/contract/fixture";
import { findFreePort, startServer } from "../../tools/contract/runner";

type Dimension = { id: string; name: string };
type State = { dimensionIds: string[]; handled: boolean };
type Task = { id: string; status: string; progress: number };
type Envelope<T> = { ok: boolean; data: T; error?: { code: string } };
let fixture: Fixture;
let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let database: DatabaseSync;
const cookies: Record<string, string> = {};

before(async () => {
  fixture = createFixture();
  const port = await findFreePort();
  server = await startServer({ serveNpm: "serve", fixture, port });
  base = `http://127.0.0.1:${port}`;
  database = new DatabaseSync(fixture.databasePath);
  for (const role of ["admin", "managerA", "memberA", "memberA2", "memberB", "noOrg", "mustChange"] as const) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ACCOUNTS[role]),
    });
    assert.equal(response.status, 200);
    cookies[role] = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    await response.text();
  }
});
after(async () => {
  await server?.stop();
  database?.close();
  if (fixture) removeFixture(fixture);
});

async function api<T>(role: string, path: string, method = "GET", body?: unknown): Promise<{ status: number; body: Envelope<T> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { cookie: cookies[role] ?? "", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Envelope<T> };
}
async function dimension(role: string, name: string): Promise<Dimension> {
  const result = await api<Dimension>(role, "/api/task-dimensions", "POST", { name });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.data;
}
async function create(role: string, title: string, extra: Record<string, unknown> = {}): Promise<Task> {
  const result = await api<Task>(role, "/api/tasks", "POST", { title, ...extra });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.data;
}
async function page(role: string, path: string): Promise<string> {
  const response = await fetch(`${base}${path}`, { headers: { cookie: cookies[role] ?? "" } });
  assert.equal(response.status, 200);
  return response.text();
}
const keys = (markup: string): string[] => [...markup.matchAll(/data-row-key="([^"]+)"/gu)].map((match) => match[1]!);
const text = (markup: string): string => markup.replace(/<[^>]*>/gu, "").replace(/\s+/gu, " ");

test("所有角色可管理本人维度；同名跨账号允许，其他账号及管理员均不可改", async () => {
  for (const role of ["admin", "managerA", "memberA", "noOrg"]) {
    const item = await dimension(role, "私人维度");
    assert.equal((await api(role, "/api/task-dimensions", "POST", { name: " 私人维度 " })).status, 400);
    assert.equal((await api(role, `/api/task-dimensions/${item.id}`, "PATCH", { name: "改名维度" })).status, 200);
    assert.equal((await api(role, `/api/task-dimensions/${item.id}`, "DELETE")).status, 200);
  }
  const own = await dimension("memberA", "JJA");
  const other = await dimension("memberA2", "JJA");
  assert.ok(!(await api<Dimension[]>("memberA", "/api/task-dimensions")).body.data.some((item) => item.id === other.id));
  for (const role of ["memberA2", "admin"]) {
    assert.equal((await api(role, `/api/task-dimensions/${own.id}`, "PATCH", { name: "偷改" })).status, 404);
    assert.equal((await api(role, `/api/task-dimensions/${own.id}`, "DELETE")).status, 404);
  }
  assert.equal((await api("anon", "/api/task-dimensions")).status, 401);
  assert.equal((await api("mustChange", "/api/task-dimensions")).body.error?.code, "PASSWORD_CHANGE_REQUIRED");
  assert.equal((await api("memberA", "/api/task-dimensions", "POST", { name: " " })).status, 400);
  assert.equal((await api("memberA", "/api/task-dimensions", "POST", { name: "a".repeat(41) })).status, 400);
  assert.equal((await api("memberA", "/api/task-dimensions", "PATCH", {})).status, 405);
  assert.equal((await api("memberA", "/api/task-dimensions", "POST", null)).status, 400);
});

test("可选多维度归类、后补与取消；删除一个维度不删除任务或其他关联", async () => {
  const a = await dimension("memberA", "多维度-A");
  const b = await dimension("memberA", "多维度-B");
  const task = await create("memberA", "多维度事项", { dimensionIds: [a.id, b.id, a.id] });
  let state = (await api<State>("memberA", `/api/tasks/${task.id}/personal`)).body.data;
  assert.deepEqual(state.dimensionIds.toSorted(), [a.id, b.id].toSorted());
  assert.equal((await api<Task[]>("memberA", `/api/tasks?dimension=${a.id}`)).body.data.filter((row) => row.id === task.id).length, 1);
  assert.equal(
    (await api<Task[]>("memberA", "/api/tasks?dimension=unclassified")).body.data.some((row) => row.id === task.id),
    false,
  );
  assert.equal((await api("memberA", `/api/task-dimensions/${a.id}`, "DELETE")).status, 200);
  state = (await api<State>("memberA", `/api/tasks/${task.id}/personal`)).body.data;
  assert.deepEqual(state.dimensionIds, [b.id]);
  assert.equal((await api("memberA", `/api/tasks/${task.id}/personal`, "PATCH", { dimensionIds: [] })).status, 200);
  assert.ok((await api<Task[]>("memberA", "/api/tasks?dimension=unclassified")).body.data.some((row) => row.id === task.id));
  const unclassified = await create("memberA", "先不分类");
  assert.deepEqual((await api<State>("memberA", `/api/tasks/${unclassified.id}/personal`)).body.data, { dimensionIds: [], handled: false });
  assert.equal((await api("memberA", `/api/tasks/${unclassified.id}/personal`, "PATCH", { dimensionIds: [b.id] })).status, 200);
});

test("跨维度和任务详情同步本人处理；不修改任务状态、进度、更新时间或流水，其他人独立", async () => {
  const a = await dimension("memberA", "同步-A");
  const b = await dimension("memberA", "同步-B");
  const task = await create("managerA", "同步事项", { ownerId: IDS.userMemberA });
  await api("memberA", `/api/tasks/${task.id}/personal`, "PATCH", { dimensionIds: [a.id, b.id] });
  const beforeTask = database.prepare("SELECT * FROM tasks WHERE id=?").get(task.id);
  const beforeLogs = database.prepare("SELECT COUNT(*) AS n FROM task_progress_logs WHERE task_id=?").get(task.id);
  assert.equal((await api("memberA", `/api/tasks/${task.id}/personal`, "PATCH", { handled: true })).status, 200);
  assert.deepEqual(database.prepare("SELECT * FROM tasks WHERE id=?").get(task.id), beforeTask);
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS n FROM task_progress_logs WHERE task_id=?").get(task.id), beforeLogs);
  assert.equal((await api<State>("managerA", `/api/tasks/${task.id}/personal`)).body.data.handled, false);
  for (const d of [a, b]) {
    const markup = await page("memberA", `/tasks?dimension=${d.id}&task=${task.id}`);
    assert.ok(text(markup).includes("已处理 1 / 1"));
    assert.ok(markup.includes(`aria-label="本人已处理：同步事项"`));
    assert.ok(markup.includes("汇报进度"));
    const checklist = await page("memberA", `/tasks?dimension=${d.id}&view=checklist`);
    assert.ok(checklist.includes("同步事项"));
    assert.ok(checklist.includes('checked=""'));
  }
  assert.equal((await api<Task[]>("memberA", `/api/tasks?dimension=${a.id}&hideHandled=1`)).body.data.length, 0);
  await api("memberA", `/api/tasks/${task.id}/personal`, "PATCH", { handled: false });
  assert.equal((await api<State>("memberA", `/api/tasks/${task.id}/personal`)).body.data.handled, false);
  const progress = await api<Task>("memberA", `/api/tasks/${task.id}/progress`, "POST", { progress: 100, note: "具体完成汇报" });
  assert.equal(progress.status, 200);
  assert.equal(progress.body.data.status, "pending_review");
  assert.equal((await api<State>("memberA", `/api/tasks/${task.id}/personal`)).body.data.handled, false);
  assert.equal((await api("memberA", `/api/tasks/${task.id}/approve`, "POST")).status, 403);
});

test("跨组织404、同组织无关403；改派后旧维度关联不能恢复可见性或统计", async () => {
  const dim = await dimension("memberA", "访问边界");
  const task = await create("managerA", "维度访问事项", { ownerId: IDS.userMemberA });
  await api("memberA", `/api/tasks/${task.id}/personal`, "PATCH", { dimensionIds: [dim.id], handled: true });
  for (const role of ["memberA2", "memberB"]) {
    const expected = role === "memberB" ? 404 : 403;
    assert.equal((await api(role, `/api/tasks/${task.id}/personal`)).status, expected);
    assert.equal((await api(role, `/api/tasks/${task.id}/personal`, "PATCH", { handled: true })).status, expected);
  }
  await api("managerA", `/api/tasks/${task.id}`, "PATCH", { ownerId: IDS.userMemberA2 });
  assert.equal((await api("memberA", `/api/tasks/${task.id}/personal`)).status, 403);
  assert.equal((await api<Task[]>("memberA", `/api/tasks?dimension=${dim.id}`)).body.data.length, 0);
  const markup = await page("memberA", `/tasks?dimension=${dim.id}&task=${task.id}`);
  assert.equal(keys(markup).length, 0);
  assert.ok(!markup.includes("维度访问事项"));
  assert.ok(text(markup).includes("已处理 0 / 0"));
});

test("非法或他人的维度不产生部分写入；客户端userId不能写到别人账号", async () => {
  const foreign = await dimension("memberA2", "外来维度");
  const own = await dimension("memberA", "合法维度");
  const task = await create("memberA", "原子归类");
  assert.equal(
    (await api("memberA", `/api/tasks/${task.id}/personal`, "PATCH", { dimensionIds: [own.id, foreign.id], handled: true })).status,
    404,
  );
  assert.deepEqual((await api<State>("memberA", `/api/tasks/${task.id}/personal`)).body.data, { dimensionIds: [], handled: false });
  const count = database.prepare("SELECT COUNT(*) AS n FROM tasks").get();
  assert.equal((await api("memberA", "/api/tasks", "POST", { title: "非法创建", dimensionIds: [foreign.id] })).status, 404);
  assert.deepEqual(database.prepare("SELECT COUNT(*) AS n FROM tasks").get(), count);
  for (const body of [{ dimensionIds: "bad" }, { dimensionIds: null }, { handled: "false" }, {}])
    assert.equal((await api("memberA", `/api/tasks/${task.id}/personal`, "PATCH", body)).status, 400);
  assert.equal((await api("memberA", `/api/tasks/${task.id}/personal`, "PATCH", { handled: true, userId: IDS.userManagerA })).status, 200);
  assert.equal((await api<State>("managerA", `/api/tasks/${task.id}/personal`)).body.data.handled, false);
  assert.equal((await api<Task[]>("memberA", `/api/tasks?dimension=${foreign.id}`)).body.data.length, 0);
});

test("维度筛选在全量排序分页前，统计去重且跨页一致；新建任务表单维度非必填", async () => {
  const a = await dimension("memberA", "分页维度");
  const b = await dimension("memberA", "重复归类");
  const ids: string[] = [];
  for (let i = 0; i < 23; i++) {
    const task = await create("memberA", `维度分页-${String(i).padStart(2, "0")}`, {
      priority: i % 2 ? "P0" : "P2",
      dimensionIds: [a.id, b.id],
    });
    ids.push(task.id);
  }
  const first = await page("memberA", `/tasks?dimension=${a.id}&size=20`);
  const second = await page("memberA", `/tasks?dimension=${a.id}&size=20&page=2`);
  assert.equal(keys(first).length, 20);
  assert.equal(keys(second).length, 3);
  assert.deepEqual([...keys(first), ...keys(second)].toSorted(), ids.toSorted());
  assert.ok(text(first).includes("已处理 0 / 23"));
  assert.ok(text(second).includes("已处理 0 / 23"));
  for (const id of keys(first).slice(0, 11))
    assert.equal(database.prepare("SELECT priority FROM tasks WHERE id=?").get(id)?.priority, "P0");
  assert.ok(first.includes('aria-label="任务维度"'));
  assert.ok(first.includes("管理维度"));
  const all = await api<Task[]>("memberA", "/api/tasks");
  assert.equal(new Set(all.body.data.map((row) => row.id)).size, all.body.data.length);
  const action = await fetch(`${base}/tasks`, {
    method: "POST",
    headers: { cookie: cookies.memberA ?? "", "content-type": "application/json" },
    body: JSON.stringify({ intent: "create", title: "页面可选归类", dimensionIds: [a.id] }),
  });
  assert.equal(action.status, 200);
  assert.ok(
    (await api<Task[]>("memberA", `/api/tasks?dimension=${a.id}`)).body.data.some(
      (row) => database.prepare("SELECT title FROM tasks WHERE id=?").get(row.id)?.title === "页面可选归类",
    ),
  );
});

test("数据库复合外键阻止跨账号关联；任务删除级联清理但删除类别保留处理标记", async () => {
  database.exec("PRAGMA foreign_keys=ON");
  const dim = await dimension("memberA", "级联维度");
  const task = await create("memberA", "级联任务", { dimensionIds: [dim.id] });
  assert.throws(() =>
    database.prepare("INSERT INTO task_dimension_links(user_id,task_id,dimension_id) VALUES(?,?,?)").run(IDS.userMemberA2, task.id, dim.id),
  );
  await api("memberA", `/api/tasks/${task.id}/personal`, "PATCH", { handled: true });
  await api("memberA", `/api/task-dimensions/${dim.id}`, "DELETE");
  assert.deepEqual((await api<State>("memberA", `/api/tasks/${task.id}/personal`)).body.data, { dimensionIds: [], handled: true });
  await api("managerA", `/api/tasks/${task.id}/archive`, "POST");
  await api("managerA", `/api/tasks/${task.id}`, "DELETE");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM personal_task_handling WHERE task_id=?").get(task.id)?.n, 0);
});

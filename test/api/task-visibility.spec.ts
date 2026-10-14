import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";
import { ACCOUNTS, createFixture, IDS, removeFixture, type Fixture } from "../../tools/contract/fixture";
import { findFreePort, startServer } from "../../tools/contract/runner";
import { toUser, USER_SELECT } from "../../app/lib/db.server";
import { countUnreadNotifications } from "../../app/lib/notifications.server";

type Task = { id: string; title: string; priority: string; createdBy: string; ownerId: string | null };
type Notice = { id: string; taskId: string | null; message: string };
type Envelope<T> = { ok: boolean; data: T; error?: { code: string } };
let fixture: Fixture;
let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let database: DatabaseSync;
const cookies: Record<string, string> = {};

before(async () => {
  fixture = createFixture();
  database = new DatabaseSync(fixture.databasePath);
  const port = await findFreePort();
  server = await startServer({ serveNpm: "serve", fixture, port });
  base = `http://127.0.0.1:${port}`;
  for (const role of ["admin", "managerA", "memberA", "memberA2", "memberB", "noOrg"] as const) {
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

async function api<T>(role: string, pathname: string, method = "GET", body?: unknown): Promise<{ status: number; body: Envelope<T> }> {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { cookie: cookies[role] ?? "", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Envelope<T> };
}

async function create(role: string, title: string, extra: Record<string, unknown> = {}): Promise<Task> {
  const result = await api<Task>(role, "/api/tasks", "POST", { title, ...extra });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.data;
}

async function html(role: string, pathname: string): Promise<string> {
  const response = await fetch(`${base}${pathname}`, { headers: { cookie: cookies[role] ?? "" } });
  assert.equal(response.status, 200);
  return response.text();
}

const rowKeys = (markup: string): string[] => [...markup.matchAll(/data-row-key="([^"]+)"/gu)].map((match) => match[1] ?? "");

test("成员仅看本人发布/负责，列表、详情、统计、评论和时间线同源", async () => {
  const own = await create("memberA", "权限核验-本人发布", { ownerId: IDS.userMemberA2 });
  assert.equal(own.ownerId, IDS.userMemberA, "成员不能借创建任务给别人分派");
  const assigned = await create("managerA", "权限核验-上级分派", { ownerId: IDS.userMemberA });
  const unrelated = await create("memberA2", "权限核验-其他成员发布");
  const privateOther = await create("managerA", "权限核验-其他人的私密", { isPrivate: true, ownerId: IDS.userMemberA2 });
  const list = (await api<Task[]>("memberA", "/api/tasks")).body.data;
  assert.ok(list.some((task) => task.id === own.id));
  assert.ok(list.some((task) => task.id === assigned.id));
  assert.ok(list.every((task) => task.createdBy === IDS.userMemberA || task.ownerId === IDS.userMemberA));
  assert.ok(!list.some((task) => task.id === unrelated.id || task.id === privateOther.id));
  assert.ok((await api<Task[]>("managerA", "/api/tasks")).body.data.some((task) => task.id === unrelated.id));
  assert.ok((await api<Task[]>("admin", "/api/tasks")).body.data.some((task) => task.id === privateOther.id));
  assert.deepEqual((await api<Task[]>("noOrg", "/api/tasks")).body.data, []);
  const filtered = (await api<Task[]>("memberA", `/api/tasks?assignee=${IDS.userMemberA2}`)).body.data;
  assert.ok(!filtered.some((task) => task.id === unrelated.id), "筛选不能扩大权限");
  for (const suffix of ["comments", "activity"]) {
    assert.equal((await api("memberA", `/api/tasks/${unrelated.id}/${suffix}`)).status, 403);
    assert.equal((await api("memberB", `/api/tasks/${own.id}/${suffix}`)).status, 404);
    assert.equal((await api("memberA", `/api/tasks/${own.id}/${suffix}`)).status, 200);
  }
  assert.equal((await api("memberA", `/api/tasks/${unrelated.id}/comments`, "POST", { content: "越权评论" })).status, 403);
  assert.equal((await api("memberA", `/api/tasks/${unrelated.id}/progress`, "POST", { progress: 50 })).status, 403);
  assert.equal((await api("memberA", `/api/tasks/${assigned.id}`, "PATCH", { priority: "P0" })).status, 403);
  const page = await html("memberA", `/tasks?task=${unrelated.id}`);
  assert.ok(page.includes("该任务不存在，或你没有查看权限"));
  assert.ok(!page.includes(unrelated.title));
  const dashboard = (await api<{ tasks: Task[]; stats: { tasks: number } }>("memberA", "/api/dashboard")).body.data;
  assert.equal(dashboard.stats.tasks, list.length);
  assert.deepEqual(dashboard.tasks.map((task) => task.id).toSorted(), list.map((task) => task.id).toSorted());
  assert.ok(!(await html("memberA", "/")).includes(unrelated.title));
  assert.equal((await api("memberA", `/api/tasks/${own.id}/archive`, "POST")).status, 403);
  assert.equal((await api("managerA", `/api/tasks/${own.id}/archive`, "POST")).status, 200);
  assert.ok(!(await api<Task[]>("memberA", "/api/tasks?includeArchived=1")).body.data.some((task) => task.id === own.id));
  assert.ok((await api<Task[]>("managerA", "/api/tasks?includeArchived=1")).body.data.some((task) => task.id === own.id));
  assert.equal((await api("managerA", `/api/tasks/${own.id}/restore`, "POST")).status, 200);
  assert.ok((await api<Task[]>("memberA", "/api/tasks")).body.data.some((task) => task.id === own.id));
});

test("本人发布的任务改派后仍可见；跨组织移动仍受组织边界约束", async () => {
  const task = await create("memberA", "权限核验-发布关系保留");
  assert.equal((await api("managerA", `/api/tasks/${task.id}`, "PATCH", { ownerId: IDS.userMemberA2 })).status, 200);
  assert.equal((await api("memberA", `/api/tasks/${task.id}/activity`)).status, 200);
  assert.equal((await api("memberA2", `/api/tasks/${task.id}/activity`)).status, 200);
  assert.equal((await api("memberA", `/api/tasks/${task.id}/progress`, "POST", { progress: 20 })).status, 403);
  assert.equal((await api("admin", `/api/tasks/${task.id}`, "PATCH", { orgId: IDS.orgBeta, ownerId: IDS.userMemberB })).status, 200);
  assert.equal((await api("memberA", `/api/tasks/${task.id}/activity`)).status, 404);
  assert.equal((await api("memberB", `/api/tasks/${task.id}/activity`)).status, 200);
  assert.ok(!(await api<Notice[]>("memberA", "/api/notifications")).body.data.some((notice) => notice.taskId === task.id));
});

test("改派撤销原负责人的通知可见性，实时侧栏收到重同步而不是不可见任务内容", async () => {
  const task = await create("managerA", "通知核验-改派任务", { ownerId: IDS.userMemberA });
  assert.ok((await api<Notice[]>("memberA", "/api/notifications?unread=1")).body.data.some((notice) => notice.taskId === task.id));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${base}/api/notifications/stream`, {
      headers: { cookie: cookies.memberA ?? "" },
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let messages = "";
    const until = async (needle: string): Promise<void> => {
      while (!messages.includes(needle)) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, "SSE 提前结束");
        messages += decoder.decode(chunk.value, { stream: true });
      }
    };
    await until("event: ready");
    messages = "";
    assert.equal((await api("managerA", `/api/tasks/${task.id}`, "PATCH", { ownerId: IDS.userMemberA2 })).status, 200);
    await until("event: resync");
    const marker = await create("managerA", "通知核验-仍可见的新任务", { ownerId: IDS.userMemberA });
    await until(marker.id);
    assert.ok(!messages.includes(task.title), "不可见任务不应作为实时 notification 推送");
    await reader.cancel();
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  for (const query of ["", "?unread=1"]) {
    assert.ok(!(await api<Notice[]>("memberA", `/api/notifications${query}`)).body.data.some((notice) => notice.taskId === task.id));
  }
  assert.equal((await api("memberA", `/api/tasks/${task.id}/activity`)).status, 403);
  assert.equal((await api("memberA2", `/api/tasks/${task.id}/activity`)).status, 200);
  assert.ok(!(await html("memberA", "/")).includes(task.title), "外壳历史通知也必须隐藏");
  assert.ok(
    Number(
      database.prepare("SELECT COUNT(*) AS n FROM notifications WHERE task_id=? AND recipient_id=?").get(task.id, IDS.userMemberA)?.n,
    ) > 0,
    "历史通知保留在库中",
  );
});

test("通知未读计数与列表一致，管理者不能从历史通知读取他人的私密任务", async () => {
  const task = await create("admin", "通知核验-管理者无关的私密任务", { orgId: IDS.orgAlpha, ownerId: IDS.userMemberA2, isPrivate: true });
  database
    .prepare(
      "INSERT INTO notifications(id,recipient_id,task_id,event_type,title,message,is_read,created_at) VALUES(?,?,?,'task_assigned',?,?,0,?)",
    )
    .run("hidden-manager-notice", IDS.userManagerA, task.id, task.title, task.title, new Date().toISOString());
  assert.ok(!(await api<Notice[]>("managerA", "/api/notifications")).body.data.some((notice) => notice.taskId === task.id));
  assert.ok(!(await html("managerA", "/")).includes(task.title));
  const generic = "通用通知保留";
  database
    .prepare("INSERT INTO notifications(id,recipient_id,event_type,title,message,is_read,created_at) VALUES(?,?,'task_assigned',?,?,0,?)")
    .run("generic-member-notice", IDS.userMemberA, generic, generic, new Date().toISOString());
  assert.ok((await api<Notice[]>("memberA", "/api/notifications")).body.data.some((notice) => notice.id === "generic-member-notice"));
  const userRow = database.prepare(`${USER_SELECT} WHERE u.id=?`).get(IDS.userMemberA);
  assert.ok(userRow);
  assert.equal(
    countUnreadNotifications(database, toUser(userRow)),
    (await api<Notice[]>("memberA", "/api/notifications?unread=1")).body.data.length,
  );
});

test("企微预览/导入只对可见任务判重，不泄露其他成员的任务", async () => {
  const draft = { title: "去重核验-同一企微消息", fingerprint: "task-visibility-fingerprint" };
  assert.equal((await api("managerA", "/api/inbox/import", "POST", { drafts: [{ ...draft, ownerId: IDS.userMemberA2 }] })).status, 201);
  assert.equal(
    (await api<Array<{ duplicate: boolean }>>("memberA", "/api/inbox/preview", "POST", { drafts: [draft] })).body.data[0]?.duplicate,
    false,
  );
  assert.equal(
    (await api<Array<{ duplicate: boolean }>>("memberA2", "/api/inbox/preview", "POST", { drafts: [draft] })).body.data[0]?.duplicate,
    true,
  );
  const imported = await api<{ created: Task[]; skipped: unknown[] }>("memberA", "/api/inbox/import", "POST", { drafts: [draft] });
  assert.equal(imported.body.data.created.length, 1);
  assert.equal(imported.body.data.skipped.length, 0);
  assert.equal(
    (await api<Array<{ duplicate: boolean }>>("memberA", "/api/inbox/preview", "POST", { drafts: [draft] })).body.data[0]?.duplicate,
    true,
  );
  assert.equal(
    (await api<{ skipped: unknown[] }>("memberA", "/api/inbox/import", "POST", { drafts: [draft] })).body.data.skipped.length,
    1,
  );
});

test("优先级全量排序后分页，同级更新时间/ID 稳定，角色默认与 URL 选择一致", async () => {
  const tasks: Array<Task & { updated: string }> = [];
  for (let index = 0; index < 24; index += 1) {
    const priority = ["P2", "P0", "P1"][index % 3] ?? "P1";
    const task = await create("memberA", `排序核验-${index.toString().padStart(2, "0")}`, { priority });
    const updated = index % 2 ? "2026-10-02T00:00:00.000Z" : "2026-10-01T00:00:00.000Z";
    database.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(updated, task.id);
    tasks.push({ ...task, updated });
  }
  const expected = tasks
    .toSorted((a, b) => a.priority.localeCompare(b.priority) || b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id))
    .map((task) => task.id);
  const query = "/tasks?q=" + encodeURIComponent("排序核验-");
  assert.deepEqual(rowKeys(await html("memberA", query + "&size=100")), expected);
  const pages = await Promise.all([1, 2, 3].map((page) => html("memberA", `${query}&size=10&page=${page}`)));
  assert.deepEqual(pages.flatMap(rowKeys), expected, "跨页排序不重不漏");
  assert.deepEqual(rowKeys(await html("memberA", `${query}&size=10&page=2`)), expected.slice(10, 20), "刷新排序保持");
  assert.deepEqual(
    rowKeys(await html("memberA", `${query}&size=100&sort=priority&order=desc`)),
    tasks
      .toSorted((a, b) => b.priority.localeCompare(a.priority) || b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id))
      .map((task) => task.id),
  );
  const recent = tasks.toSorted((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id)).map((task) => task.id);
  for (const role of ["admin", "managerA"]) {
    assert.deepEqual(rowKeys(await html(role, query + "&size=100")), recent);
    assert.deepEqual(rowKeys(await html(role, query + "&size=100&sort=priority&order=asc")), expected);
  }
  assert.deepEqual(rowKeys(await html("memberA", `${query}&size=100&sort=updatedAt&order=desc`)), recent);
  assert.deepEqual(rowKeys(await html("memberA", `${query}&size=100&sort=DROP%20TABLE%20tasks&order=invalid`)), expected);
  assert.deepEqual(rowKeys(await html("memberA", query + "&size=100")), expected, "重新进入回到角色默认");
  assert.ok((await html("memberA", query)).includes("优先级：高优先在前"));
  const stored = (await api<Task[]>("memberA", "/api/tasks")).body.data;
  for (const task of tasks) assert.equal(stored.find((item) => item.id === task.id)?.priority, task.priority, "排序不修改等级");
});

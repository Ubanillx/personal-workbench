import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../../server/src/app";
import { loadConfig } from "../../server/src/config/env";
import { createDatabaseClient, type DatabaseClient } from "../../server/src/db/client";

const migrationsDirectory = path.resolve(process.cwd(), "server/src/db/migrations");

test("协作工作流会执行角色、验收、通知、归档和令牌权限", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-workflow-"));
  const databasePath = path.join(directory, "workbench.sqlite");
  const database = createDatabaseClient({ databasePath, migrationsDirectory });
  const app = await buildApp({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: databasePath }, process.cwd()), database });
  t.after(async () => { await app.close(); await database.close(); await rm(directory, { recursive: true, force: true }); });
  seed(database);

  const ping = await app.inject({ method: "GET", url: "/api/ping" });
  const csp = ping.headers["content-security-policy"] as string | undefined;
  assert.ok(csp, "expected a Content-Security-Policy header");
  assert.equal(csp.includes("upgrade-insecure-requests"), false, "CSP must not force https upgrades on a plain-HTTP LAN service");
  assert.equal(ping.headers["strict-transport-security"], undefined, "HSTS is meaningless on plain HTTP and must not be emitted");
  assert.equal(ping.headers["cross-origin-opener-policy"], undefined, "COOP must not be emitted on a plain-HTTP service");

  const owner = await login(app, "owner-token");
  const assistant = await login(app, "assistant-a-token");
  const viewer = await login(app, "viewer-token");

  const accessInfo = await request(app, owner, "GET", "/api/access-info");
  assert.equal(accessInfo.statusCode, 200);
  assert.equal(accessInfo.json().data.port, 17500);
  assert.match(accessInfo.json().data.localUrl, /^http:\/\/127\.0\.0\.1:17500$/u);
  assert.equal((await request(app, assistant, "GET", "/api/access-info")).statusCode, 403);
  assert.equal((await request(app, viewer, "GET", "/api/access-info")).statusCode, 403);
  assert.equal((await request(app, assistant, "GET", "/api/users")).statusCode, 403);
  assert.equal((await request(app, assistant, "POST", "/api/users", { name: "越权成员", role: "assistant" })).statusCode, 403);
  const addedMember = await request(app, owner, "POST", "/api/users", { name: "新助理", role: "assistant" });
  assert.equal(addedMember.statusCode, 201);
  assert.equal(addedMember.json().data.user.role, "assistant");
  assert.equal(typeof addedMember.json().data.token, "string");

  const created = await request(app, owner, "POST", "/api/tasks", { title: "验收任务", ownerId: "assistant-a", priority: "P1" });
  assert.equal(created.statusCode, 201);
  const taskId = created.json().data.id as string;
  assert.equal(created.json().data.ownerId, "assistant-a");

  const assistantTasks = await request(app, assistant, "GET", "/api/tasks");
  assert.deepEqual(assistantTasks.json().data.map((task: { id: string }) => task.id), [taskId]);
  const viewerTasks = await request(app, viewer, "GET", "/api/tasks");
  assert.deepEqual(viewerTasks.json().data.map((task: { id: string }) => task.id), [taskId]);
  assert.equal((await request(app, assistant, "PATCH", `/api/tasks/${taskId}`, { title: "越权修改" })).statusCode, 403);
  assert.equal((await request(app, viewer, "POST", `/api/tasks/${taskId}/progress`, { progress: 20 })).statusCode, 403);
  assert.equal((await request(app, viewer, "GET", "/api/todos")).statusCode, 403);

  const submitted = await request(app, assistant, "POST", `/api/tasks/${taskId}/progress`, { progress: 100, note: "已完成初稿" });
  assert.equal(submitted.statusCode, 200);
  assert.equal(submitted.json().data.status, "pending_review");
  const ownerNotifications = await request(app, owner, "GET", "/api/notifications?unread=1");
  assert.ok(ownerNotifications.json().data.some((item: { taskId: string; eventType: string }) => item.taskId === taskId && item.eventType === "task_submitted"));
  const activity = await request(app, owner, "GET", `/api/tasks/${taskId}/activity`);
  assert.ok(activity.json().data.some((item: { kind: string }) => item.kind === "task_submitted"));

  const approved = await request(app, owner, "POST", `/api/tasks/${taskId}/approve`, { note: "验收通过" });
  assert.equal(approved.json().data.status, "completed");
  const assistantNotifications = await request(app, assistant, "GET", "/api/notifications?unread=1");
  assert.ok(assistantNotifications.json().data.some((item: { taskId: string; eventType: string }) => item.taskId === taskId && item.eventType === "task_approved"));
  await request(app, owner, "POST", "/api/notifications/read", { taskId });
  assert.equal((await request(app, owner, "GET", "/api/notifications?unread=1")).json().data.some((item: { taskId: string }) => item.taskId === taskId), false);

  const returnedTask = await request(app, owner, "POST", "/api/tasks", { title: "需要返工", ownerId: "assistant-a" });
  const returnedId = returnedTask.json().data.id as string;
  await request(app, assistant, "POST", `/api/tasks/${returnedId}/progress`, { progress: 100 });
  const returned = await request(app, owner, "POST", `/api/tasks/${returnedId}/return`, { note: "请补齐截图" });
  assert.equal(returned.json().data.status, "in_progress");
  assert.equal(returned.json().data.progress, 99);
  const comment = await request(app, viewer, "POST", `/api/tasks/${returnedId}/comments`, { content: "请补充反馈" });
  assert.equal(comment.statusCode, 201);
  assert.ok((await request(app, owner, "GET", `/api/tasks/${returnedId}/activity`)).json().data.some((item: { kind: string; content: string }) => item.kind === "comment" && item.content === "请补充反馈"));

  const reassigned = await request(app, owner, "PATCH", `/api/tasks/${returnedId}`, { ownerId: "assistant-b", title: "需要返工" });
  assert.equal(reassigned.json().data.ownerId, "assistant-b");
  assert.ok((await request(app, owner, "GET", `/api/tasks/${returnedId}/activity`)).json().data.some((item: { kind: string }) => item.kind === "task_reassigned"));
  await request(app, owner, "POST", `/api/tasks/${returnedId}/archive`);
  assert.equal((await request(app, owner, "DELETE", `/api/tasks/${returnedId}`)).statusCode, 200);
  assert.equal((await request(app, owner, "GET", "/api/tasks?includeArchived=1")).json().data.some((task: { id: string }) => task.id === returnedId), false);

  const firstImport = await request(app, owner, "POST", "/api/inbox/import", { drafts: [{ title: "企微任务", ownerId: "assistant-b", fingerprint: "wecom-fixture" }] });
  assert.equal(firstImport.json().data.created.length, 1);
  const secondImport = await request(app, owner, "POST", "/api/inbox/import", { drafts: [{ title: "企微任务", ownerId: "assistant-b", fingerprint: "wecom-fixture" }] });
  assert.equal(secondImport.json().data.skipped.length, 1);

  assert.equal((await request(app, owner, "PATCH", "/api/users/assistant-a", { isActive: false })).statusCode, 200);
  assert.equal((await request(app, assistant, "GET", "/api/tasks")).statusCode, 401);
  assert.equal((await rawLogin(app, "assistant-a-token")).statusCode, 401);
  await request(app, owner, "PATCH", "/api/users/assistant-a", { isActive: true });
  const rotated = await request(app, owner, "POST", "/api/users/assistant-a/token");
  assert.equal((await rawLogin(app, "assistant-a-token")).statusCode, 401);
  assert.equal((await rawLogin(app, rotated.json().data.token as string)).statusCode, 200);
});

function seed(database: DatabaseClient): void {
  const db = database.getDatabase(); const stamp = new Date().toISOString();
  for (const [id, name, role, token] of [["owner", "主人", "owner", "owner-token"], ["assistant-a", "助理 A", "assistant", "assistant-a-token"], ["assistant-b", "助理 B", "assistant", "assistant-b-token"], ["viewer-a", "查看者", "viewer", "viewer-token"]] as const) {
    db.prepare("INSERT INTO users(id,name,role,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, name, role, 1, stamp, stamp);
    db.prepare("INSERT INTO access_tokens(id,user_id,token_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,NULL,NULL)").run(`token-${id}`, id, hash(token), stamp);
  }
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, token: string): Promise<string> { const response = await rawLogin(app, token); assert.equal(response.statusCode, 200); const cookie = response.headers["set-cookie"]; return Array.isArray(cookie) ? cookie[0]!.split(";")[0]! : String(cookie).split(";")[0]!; }
function rawLogin(app: Awaited<ReturnType<typeof buildApp>>, token: string) { return app.inject({ method: "POST", url: "/api/auth/access", payload: { token } }); }
function request(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>) { return app.inject({ method, url, headers: { cookie }, payload }); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

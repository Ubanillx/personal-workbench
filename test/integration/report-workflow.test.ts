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

test("周报功能会执行上传、代传、审核、退回、版本与权限", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "report-workflow-"));
  const databasePath = path.join(directory, "workbench.sqlite");
  const uploadsDir = path.join(directory, "uploads");
  const database = createDatabaseClient({ databasePath, migrationsDirectory });
  const app = await buildApp({ config: loadConfig({ NODE_ENV: "test", DATABASE_PATH: databasePath, UPLOADS_DIR: uploadsDir }, process.cwd()), database, uploadsDir });
  t.after(async () => { await app.close(); await database.close(); await rm(directory, { recursive: true, force: true }); });
  seed(database);

  const owner = await login(app, "owner-token");
  const assistant = await login(app, "assistant-a-token");
  const assistantB = await login(app, "assistant-b-token");
  const viewer = await login(app, "viewer-token");

  // viewer 不可见
  assert.equal((await request(app, viewer, "GET", "/api/reports")).statusCode, 403);

  // 助理上传自己的周报
  const uploaded = await upload(app, assistant, "/api/reports", {
    fields: { periodStart: "2026-09-01", periodEnd: "2026-09-07", docType: "weekly_report", note: "第一周" },
    file: { name: "wennie-week1.xlsx", content: Buffer.from("fake-xlsx") }
  });
  assert.equal(uploaded.statusCode, 201);
  const reportId = uploaded.json().data.id as string;
  assert.equal(uploaded.json().data.status, "submitted");
  assert.equal(uploaded.json().data.ownerId, "assistant-a");
  assert.equal(uploaded.json().data.currentVersion, 1);
  assert.equal(uploaded.json().data.files.length, 1);
  // 主人收到“助理提交周报”通知
  const ownerNotifs = await request(app, owner, "GET", "/api/notifications?unread=1");
  assert.ok(ownerNotifs.json().data.some((n: { reportId: string; eventType: string }) => n.reportId === reportId && n.eventType === "report_submitted"));

  // 主人代传给 assistant-b
  const forB = await upload(app, owner, "/api/reports", {
    fields: { ownerId: "assistant-b", periodStart: "2026-09-01", periodEnd: "2026-09-07", docType: "summary" },
    file: { name: "leah-summary.docx", content: Buffer.from("fake-docx") }
  });
  assert.equal(forB.statusCode, 201);
  assert.equal(forB.json().data.ownerId, "assistant-b");

  // 助理只看得到自己的
  const aList = await request(app, assistant, "GET", "/api/reports");
  assert.equal(aList.json().data.length, 1);
  assert.equal(aList.json().data[0].ownerId, "assistant-a");
  assert.equal((await request(app, owner, "GET", "/api/reports")).json().data.length, 2);

  // 非法扩展名
  const badExt = await upload(app, assistant, "/api/reports", {
    fields: { periodStart: "2026-09-01", periodEnd: "2026-09-07", docType: "weekly_report" },
    file: { name: "evil.exe", content: Buffer.from("x") }
  });
  assert.equal(badExt.statusCode, 400);

  // 助理不能审核
  assert.equal((await request(app, assistant, "POST", `/api/reports/${reportId}/approve`, {})).statusCode, 403);
  // 退回必须填原因
  assert.equal((await request(app, owner, "POST", `/api/reports/${reportId}/return`, {})).statusCode, 400);
  const returned = await request(app, owner, "POST", `/api/reports/${reportId}/return`, { note: "请补充数据" });
  assert.equal(returned.json().data.status, "returned");
  assert.equal(returned.json().data.reviewNote, "请补充数据");
  // 助理收到“周报已退回”通知
  assert.ok((await request(app, assistant, "GET", "/api/notifications?unread=1")).json().data.some((n: { reportId: string; eventType: string }) => n.reportId === reportId && n.eventType === "report_returned"));

  // 助理重新上传新版本，历史保留
  const resubmitted = await upload(app, assistant, `/api/reports/${reportId}/file`, {
    fields: {},
    file: { name: "wennie-week1-v2.xlsx", content: Buffer.from("fake-xlsx-v2") }
  });
  assert.equal(resubmitted.statusCode, 201);
  assert.equal(resubmitted.json().data.status, "submitted");
  assert.equal(resubmitted.json().data.currentVersion, 2);
  assert.equal(resubmitted.json().data.files.length, 2);

  // 主人通过
  const approved = await request(app, owner, "POST", `/api/reports/${reportId}/approve`, { note: "通过" });
  assert.equal(approved.json().data.status, "approved");
  // 助理收到“周报已通过”通知
  assert.ok((await request(app, assistant, "GET", "/api/notifications?unread=1")).json().data.some((n: { reportId: string; eventType: string }) => n.reportId === reportId && n.eventType === "report_approved"));

  // 下载最新版本
  const download = await requestRaw(app, owner, "GET", `/api/reports/${reportId}/file/2`);
  assert.equal(download.statusCode, 200);
  assert.match(String(download.headers["content-disposition"] ?? ""), /wennie-week1-v2\.xlsx/u);
  assert.equal(download.body, "fake-xlsx-v2");

  // 助理不能看别人的详情
  assert.equal((await request(app, assistant, "GET", `/api/reports/${forB.json().data.id}`)).statusCode, 403);
});

function seed(database: DatabaseClient): void {
  const db = database.getDatabase(); const stamp = new Date().toISOString();
  for (const [id, name, role, token] of [["owner", "主人", "owner", "owner-token"], ["assistant-a", "助理 A", "assistant", "assistant-a-token"], ["assistant-b", "助理 B", "assistant", "assistant-b-token"], ["viewer-a", "查看者", "viewer", "viewer-token"]] as const) {
    db.prepare("INSERT INTO users(id,name,role,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, name, role, 1, stamp, stamp);
    db.prepare("INSERT INTO access_tokens(id,user_id,token_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,NULL,NULL)").run(`token-${id}`, id, hash(token), stamp);
  }
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, token: string): Promise<string> {
  const response = await rawLogin(app, token);
  assert.equal(response.statusCode, 200);
  const cookie = response.headers["set-cookie"];
  return Array.isArray(cookie) ? cookie[0]!.split(";")[0]! : String(cookie).split(";")[0]!;
}
function rawLogin(app: Awaited<ReturnType<typeof buildApp>>, token: string) { return app.inject({ method: "POST", url: "/api/auth/access", payload: { token } }); }
function request(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>) { return app.inject({ method, url, headers: { cookie }, payload }); }
function requestRaw(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, method: "GET", url: string) { return app.inject({ method, url, headers: { cookie } }); }

function upload(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, url: string, payload: { fields: Record<string, string>; file: { name: string; content: Buffer } }) {
  const { body, contentType } = buildMultipart(payload.fields, payload.file);
  return app.inject({ method: "POST", url, headers: { cookie, "content-type": contentType }, payload: body });
}

function buildMultipart(fields: Record<string, string>, file: { name: string; content: Buffer }): { body: Buffer; contentType: string } {
  const boundary = "----workbench-report-boundary";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(file.content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

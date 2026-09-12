import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync as SQLiteDatabase } from "node:sqlite";
import { after, before, test } from "node:test";
import * as storage from "../../app/lib/report-storage.server";
import * as settings from "../../app/lib/webdav-settings.server";
import { createDatabaseClient } from "../../server/src/db/client";
import { startFakeWebDav, type FakeWebDavServer } from "../../tools/webdav/fake-server";

/**
 * 周报正文的**远端存储层**测试（D-46，见 docs/harness/REPORTS_WEBDAV.md）。
 *
 * 覆盖三件事：
 * 1. 命名规则：`<上传根>/<用户名>/<起止日期>/<文件名>`，重传 `_v{n}`、撞名 `_2`、远端绝不覆盖；
 * 2. 下载：从远端流式读，远端没有就是 null；
 * 3. 存量搬迁 CLI：`--dry-run` 不动任何东西、正常跑幂等（认领而不是重复上传）、`--purge` 才删本地。
 *
 * 环境要点：`app/lib/context.server.ts` 会把配置缓存下来，所以 `DATABASE_PATH` / `WEBDAV_URL` / `UPLOADS_DIR`
 * 必须在**第一次真正用到它们之前**设好。应用层模块在**导入时**不读配置（只在函数里读），
 * 因此这里可以正常静态导入，把赋值放进 `before()` 即可。
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), "server/src/db/migrations");
const STAMP = "2026-09-01T00:00:00.000Z";
const USER_ID = "user-zhangsan";
const REPORT_ID = "report-legacy-1";
const FILE_ID = "report-file-legacy-1";

let server: FakeWebDavServer;
let workDir: string;
let databasePath: string;
let uploadsDir: string;

/** CLI 子进程环境：与 before 里设的一致 */
function cliEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DATABASE_PATH: databasePath, UPLOADS_DIR: uploadsDir, WEBDAV_URL: server.baseUrl, NODE_ENV: "test" };
}

/**
 * 跑一次搬迁 CLI。
 *
 * 刻意**不用** `spawnSync`：假 NAS 就跑在本进程里，同步等待会把事件循环堵死，
 * 子进程发出的 PROPFIND 永远等不到响应（实测 15 秒超时）。
 */
function runMigrate(args: string[]): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tools/reports-migrate-webdav.ts", ...args], {
      cwd: process.cwd(),
      env: cliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("close", (status) => resolve({ status, output }));
  });
}

before(async () => {
  server = await startFakeWebDav();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-report-storage-"));
  databasePath = path.join(workDir, "workbench.sqlite");
  uploadsDir = path.join(workDir, "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });

  process.env.DATABASE_PATH = databasePath;
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.WEBDAV_URL = server.baseUrl;
  process.env.NODE_ENV = "test";

  // 种子：一个组织 + 一个成员 + 一条「老式」周报（正文在本地磁盘上，等着被搬迁）
  // 插入顺序是刚需：organizations.created_by 引用 users(id)，而 users.org_id 又引用 organizations(id)
  const client = createDatabaseClient({ databasePath, readOnly: false, migrationsDirectory: MIGRATIONS_DIR });
  const db = client.getDatabase();
  db.prepare(
    "INSERT INTO users(id,username,email,name,role,org_id,password_hash,must_change_password,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)",
  ).run(USER_ID, "zhangsan", "zhangsan@local.invalid", "张三", "member", null, "locked$", 0, STAMP, STAMP);
  db.prepare(
    "INSERT INTO organizations(id,name,description,status,created_by,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run("org-1", "阿尔法", "", "active", USER_ID, STAMP, STAMP, null);
  db.prepare("UPDATE users SET org_id=? WHERE id=?").run("org-1", USER_ID);
  db.prepare(
    `INSERT INTO weekly_reports(id,org_id,owner_id,period_start,period_end,doc_type,note,status,current_version,uploaded_by,review_note,created_at,updated_at,submitted_at,reviewed_at,returned_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    REPORT_ID,
    "org-1",
    USER_ID,
    "2026-08-01",
    "2026-08-07",
    "weekly_report",
    "老式第八周",
    "submitted",
    1,
    USER_ID,
    null,
    STAMP,
    STAMP,
    STAMP,
    null,
    null,
  );
  db.prepare(
    "INSERT INTO report_files(id,report_id,version,original_name,stored_name,size_bytes,ext,mime_type,uploaded_by,uploaded_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(FILE_ID, REPORT_ID, 1, "第八周周报.docx", "v1.docx", 7, ".docx", "application/msword", USER_ID, STAMP);
  const legacyDir = path.join(uploadsDir, REPORT_ID);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "v1.docx"), "老版正文");
  db.close();

  // 统一上传账号：匿名即可（假服务器不校验），上传根用默认的 /周报
  const saved = settings.saveReportUploadSettings(USER_ID, { username: "", password: "", root: "/周报", timeoutMs: 15000 });
  assert.deepEqual(saved, { ok: true }, "夹具里的周报上传配置应保存成功");
});

after(async () => {
  await server?.close();
  try {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (error) {
    // 应用层单例连接还开着时 Windows 会 EPERM；临时目录残留无害，不要因此让测试失败
    console.warn(`临时目录未能删除（可忽略）：${error instanceof Error ? error.message : String(error)}`);
  }
});

/* ------------------------------------------------------------------ 命名（纯函数） */

test("命名规则：目录、清洗、后缀与 stored_name 前缀", () => {
  assert.equal(
    storage.remoteDirectoryFor("/周报", { username: "zhangsan", periodStart: "2026-09-01", periodEnd: "2026-09-07" }),
    "/周报/zhangsan/2026-09-01_2026-09-07",
  );
  // 根目录带尾斜杠 / 用户名带空格都与上面等价
  assert.equal(
    storage.remoteDirectoryFor("周报/", { username: " zhang san ", periodStart: "2026-09-01", periodEnd: "2026-09-07" }),
    "/周报/zhang san/2026-09-01_2026-09-07",
  );
  // 路径分隔符与控制字符被清掉，空段兜底 unnamed
  assert.equal(storage.safeSegment("../etc"), "etc");
  assert.equal(storage.safeSegment("   "), "unnamed");

  assert.equal(storage.candidateFileName("第八周周报.docx", 1, 0), "第八周周报.docx");
  assert.equal(storage.candidateFileName("第八周周报.docx", 1, 1), "第八周周报_2.docx");
  assert.equal(storage.candidateFileName("第八周周报.docx", 2, 0), "第八周周报_v2.docx");
  assert.equal(storage.candidateFileName("第八周周报.docx", 2, 3), "第八周周报_v2_4.docx");
  // 没有扩展名的文件也要能过
  assert.equal(storage.candidateFileName("周报", 1, 1), "周报_2");

  const stored = storage.toRemoteStoredName("/周报/zhangsan/2026-09-01_2026-09-07/第八周周报.docx");
  assert.equal(stored, "webdav:/周报/zhangsan/2026-09-01_2026-09-07/第八周周报.docx");
  assert.equal(storage.isRemoteStoredName(stored), true);
  assert.equal(storage.isRemoteStoredName("v1.docx"), false, "老式记录的本地文件名不带前缀");
  assert.equal(storage.remotePathOf(stored), "/周报/zhangsan/2026-09-01_2026-09-07/第八周周报.docx");
});

/* ------------------------------------------------------------------ 上传与下载 */

test("上传：落点按「用户名/周期」，撞名递增、重传带版本后缀，且远端从不被覆盖", async () => {
  const base = { username: "zhangsan", periodStart: "2026-09-01", periodEnd: "2026-09-07", contentType: "application/msword" };

  const first = await storage.uploadReportFile({ ...base, originalName: "第八周周报.docx", version: 1, buffer: Buffer.from("第一版") });
  assert.equal(first.remotePath, "/周报/zhangsan/2026-09-01_2026-09-07/第八周周报.docx");
  assert.equal(first.storedName, "webdav:/周报/zhangsan/2026-09-01_2026-09-07/第八周周报.docx");
  assert.equal(first.size, Buffer.byteLength("第一版"));
  assert.equal(server.content("周报/zhangsan/2026-09-01_2026-09-07/第八周周报.docx"), "第一版");

  // 同期同人再新建一份同名文件：加 _2，不覆盖上一份
  const second = await storage.uploadReportFile({ ...base, originalName: "第八周周报.docx", version: 1, buffer: Buffer.from("第二版") });
  assert.equal(second.remotePath, "/周报/zhangsan/2026-09-01_2026-09-07/第八周周报_2.docx");
  assert.equal(server.content("周报/zhangsan/2026-09-01_2026-09-07/第八周周报.docx"), "第一版", "绝不能被覆盖");

  // 退回后重传（库里 version = 2）：加 _v2
  const third = await storage.uploadReportFile({ ...base, originalName: "第八周周报.docx", version: 2, buffer: Buffer.from("重传") });
  assert.equal(third.remotePath, "/周报/zhangsan/2026-09-01_2026-09-07/第八周周报_v2.docx");
});

test("下载：从远端流式读，远端没有则返回 null", async () => {
  const opened = await storage.openReportDownload("webdav:/周报/zhangsan/2026-09-01_2026-09-07/第八周周报.docx");
  assert.ok(opened, "远端存在时应拿到流");
  assert.equal(await new Response(opened.body).text(), "第一版");
  assert.equal(opened.size, Buffer.byteLength("第一版"));

  assert.equal(await storage.openReportDownload("webdav:/周报/zhangsan/2026-09-01_2026-09-07/没有这个.docx"), null);
});

test("未配置统一账号时上传与下载都报 503（文案指向管理员，而不是让成员去改设置）", async () => {
  settings.clearReportUploadSettings();
  try {
    const error = await storage
      .uploadReportFile({
        username: "zhangsan",
        periodStart: "2026-09-01",
        periodEnd: "2026-09-07",
        originalName: "x.docx",
        version: 1,
        buffer: Buffer.from("x"),
      })
      .then(() => null)
      .catch((reason: unknown) => reason);
    assert.ok(error instanceof storage.ReportStorageError);
    assert.equal(error.code, "WEBDAV_DISABLED");
    assert.equal(error.status, 503);
    assert.match(error.message, /联系管理员/u);
    assert.equal(storage.reportStorageStatus(error), 503);
  } finally {
    settings.saveReportUploadSettings(USER_ID, { username: "", password: "", root: "/周报", timeoutMs: 15000 });
  }
});

/* ------------------------------------------------------------------ 存量搬迁 CLI */

/** 把老式记录改回本地文件名，模拟「上次远端传成功但数据库没回写」 */
function resetStoredNameToLegacy(): void {
  const db = new SQLiteDatabase(databasePath);
  db.prepare("UPDATE report_files SET stored_name='v1.docx' WHERE id=?").run(FILE_ID);
  db.close();
}

test("搬迁 CLI：--dry-run 不动数据，正式跑幂等，--purge 才清本地", async () => {
  const remotePath = "周报/zhangsan/2026-08-01_2026-08-07/第八周周报.docx";
  const legacyPath = path.join(uploadsDir, REPORT_ID, "v1.docx");
  assert.equal(fs.existsSync(legacyPath), true, "前置：老式正文在本地");

  const dry = await runMigrate(["--dry-run"]);
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.output, /\[计划\]/u);
  assert.equal(server.node(remotePath), undefined, "dry-run 不该写 NAS");
  assert.equal(fs.existsSync(legacyPath), true);

  const first = await runMigrate([]);
  assert.equal(first.status, 0, first.output);
  assert.match(first.output, /\[完成\]/u);
  assert.equal(server.content(remotePath), "老版正文");
  assert.equal(fs.existsSync(legacyPath), true, "默认不删本地正文");

  const beforeAdopt = server.putCount();
  resetStoredNameToLegacy();
  const adopted = await runMigrate([]);
  assert.equal(adopted.status, 0, adopted.output);
  assert.match(adopted.output, /\[认领\]/u, "远端已有且大小一致时应认领，而不是再传一份 _2");
  assert.equal(server.putCount(), beforeAdopt, "认领不该产生新的上传");
  assert.equal(server.node("周报/zhangsan/2026-08-01_2026-08-07/第八周周报_2.docx"), undefined);

  const putCountBeforeRerun = server.putCount();
  const second = await runMigrate([]);
  assert.equal(second.status, 0, second.output);
  assert.equal(server.putCount(), putCountBeforeRerun, "第二次跑应全部跳过（stored_name 已有前缀）");

  const purged = await runMigrate(["--purge"]);
  assert.equal(purged.status, 0, purged.output);
  assert.equal(fs.existsSync(legacyPath), false, "--purge 才删本地正文");
  assert.equal(fs.existsSync(path.join(uploadsDir, REPORT_ID)), false, "空目录也一起清理");
  assert.equal(server.content(remotePath), "老版正文", "远端文件不受 purge 影响");
});

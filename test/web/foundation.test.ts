import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../server/src/config/env";
import { createDatabaseClient } from "../../server/src/db/client";
import { buildApp } from "../../server/src/app";
import { assertSupportedNodeRuntime } from "../../server/src/runtime";

test("配置使用本地安全默认值", () => {
  const config = loadConfig({}, "C:/workspace");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 17500);
  assert.equal(config.databasePath, path.resolve("C:/workspace", "data/workbench.sqlite"));
});

test("配置解析 HOST、PORT 与数据库路径", () => {
  const config = loadConfig({ HOST: "0.0.0.0", PORT: "18100", DATABASE_PATH: "tmp/test.sqlite" }, "C:/workspace");
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 18100);
  assert.equal(config.databasePath, path.resolve("C:/workspace", "tmp/test.sqlite"));
});

test("正式运行时拒绝 Node 20 并接受 Node 22.5 以上", () => {
  assert.throws(() => assertSupportedNodeRuntime("20.20.2"), /Node\.js >=22\.5\.0/u);
  assert.doesNotThrow(() => assertSupportedNodeRuntime("22.5.0"));
  assert.doesNotThrow(() => assertSupportedNodeRuntime("22.22.2"));
});

test("SQLite client 可对临时数据库执行健康检查", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workbench-web-db-"));
  const databasePath = path.join(dir, "health.sqlite");
  const client = createDatabaseClient({ databasePath, readOnly: false });
  t.after(async () => {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  });
  const health = await client.healthCheck();
  assert.deepEqual(health, { available: true, driver: "node:sqlite" });
});

test("基础 API 返回统一成功响应", async (t) => {
  const config = loadConfig({ NODE_ENV: "test", DATABASE_PATH: "missing.sqlite" }, process.cwd());
  const app = await buildApp({ config, enableDatabase: false });
  t.after(async () => app.close());
  const ping = await app.inject({ method: "GET", url: "/api/ping" });
  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(ping.statusCode, 200);
  assert.equal(health.statusCode, 200);
  assert.equal(ping.json().ok, true);
  assert.equal(health.json().ok, true);
});

test("未知 API 返回统一错误响应", async (t) => {
  const config = loadConfig({ NODE_ENV: "test", DATABASE_PATH: "missing.sqlite" }, process.cwd());
  const app = await buildApp({ config, enableDatabase: false });
  t.after(async () => app.close());
  const response = await app.inject({ method: "GET", url: "/api/not-found" });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { ok: false, error: { code: "NOT_FOUND", message: "接口不存在" } });
});

test("生产服务只对页面路径执行 SPA 回退", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-web-dist-"));
  const assets = path.join(directory, "assets");
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(directory, "index.html"), "<!doctype html><html><body>workbench</body></html>");
  await writeFile(path.join(assets, "entry.js"), "console.log('ok');");
  await writeFile(path.join(assets, "entry.css"), "body{color:black}");
  const config = loadConfig({ NODE_ENV: "production", WEB_DIST_PATH: directory, DATABASE_PATH: "missing.sqlite" }, process.cwd());
  const app = await buildApp({ config, enableDatabase: false });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const home = await app.inject({ method: "GET", url: "/" });
  const page = await app.inject({ method: "GET", url: "/tasks" });
  const script = await app.inject({ method: "GET", url: "/assets/entry.js" });
  const stylesheet = await app.inject({ method: "GET", url: "/assets/entry.css" });
  const missingAsset = await app.inject({ method: "GET", url: "/assets/missing.js" });
  const missingFile = await app.inject({ method: "GET", url: "/favicon.ico" });

  assert.equal(home.statusCode, 200);
  assert.match(home.body, /workbench/u);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /workbench/u);
  assert.equal(script.statusCode, 200);
  assert.match(String(script.headers["content-type"]), /javascript/u);
  assert.equal(script.body, "console.log('ok');");
  assert.equal(stylesheet.statusCode, 200);
  assert.match(String(stylesheet.headers["content-type"]), /text\/css/u);
  assert.equal(stylesheet.body, "body{color:black}");
  assert.equal(missingAsset.statusCode, 404);
  assert.deepEqual(missingAsset.json(), { ok: false, error: { code: "NOT_FOUND", message: "页面不存在" } });
  assert.equal(missingFile.statusCode, 404);
  assert.deepEqual(missingFile.json(), { ok: false, error: { code: "NOT_FOUND", message: "页面不存在" } });
});

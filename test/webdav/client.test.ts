import assert from "node:assert/strict";
import test from "node:test";
import { WebDavClient, WebDavError, parsePropfind, splitRemotePath } from "../../server/src/webdav/client";
import { FAKE_WEBDAV_STAMP, startFakeWebDav } from "../../tools/webdav/fake-server";

/**
 * WebDAV 客户端的单元测试：用一个**本地假 WebDAV 服务器**（node:http，内存目录树）验证
 * PROPFIND 解析、路径越界防护、上传补建目录、条件上传、流式下载、认证失败与不可达的区分。
 * 这样不需要真的 NAS 也能把协议层测到位（见 docs/harness/WEBDAV.md）。
 *
 * 假服务器本身在 `tools/webdav/fake-server.ts`：契约与冒烟环境里的「NAS」用的是同一个实现，
 * 免得两处对远端行为的假设各写一套。
 */

/* ------------------------------------------------------------------ 路径防护（纯函数） */

test("splitRemotePath 只接受可安全拼接的相对路径", () => {
  assert.deepEqual(splitRemotePath("a/b//c.txt"), ["a", "b", "c.txt"]);
  assert.deepEqual(splitRemotePath(" 报价 / 2026 模板.xlsx "), ["%E6%8A%A5%E4%BB%B7", "2026%20%E6%A8%A1%E6%9D%BF.xlsx"]);
  assert.deepEqual(splitRemotePath("/"), []);
  for (const bad of ["../etc/passwd", "a/../../b", "..", "https://evil.test/x", "a\\b", "a?x=1", "a#frag"]) {
    assert.throws(() => splitRemotePath(bad), WebDavError, `应拒绝 ${bad}`);
  }
});

test("parsePropfind 跳过 404 的 propstat 块并识别集合", () => {
  const xml = `<D:multistatus xmlns:D="DAV:">
    <D:response><D:href>/dav/%E6%8A%A5%E4%BB%B7/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
    <D:response><D:href>/dav/gone.txt</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response>
  </D:multistatus>`;
  const parsed = parsePropfind(xml);
  assert.equal(parsed.length, 1, "404 的块应被跳过");
  assert.equal(parsed[0]?.href, "dav/报价");
  assert.equal(parsed[0]?.entry.isDirectory, true);
});

/* ------------------------------------------------------------------ 列目录 */

test("list 解析元信息、剔除自身、目录在前，并处理中文与空格", async (t) => {
  const server = await startFakeWebDav();
  t.after(() => server.close());
  const client = new WebDavClient({ baseUrl: server.baseUrl });

  // 直接用假服务器的内存树构造数据：root 下 2 个目录 + 2 个文件
  server.requests.length = 0;
  const seed = new WebDavClient({ baseUrl: server.baseUrl });
  await seed.upload("报价 2026/模板.xlsx", new Blob(["hello"]));
  await seed.upload("readme.txt", new Blob(["abc"]));

  const entries = await client.list("");
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.isDirectory]),
    [
      ["报价 2026", true],
      ["readme.txt", false],
    ],
  );
  const file = entries.find((entry) => entry.name === "readme.txt");
  assert.equal(file?.size, 3);
  assert.equal(file?.lastModified, new Date(FAKE_WEBDAV_STAMP).toISOString());
  assert.equal(file?.path, "readme.txt");
});

test("list 只返回 basePath 之内的条目，越界的 href 被丢弃", async (t) => {
  const server = await startFakeWebDav();
  t.after(() => server.close());
  const seed = new WebDavClient({ baseUrl: server.baseUrl });
  await seed.upload("workbench/a.txt", new Blob(["a"]));
  server.injectOutsideHref("/dav/secret/leak.txt");

  const client = new WebDavClient({ baseUrl: server.baseUrl, basePath: "workbench" });
  const entries = await client.list("");
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ["a.txt"],
  );
  const sub = await client.list("nested");
  assert.deepEqual(sub, [], "不存在的目录返回 404 → 空列表");
});

/* ------------------------------------------------------------------ 元信息与探针 */

test("stat 不存在时返回 null，statMany 单条失败不影响其他条目", async (t) => {
  const server = await startFakeWebDav();
  t.after(() => server.close());
  const client = new WebDavClient({ baseUrl: server.baseUrl });
  await client.upload("a.txt", new Blob(["abc"]));

  assert.equal((await client.stat("a.txt"))?.size, 3);
  assert.equal(await client.stat("nope.txt"), null);

  const stats = await client.statMany(["a.txt", "nope.txt"]);
  assert.equal(stats.get("a.txt")?.size, 3);
  assert.equal(stats.get("nope.txt"), null);
});

test("ping 把认证失败与远端不可达分开报", async (t) => {
  const server = await startFakeWebDav({ auth: { username: "u", password: "p" } });
  t.after(() => server.close());

  const wrong = new WebDavClient({ baseUrl: server.baseUrl, username: "u", password: "nope" });
  await assert.rejects(
    () => wrong.ping(),
    (error: unknown) => error instanceof WebDavError && error.status === 401,
  );

  const right = new WebDavClient({ baseUrl: server.baseUrl, username: "u", password: "p" });
  await right.ping();

  const dead = new WebDavClient({ baseUrl: "http://127.0.0.1:1/dav", timeoutMs: 1500 });
  await assert.rejects(
    () => dead.ping(),
    (error: unknown) => error instanceof WebDavError && error.unreachable,
  );
});

/* ------------------------------------------------------------------ 上传 */

test("upload 自动补建父目录（先 MKCOL 再 PUT）且内容一致", async (t) => {
  const server = await startFakeWebDav();
  t.after(() => server.close());
  const client = new WebDavClient({ baseUrl: server.baseUrl });
  server.requests.length = 0;

  await client.upload("报表/2026/九月.xlsx", new Blob(["内容"]));
  assert.deepEqual(server.requests, [
    "PROPFIND /dav/%E6%8A%A5%E8%A1%A8",
    "MKCOL /dav/%E6%8A%A5%E8%A1%A8",
    "PROPFIND /dav/%E6%8A%A5%E8%A1%A8/2026",
    "MKCOL /dav/%E6%8A%A5%E8%A1%A8/2026",
    "PUT /dav/%E6%8A%A5%E8%A1%A8/2026/%E4%B9%9D%E6%9C%88.xlsx",
  ]);
  assert.equal(server.content("报表/2026/九月.xlsx"), "内容");
  assert.equal(server.node("报表")?.isDirectory, true);
});

test("upload 同名覆盖，且已存在的父目录不会重复 MKCOL", async (t) => {
  const server = await startFakeWebDav();
  t.after(() => server.close());
  const client = new WebDavClient({ baseUrl: server.baseUrl });
  await client.upload("dir/a.txt", new Blob(["v1"]));
  server.requests.length = 0;
  await client.upload("dir/a.txt", new Blob(["v2"]));
  assert.equal(server.requests.filter((entry) => entry.startsWith("MKCOL")).length, 0);
  assert.equal(server.content("dir/a.txt"), "v2");
});

test("upload 拒绝越界路径，且不会把请求打到远端", async (t) => {
  const server = await startFakeWebDav();
  t.after(() => server.close());
  const client = new WebDavClient({ baseUrl: server.baseUrl });
  server.requests.length = 0;
  for (const bad of ["../evil.txt", "a/../../b", "evil\\win.txt", "https://evil.test/x.txt"]) {
    await assert.rejects(() => client.upload(bad, new Blob(["x"])), WebDavError, `应拒绝 ${bad}`);
  }
  assert.deepEqual(server.requests, [], "非法路径必须在发请求之前就被拦下");
});

/* ------------------------------------------------------------------ 条件上传（不覆盖） */

test("uploadIfAbsent 写入成功返回 true，同名已存在返回 false 且内容不被覆盖", async (t) => {
  const server = await startFakeWebDav();
  t.after(() => server.close());
  const client = new WebDavClient({ baseUrl: server.baseUrl });

  assert.equal(await client.uploadIfAbsent("周报/张三/x.docx", new Blob(["第一版"])), true);
  assert.equal(server.content("周报/张三/x.docx"), "第一版");

  assert.equal(await client.uploadIfAbsent("周报/张三/x.docx", new Blob(["第二版"])), false);
  assert.equal(server.content("周报/张三/x.docx"), "第一版", "条件上传绝不能覆盖已有文件");
});

test("uploadIfAbsent 对忽略 If-None-Match 的服务端仍会覆盖（所以调用方必须先 stat）", async (t) => {
  const server = await startFakeWebDav({ honorIfNoneMatch: false });
  t.after(() => server.close());
  const client = new WebDavClient({ baseUrl: server.baseUrl });
  await client.upload("a.txt", new Blob(["旧"]));
  // 服务端不认条件头：PUT 照样写进去 —— 客户端只能靠「写之前先 stat」自保
  assert.equal(await client.uploadIfAbsent("a.txt", new Blob(["新"])), true);
  assert.equal(server.content("a.txt"), "新");
});

/* ------------------------------------------------------------------ 下载（流式） */

test("open 流式返回内容与长度，404 返回 null", async (t) => {
  const server = await startFakeWebDav();
  t.after(() => server.close());
  const client = new WebDavClient({ baseUrl: server.baseUrl });
  await client.upload("周报/李四/2026-09-01_2026-09-07/第八周周报.docx", new Blob(["周报正文"]));

  const opened = await client.open("周报/李四/2026-09-01_2026-09-07/第八周周报.docx");
  assert.ok(opened?.body, "应拿到响应体");
  const text = await new Response(opened.body).text();
  assert.equal(text, "周报正文");
  assert.equal(opened.size, Buffer.byteLength("周报正文"));
  assert.equal(opened.contentType, "application/octet-stream");

  assert.equal(await client.open("周报/李四/没有这个文件.docx"), null, "远端没有这个文件时返回 null");
});

test("open 拒绝越界路径与空路径", async (t) => {
  const server = await startFakeWebDav();
  t.after(() => server.close());
  const client = new WebDavClient({ baseUrl: server.baseUrl });
  server.reset();
  await assert.rejects(() => client.open("../evil.txt"), WebDavError);
  await assert.rejects(() => client.open(""), WebDavError);
  assert.deepEqual(server.requests, [], "非法路径必须在发请求之前就被拦下");
});

import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * 假 WebDAV 服务器（node:http + 内存目录树），三处共用：
 * - `test/webdav/client.test.ts`：协议层单测（PROPFIND / MKCOL / PUT / GET / 条件请求）；
 * - `tools/contract/runner.ts`：契约与 SSR 冒烟环境里的「NAS」——上传类用例落远端之后，
 *   没有远端可写的环境会整体 503（见 docs/harness/REPORTS_WEBDAV.md §10 方案 A）；
 * - 迁移脚本的验收脚本：验证「本地 → 远端」的搬迁幂等与认领逻辑。
 *
 * 支持的方法与真实 NAS 需要的最小集对齐：
 *
 * | 方法     | 行为                                                                 |
 * | -------- | -------------------------------------------------------------------- |
 * | PROPFIND | Depth 0/1，返回 207 + 手写 XML（含中文、空格的百分号编码）           |
 * | MKCOL    | 父目录不存在 → 409；已存在 → 405（与多数实现一致）                   |
 * | PUT      | 父目录不存在 → 409；带 `If-None-Match: *` 且已存在 → 412（可关掉）   |
 * | GET      | 200 + content-length + application/octet-stream；目录或不存在的 → 404 |
 *
 * `honorIfNoneMatch: false` 用来模拟「忽略条件头」的服务端：此时 PUT 照样覆盖，
 * 客户端只能靠上传前的 `stat` 探测自保——这正是 `uploadReportFile` 先探测再写的原因。
 */

export type FakeWebDavNode = { isDirectory: boolean; content: Buffer; lastModified: string };

export type FakeWebDavServer = {
  /** 形如 `http://127.0.0.1:PORT/dav`：直接当 `WEBDAV_URL` 用 */
  baseUrl: string;
  close: () => Promise<void>;
  /** 取内存树里的节点；不存在返回 undefined */
  node: (path: string) => FakeWebDavNode | undefined;
  /** 取文件内容（UTF-8）；不存在返回空串 */
  content: (path: string) => string;
  /** 收到的请求流水，形如 `PUT /dav/%E5%91%A8%E6%8A%A5/x.docx` */
  requests: string[];
  /** 让 Depth:1 响应里额外塞一个越出 basePath 的 href，用于验证客户端会丢弃它 */
  injectOutsideHref: (href: string) => void;
  /** 已经成功写入的次数（PUT 计数），用于断言「没有重复上传」 */
  putCount: () => number;
  /** 清空请求流水与 PUT 计数 */
  reset: () => void;
};

/** 所有节点共用的固定修改时间：测试要断言它，所以导出 */
export const FAKE_WEBDAV_STAMP = "Mon, 01 Sep 2026 10:00:00 GMT";

const STAMP = FAKE_WEBDAV_STAMP;

function xmlEscape(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export async function startFakeWebDav(
  options: { auth?: { username: string; password: string }; mount?: string; honorIfNoneMatch?: boolean } = {},
): Promise<FakeWebDavServer> {
  const mount = options.mount ?? "/dav";
  const honorIfNoneMatch = options.honorIfNoneMatch ?? true;
  const nodes = new Map<string, FakeWebDavNode>();
  nodes.set("", { isDirectory: true, content: Buffer.alloc(0), lastModified: STAMP });
  const requests: string[] = [];
  let outsideHref: string | null = null;
  let puts = 0;

  const normalize = (url: string): string => {
    const pathname = decodeURIComponent((url.split("?")[0] ?? "").replace(new RegExp(`^${mount}`), ""));
    return pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .join("/");
  };
  const children = (path: string): string[] =>
    [...nodes.keys()].filter((key) => {
      if (key === "" || key === path) return false;
      if (path === "") return !key.includes("/");
      return key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/");
    });

  const response = (path: string): string => {
    const node = nodes.get(path) as FakeWebDavNode;
    const encoded = encodePath(path);
    // 根目录的 href 是 `/dav/`；子目录按多数实现习惯补尾斜杠（客户端必须能处理这两种写法）
    const href = encoded ? `${mount}/${encoded}${node.isDirectory ? "/" : ""}` : `${mount}/`;
    return [
      "<D:response>",
      `<D:href>${xmlEscape(href)}</D:href>`,
      "<D:propstat><D:prop>",
      node.isDirectory ? "<D:resourcetype><D:collection/></D:resourcetype>" : "<D:resourcetype/>",
      node.isDirectory ? "" : `<D:getcontentlength>${node.content.length}</D:getcontentlength>`,
      `<D:getlastmodified>${node.lastModified}</D:getlastmodified>`,
      "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>",
      "</D:response>",
    ].join("");
  };

  const server = http.createServer((request, reply) => {
    const url = request.url ?? "/";
    requests.push(`${request.method ?? "GET"} ${url}`);
    if (options.auth) {
      const expected = `Basic ${Buffer.from(`${options.auth.username}:${options.auth.password}`).toString("base64")}`;
      if (request.headers.authorization !== expected) {
        reply.writeHead(401).end();
        return;
      }
    }
    if (!url.startsWith(mount)) {
      reply.writeHead(404).end();
      return;
    }
    const path = normalize(url);
    const node = nodes.get(path);

    if (request.method === "PROPFIND") {
      if (!node) {
        reply.writeHead(404).end();
        return;
      }
      const depth = String(request.headers.depth ?? "0");
      const body = [response(path), ...(depth === "1" ? children(path).map((child) => response(child)) : [])];
      if (depth === "1" && outsideHref) {
        body.push(
          `<D:response><D:href>${xmlEscape(outsideHref)}</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>3</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
        );
      }
      reply.writeHead(207, { "content-type": "application/xml; charset=utf-8" });
      reply.end(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${body.join("")}</D:multistatus>`);
      return;
    }

    if (request.method === "MKCOL") {
      if (node) {
        reply.writeHead(405).end();
        return;
      }
      const parent = path.split("/").slice(0, -1).join("/");
      if (!nodes.has(parent)) {
        reply.writeHead(409).end();
        return;
      }
      nodes.set(path, { isDirectory: true, content: Buffer.alloc(0), lastModified: STAMP });
      reply.writeHead(201).end();
      return;
    }

    if (request.method === "PUT") {
      const parent = path.split("/").slice(0, -1).join("/");
      if (!nodes.has(parent)) {
        reply.writeHead(409).end();
        return;
      }
      if (honorIfNoneMatch && node && request.headers["if-none-match"] === "*") {
        reply.writeHead(412).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        nodes.set(path, { isDirectory: false, content: Buffer.concat(chunks), lastModified: STAMP });
        puts += 1;
        reply.writeHead(node ? 204 : 201).end();
      });
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      if (!node || node.isDirectory) {
        reply.writeHead(404).end();
        return;
      }
      reply.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(node.content.length) });
      reply.end(request.method === "HEAD" ? undefined : node.content);
      return;
    }

    reply.writeHead(405).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}${mount}`,
    requests,
    node: (path) => nodes.get(path),
    content: (path) => nodes.get(path)?.content.toString("utf8") ?? "",
    injectOutsideHref: (href) => {
      outsideHref = href;
    },
    putCount: () => puts,
    reset: () => {
      requests.length = 0;
      puts = 0;
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

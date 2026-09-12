import fs from "node:fs";
import path from "node:path";
import { startFakeWebDav } from "../webdav/fake-server";
import { CASES } from "./cases";
import { createFixture, removeFixture } from "./fixture";
import { findFreePort, runCases, startServer, type GoldenFile } from "./runner";

/**
 * 录制契约 baseline（golden）。
 *
 * Phase 4 之后只有一套实现（React Router 8 单进程），默认用 `npm run serve` 拉起
 * ——注意 `build/server/index.js` 只导出请求处理器、不监听端口，必须由 react-router-serve 起。
 * `--entry` 只在需要跑别的入口时使用（例如复现某个历史实现）。
 *
 * 周报正文自 D-46 起只写 NAS，所以这里先起一个**本地假 WebDAV**并把地址通过 `WEBDAV_URL`
 * 注入被测服务（`tools/webdav/fake-server.ts`）——契约因此仍覆盖真实的上传/下载链路。
 */
const DEFAULT_SERVE_NPM = "serve";
const DEFAULT_OUT = "test/contract/golden/contract.golden.json";

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const entry = argValue("--entry", "");
  const serveNpm = argValue("--serve-npm", entry ? "" : DEFAULT_SERVE_NPM);
  const outFile = path.resolve(process.cwd(), argValue("--out", DEFAULT_OUT));
  const fixture = createFixture();
  const webdav = await startFakeWebDav();
  const port = await findFreePort();
  const server = await startServer({ entry, serveNpm, fixture, port, webdavUrl: webdav.baseUrl });
  try {
    const responses = await runCases({ baseUrl: `http://127.0.0.1:${port}`, fixture, port, cases: CASES });
    const golden: GoldenFile = {
      meta: {
        generatedAt: new Date().toISOString(),
        entry: entry || `npm run ${serveNpm}`,
        node: process.versions.node,
        caseCount: responses.length,
      },
      responses,
    };
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify(golden, null, 2)}\n`, "utf8");

    const byStatus = new Map<number, number>();
    for (const item of responses) byStatus.set(item.status, (byStatus.get(item.status) ?? 0) + 1);
    const statusSummary = [...byStatus.entries()]
      .toSorted((a, b) => a[0] - b[0])
      .map(([code, count]) => `${code}×${count}`)
      .join("  ");
    console.log(`已录制 ${responses.length} 条契约响应 → ${path.relative(process.cwd(), outFile)}`);
    console.log(`状态码分布：${statusSummary}`);
  } finally {
    await server.stop();
    await webdav.close();
    removeFixture(fixture);
  }
}

void main();

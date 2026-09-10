import fs from "node:fs";
import path from "node:path";
import { CASES } from "./cases";
import { createFixture, removeFixture } from "./fixture";
import { findFreePort, runCases, startServer, type GoldenFile } from "./runner";

const DEFAULT_ENTRY = "server/src/index.ts";
const DEFAULT_OUT = "test/contract/golden/contract.golden.json";

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const entry = argValue("--entry", DEFAULT_ENTRY);
  const outFile = path.resolve(process.cwd(), argValue("--out", DEFAULT_OUT));
  const fixture = createFixture();
  const port = await findFreePort();
  const server = await startServer({ entry, fixture, port });
  try {
    const responses = await runCases({ baseUrl: `http://127.0.0.1:${port}`, fixture, port, cases: CASES });
    const golden: GoldenFile = {
      meta: { generatedAt: new Date().toISOString(), entry, node: process.versions.node, caseCount: responses.length },
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
    removeFixture(fixture);
  }
}

void main();

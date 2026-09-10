import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CASES } from "./cases";
import { createFixture, removeFixture } from "./fixture";
import { findFreePort, runCases, startServer, type GoldenFile, type RecordedResponse } from "./runner";

const DEFAULT_SERVE_NPM = "serve";
const DEFAULT_GOLDEN = "test/contract/golden/contract.golden.json";

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function describe(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function diffResponse(expected: RecordedResponse, actual: RecordedResponse): string[] {
  const problems: string[] = [];
  if (expected.status !== actual.status) problems.push(`  status: 期望 ${expected.status}，实际 ${actual.status}`);
  const headerKeys = ["contentType", "contentDisposition", "setCookie", "hsts", "coop", "xContentTypeOptions"] as const;
  for (const key of headerKeys) {
    if (!isDeepStrictEqual(expected.headers[key], actual.headers[key])) {
      problems.push(`  headers.${key}: 期望 ${describe(expected.headers[key])}，实际 ${describe(actual.headers[key])}`);
    }
  }
  if (!isDeepStrictEqual(expected.headers.csp, actual.headers.csp)) {
    problems.push(`  headers.csp: 期望 ${describe(expected.headers.csp)}，实际 ${describe(actual.headers.csp)}`);
  }
  if (!isDeepStrictEqual(expected.body, actual.body)) {
    problems.push(`  body: 期望 ${describe(expected.body)}`);
    problems.push(`        实际 ${describe(actual.body)}`);
  }
  return problems;
}

async function main(): Promise<void> {
  const baseUrlArg = argValue("--base-url", "");
  // Phase 4 之后只剩一套实现：默认用 npm run serve 拉起它（--entry 仅用于特殊入口）
  const entry = argValue("--entry", "");
  const serveNpm = argValue("--serve-npm", baseUrlArg ? "" : DEFAULT_SERVE_NPM);
  const goldenFile = path.resolve(process.cwd(), argValue("--golden", DEFAULT_GOLDEN));
  /** 只比对指定前缀的用例（逗号分隔），便于按阶段分批验收 */
  const only = argValue("--only", "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!fs.existsSync(goldenFile)) throw new Error(`找不到 golden 文件：${goldenFile}（先跑 npm run contract:capture）`);
  const goldenAll = JSON.parse(fs.readFileSync(goldenFile, "utf8")) as GoldenFile;
  const golden: GoldenFile = only.length
    ? { meta: goldenAll.meta, responses: goldenAll.responses.filter((item) => only.some((prefix) => item.name.startsWith(prefix))) }
    : goldenAll;
  if (golden.responses.length === 0) throw new Error(`--only ${only.join(",")} 没有匹配到任何用例`);

  const fixture = createFixture();
  const port = baseUrlArg ? Number(new URL(baseUrlArg).port) : await findFreePort();
  const server = baseUrlArg
    ? null
    : serveNpm
      ? await startServer({ serveNpm, fixture, port })
      : await startServer({ entry, fixture, port });
  const baseUrl = baseUrlArg || `http://127.0.0.1:${port}`;
  try {
    const selectedNames = new Set(golden.responses.map((item) => item.name));
    const actual = await runCases({ baseUrl, fixture, port, cases: CASES.filter((item) => selectedNames.has(item.name)) });
    if (actual.length !== golden.responses.length) {
      throw new Error(`用例数量不一致：golden ${golden.responses.length} 条，本次 ${actual.length} 条（cases.ts 改过？需要重新 capture）`);
    }
    const failures: string[] = [];
    for (const [index, expected] of golden.responses.entries()) {
      const observed = actual[index];
      if (!observed || observed.name !== expected.name) {
        failures.push(`● ${expected.name}\n  用例顺序不一致（golden 第 ${index + 1} 条 vs 实际 ${observed?.name ?? "缺失"}）`);
        continue;
      }
      const problems = diffResponse(expected, observed);
      if (problems.length > 0) failures.push(`● ${expected.name}\n${problems.join("\n")}`);
    }
    console.log(`回放 ${actual.length} 条用例，对比 ${path.relative(process.cwd(), goldenFile)}`);
    if (failures.length === 0) {
      console.log("结果：全部一致 ✓");
      return;
    }
    console.log(`结果：${failures.length} 条不一致 ✗\n`);
    for (const failure of failures) console.log(failure);
    process.exitCode = 1;
  } finally {
    await server?.stop();
    removeFixture(fixture);
  }
}

void main();

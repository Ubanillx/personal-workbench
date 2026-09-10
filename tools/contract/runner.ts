import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import type { ContractCase, Role } from "./cases";
import { TOKENS, type Fixture } from "./fixture";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/gu;
const TOKEN_RE = /\b[0-9a-f]{32,64}\b/giu;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/gu;

export type RecordedResponse = {
  name: string;
  role: string;
  request: { method: string; path: string; body?: unknown; upload?: string };
  status: number;
  headers: {
    contentType: string | null;
    contentDisposition: string | null;
    setCookie: boolean;
    csp: { present: boolean; upgradeInsecureRequests: boolean };
    hsts: boolean;
    coop: boolean;
    xContentTypeOptions: boolean;
  };
  body: unknown;
};

export type GoldenFile = {
  meta: { generatedAt: string; entry: string; node: string; caseCount: number };
  responses: RecordedResponse[];
};

/** 易变值归一化：uuid / ISO 时间 / 令牌 / IP / 端口 —— 让 golden 与运行时刻、机器无关 */
export function normalizeValue(value: unknown, port: number): unknown {
  if (typeof value === "string") {
    return value
      .replace(UUID_RE, "<uuid>")
      .replace(ISO_RE, "<ts>")
      .replace(TOKEN_RE, "<token>")
      .replace(IPV4_RE, "<ip>")
      .replaceAll(`:${port}`, ":<port>");
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, port));
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = key === "port" ? "<port>" : normalizeValue(item, port);
    }
    return output;
  }
  return value;
}

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function startServer(options: { entry: string; fixture: Fixture; port: number }): Promise<{
  stop: () => Promise<void>;
  output: () => string;
}> {
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", options.entry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(options.port),
      DATABASE_PATH: options.fixture.databasePath,
      UPLOADS_DIR: options.fixture.uploadsDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (chunk: Buffer) => (log += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString("utf8")));

  const baseUrl = `http://127.0.0.1:${options.port}`;
  const deadline = Date.now() + 40_000;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // 还没起来，继续等
    }
  }
  if (!ready) {
    child.kill("SIGKILL");
    throw new Error(`${options.entry} 启动失败（40s 内未通过 /api/health）\n${log}`);
  }
  return {
    output: () => log,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (!exited) child.kill("SIGKILL");
    },
  };
}

function extractPath(value: unknown, dotted: string): string | undefined {
  let current: unknown = value;
  for (const key of dotted.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current === undefined || current === null ? undefined : String(current);
}

export async function runCases(options: {
  baseUrl: string;
  fixture: Fixture;
  port: number;
  cases: ContractCase[];
}): Promise<RecordedResponse[]> {
  const vars: Record<string, string> = { ...options.fixture.ids };
  const sessions = new Map<string, string>();
  const recorded: RecordedResponse[] = [];

  const login = async (role: Role): Promise<string> => {
    const response = await fetch(`${options.baseUrl}/api/auth/access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKENS[role] }),
    });
    const raw = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie") ?? "";
    const pair = raw.split(";")[0] ?? "";
    if (!pair.includes("=")) throw new Error(`角色 ${role} 登录失败：HTTP ${response.status}`);
    return pair;
  };
  const cookieFor = async (testCase: ContractCase): Promise<string | undefined> => {
    if (testCase.role === "anon") return undefined;
    if (testCase.freshLogin) return login(testCase.role);
    const cached = sessions.get(testCase.role);
    if (cached) return cached;
    const fresh = await login(testCase.role);
    sessions.set(testCase.role, fresh);
    return fresh;
  };

  for (const testCase of options.cases) {
    const path = testCase.path.replace(/\{\{(\w+)\}\}/gu, (_all, key: string) => {
      const value = vars[key];
      if (value === undefined) throw new Error(`用例 ${testCase.name} 引用了未定义变量 ${key}`);
      return value;
    });
    const cookie = await cookieFor(testCase);
    const headers: Record<string, string> = { accept: "application/json" };
    if (cookie) headers.cookie = cookie;

    let body: RequestInit["body"] | undefined;
    if (testCase.upload) {
      const form = new FormData();
      for (const [name, value] of Object.entries(testCase.upload.fields)) form.append(name, value);
      form.append("file", new Blob([testCase.upload.content]), testCase.upload.filename);
      body = form;
    } else if (testCase.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(testCase.body);
    }

    const init: RequestInit = { method: testCase.method, headers };
    if (body !== undefined) init.body = body;
    const response = await fetch(`${options.baseUrl}${path}`, init);
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // 非 JSON（例如文件下载）保留原文
    }
    if (testCase.capture) {
      for (const [key, dotted] of Object.entries(testCase.capture)) {
        const value = extractPath(parsed, dotted);
        if (value === undefined) throw new Error(`用例 ${testCase.name} 未能捕获变量 ${key}（${dotted}）`);
        vars[key] = value;
      }
    }
    const csp = response.headers.get("content-security-policy");
    recorded.push({
      name: testCase.name,
      role: testCase.role,
      request: {
        method: testCase.method,
        path,
        ...(testCase.body === undefined ? {} : { body: normalizeValue(testCase.body, options.port) }),
        ...(testCase.upload === undefined ? {} : { upload: testCase.upload.filename }),
      },
      status: response.status,
      headers: {
        contentType: response.headers.get("content-type"),
        contentDisposition: response.headers.get("content-disposition"),
        setCookie: Boolean(response.headers.get("set-cookie")),
        csp: { present: Boolean(csp), upgradeInsecureRequests: Boolean(csp?.includes("upgrade-insecure-requests")) },
        hsts: Boolean(response.headers.get("strict-transport-security")),
        coop: Boolean(response.headers.get("cross-origin-opener-policy")),
        xContentTypeOptions: Boolean(response.headers.get("x-content-type-options")),
      },
      body: normalizeValue(parsed, options.port),
    });
  }
  return recorded;
}

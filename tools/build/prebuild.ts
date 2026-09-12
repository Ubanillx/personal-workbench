import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * 构建前的「解锁」步骤：保证 `build/` 此刻可以被删除。
 *
 * 为什么需要它：`npm run build`（react-router build）的第一步就是清空构建目录 ——
 * `node_modules/@react-router/dev/dist/vite.js` 的 `buildApp()` 会先调
 * `cleanBuildDirectory()`，也就是 `rm(build, { recursive: true, force: true })`，
 * 而且它**外面没有 try/catch**。这一步一旦失败，构建就直接终止在**编译之前**：
 * 报出来的错跟真实代码问题无关，真正要看的编译错误根本没机会出现。
 *
 * 在 Windows 上这一步确实会失败 —— 只要有进程把 build/（或其子目录）当成工作目录、
 * 或以独占方式持有其中的文件，rm 就会抛 EBUSY/EPERM（实测：`process.chdir` 进 build/
 * 之后再删它必然失败）。最常见的来源是上一次 `npm run serve` / `npm start` /
 * `npm start:lan` 的进程没退干净：终端窗口关了，服务却还在后台跑。
 *
 * 本脚本挂在 `npm run build` 的最前面，职责只有一个：让构建目录可删除。
 *   1. 没有阻塞时什么都不做（直接成功返回，不改变框架原有行为）
 *   2. 能删就直接删（提前替框架完成同一步；删完目录为空，框架再删是空操作）
 *   3. 删不掉就找出真正的占用者（加载了本项目构建产物的 node 进程）并结束，然后重试
 *   4. 仍删不掉就打印可操作的手动指引，以非 0 退出
 *
 * 于是 `npm run build` / `npm start` / `npm start:lan` / `npm test`（pretest 会先 build）
 * 都不再需要人工清理 build/。
 *
 * 退出码：0 = 构建目录可删除（或本来就没阻塞）；1 = 无法解决，已给出指引。
 */

const BUILD_DIR = path.resolve(process.cwd(), "build");
const IS_WINDOWS = process.platform === "win32";
/** 项目根（归一成小写 + 正斜杠），用于识别「属于本项目的进程」 */
const PROJECT_DIR = normalize(process.cwd());
/** 进程结束后句柄不会立刻释放，这几次重试就是留给它的时间 */
const REMOVE_ATTEMPTS = 6;
const REMOVE_RETRY_DELAY_MS = 300;

type ProcessRow = { ProcessId?: number; CommandLine?: string | null };

function normalize(value: string): string {
  return value.replace(/\\/gu, "/").toLowerCase();
}

function tryRemoveBuildDir(): boolean {
  try {
    fs.rmSync(BUILD_DIR, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 判定某个 node 进程是否「正在占用本次构建」。
 *
 * 关键教训：**不能拿「命令行含项目路径」当判据** —— IDE 的 tsserver / eslint
 * 命令行里同样带项目路径，那会把编辑器进程一起杀掉。只认下面两种与**构建产物**
 * 强相关的形态，宁可不杀，绝不误伤。
 */
function isHoldingCommandLine(commandLine: string): boolean {
  const normalized = normalize(commandLine);
  // 形态一：命令行里出现本项目构建产物的绝对路径
  // （进程的工作目录落在 build/ 里、或以独占方式持有其中文件等情况）
  if (normalized.includes(`${PROJECT_DIR}/build/`)) return true;
  // 形态二：本项目的 react-router 服务加载了构建产物。
  // 这里必须靠 `build/server/index.js` 来认，而不能靠项目绝对路径：`npm run serve` 解析后
  // 子进程的命令行是**相对路径** ——
  //   "node.exe" node_modules/@react-router/serve/bin.cjs build/server/index.js
  // 按绝对路径匹配会直接漏判，漏判的后果就是构建再次卡死在删除那一步。
  // 代价：另一个 react-router 仓库若同时在跑 serve 也会被列进来（概率极低，重启即恢复），
  // 这是为了「不漏掉真正的 serve」而有意接受的风险。
  return normalized.includes("react-router") && normalized.includes("build/server/index.js");
}

function findHoldingProcesses(): Array<{ pid: number; commandLine: string }> {
  if (!IS_WINDOWS) return [];
  const script = [
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8;",
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |",
    "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
  ].join(" ");

  let parsed: unknown;
  try {
    const stdout = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    parsed = stdout.trim() === "" ? [] : JSON.parse(stdout);
  } catch {
    // 查询失败不致命：交给调用方走「未解决」分支给出手动指引
    return [];
  }

  // ConvertTo-Json 在只有一个结果时输出对象而非数组，这里统一成数组
  const rows: ProcessRow[] = Array.isArray(parsed) ? (parsed as ProcessRow[]) : [parsed as ProcessRow];
  const self = new Set([process.pid, process.ppid]);
  const found: Array<{ pid: number; commandLine: string }> = [];
  for (const row of rows) {
    const pid = row.ProcessId;
    if (typeof pid !== "number" || self.has(pid)) continue;
    const commandLine = row.CommandLine ?? "";
    if (!isHoldingCommandLine(commandLine)) continue;
    found.push({ pid, commandLine });
  }
  return found;
}

/** Windows 没有可靠的优雅退出信号，而 serve 是常驻进程，只能 /T /F 连子进程一起结束 */
function terminateProcessTree(pid: number): void {
  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  if (result.status !== 0) console.warn(`[build] 结束进程 PID ${pid} 失败（可能已自行退出）`);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function printManualHint(): void {
  console.error("[build] 无法清理 build/，请手动处理后重试：");
  console.error("[build]   1) 关掉正在运行 npm run serve / npm start / npm run dev 的终端窗口");
  console.error("[build]   2) 或找到并结束占用端口 17500 的进程：");
  console.error("[build]        netstat -ano | findstr :17500");
  console.error("[build]        taskkill /PID <上面最后一列的 PID> /T /F");
  console.error("[build]   3) 开发时优先 npm run dev（走内存编译，不必反复 build）");
}

async function main(): Promise<void> {
  if (!fs.existsSync(BUILD_DIR)) return;

  if (tryRemoveBuildDir()) return;

  if (!IS_WINDOWS) {
    console.error(`[build] ${BUILD_DIR} 被其它进程占用，无法删除。请先停掉 serve / dev 进程后重试。`);
    process.exitCode = 1;
    return;
  }

  const holders = findHoldingProcesses();
  if (holders.length === 0) {
    printManualHint();
    process.exitCode = 1;
    return;
  }

  console.log("[build] 构建目录被上次遗留的进程占用，先结束它们：");
  for (const holder of holders) {
    console.log(`[build]   PID ${holder.pid}  ${truncate(holder.commandLine, 120)}`);
    terminateProcessTree(holder.pid);
  }

  for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt += 1) {
    await delay(REMOVE_RETRY_DELAY_MS);
    if (tryRemoveBuildDir()) {
      console.log("[build] 构建目录已清空，继续构建。");
      return;
    }
  }

  printManualHint();
  process.exitCode = 1;
}

void main();

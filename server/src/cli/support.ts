import path from "node:path";
import { createInterface } from "node:readline";
import { loadDotEnv } from "../config/env";

/** 三个账号 CLI 共用的输入与路径处理 */

export function resolveDatabasePath(): string {
  // CLI 不经 appConfig()，这里单独兜一次 .env，保证 DATABASE_PATH 在两种入口下口径一致
  loadDotEnv();
  const fromEnv = process.env.DATABASE_PATH;
  return fromEnv ? path.resolve(fromEnv) : path.resolve(process.cwd(), "data/workbench.sqlite");
}

export function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

/** 取 `--name value` 形式的位置无关参数 */
export function argValue(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

/** 取第一个非 `--` 开头的裸参数（例如 `user:passwd -- <用户名>`） */
export function firstPositional(): string {
  const args = process.argv.slice(2);
  return args.find((arg) => !arg.startsWith("--")) ?? "";
}

export async function readLineFromStdin(): Promise<string> {
  const rl = createInterface({ input: process.stdin });
  const answer = await new Promise<string>((resolve) => rl.once("line", resolve));
  rl.close();
  return answer;
}

/** 隐藏输入的密码提示（TTY 下打成 `*`；Ctrl+C 取消） */
function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  return new Promise<string>((resolve, reject) => {
    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode(true);
    stdin.resume();
    let value = "";
    const finish = (): void => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          finish();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          finish();
          process.stdout.write("\n");
          reject(new Error("已取消"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (char >= " ") {
          value += char;
          process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * 取一个待设置的密码。四种来源，按优先级：
 *   1. `--generate` 由调用方处理（不进这里）
 *   2. 环境变量 `WORKBENCH_PASSWORD`：脚本里最可靠的方式
 *   3. `--password-stdin` 或 stdin 不是终端 → 从标准输入读一行
 *   4. 终端里交互式隐藏输入，要求输入两次
 *
 * 关于第 3 条的坑（实测）：Windows 上 `npm run` 会把 `--password-stdin` 当成 npm 自己的
 * 未知配置项吃掉并告警（`npm warn Unknown cli config`），所以**不能只依赖这个标志**；
 * 只要 stdin 不是 TTY 就自动按管道读，才在各种调用方式下都成立。
 */
export async function readNewPassword(): Promise<string> {
  const fromEnv = process.env.WORKBENCH_PASSWORD;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (hasFlag("--password-stdin") || !process.stdin.isTTY) {
    return (await readLineFromStdin()).trim();
  }
  const first = await promptHidden("新密码：");
  const second = await promptHidden("再输一次：");
  if (first !== second) throw new Error("两次输入不一致");
  return first;
}

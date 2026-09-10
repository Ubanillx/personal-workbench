import path from "node:path";
import { assertSupportedNodeRuntime } from "../runtime";

const args = new Set(process.argv.slice(2));

async function main(): Promise<void> {
  if (!args.has("--confirm")) {
    console.error("此操作会撤销全部主人令牌和主人会话。请执行：npm run owner:reset -- --confirm");
    process.exitCode = 1;
    return;
  }
  try {
    assertSupportedNodeRuntime();
    const { resetOwnerAccess } = await import("../security/owner-token.js");
    const result = await resetOwnerAccess({
      databasePath: path.resolve(process.cwd(), "data/workbench.sqlite"),
      backupDirectory: path.resolve(process.cwd(), "data/backups")
    });
    console.log(`已创建 SQLite 备份：${result.backupPath}`);
    console.log("新的主人访问令牌（仅在本终端显示一次，请立即安全保存）：");
    console.log(result.token);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "主人令牌重置失败");
    process.exitCode = 1;
  }
}

void main();

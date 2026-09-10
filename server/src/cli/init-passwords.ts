import { initMissingPasswords } from "../security/account";
import { hasFlag, resolveDatabasePath } from "./support";

/**
 * `npm run user:init -- --confirm` —— 迁移后的**一次性**初始化。
 *
 * 009 迁移不会给任何账号写密码（password_hash 是 `locked$` 占位值），首次登录前必须跑一次本命令：
 * 它会为所有仍是 locked 的账号生成随机初始密码并打印一次。
 * 幂等：已经设过密码的账号不会被改动，重复执行只会报告"无需初始化"。
 */
async function main(): Promise<void> {
  if (!hasFlag("--confirm")) {
    console.error("此命令会为所有尚未设置密码的账号生成初始密码。请执行：npm run user:init -- --confirm");
    process.exitCode = 1;
    return;
  }

  const databasePath = resolveDatabasePath();
  const issued = await initMissingPasswords(databasePath);

  console.log(`数据库：${databasePath}`);
  if (issued.length === 0) {
    console.log("所有账号都已设置过密码，无需初始化。");
    return;
  }

  const width = Math.max(...issued.map((item) => item.username.length), 8);
  console.log(`已为 ${issued.length} 个账号生成初始密码（只显示这一次，请立即保存）：\n`);
  console.log(`${"用户名".padEnd(width)}  ${"角色".padEnd(8)}  初始密码`);
  for (const item of issued) {
    console.log(`${item.username.padEnd(width)}  ${item.role.padEnd(8)}  ${item.password}`);
  }
  console.log("\n以上密码首次登录后必须修改；忘记密码只能用 npm run user:passwd 在本机重置。");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "初始化密码失败");
  process.exitCode = 1;
});

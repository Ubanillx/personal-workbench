import { AccountNotFoundError, setAccountPassword } from "../security/account";
import { generatePassword, MIN_PASSWORD_LENGTH } from "../security/password";
import { argValue, firstPositional, hasFlag, readNewPassword, resolveDatabasePath } from "./support";

/**
 * `npm run user:passwd -- <用户名>` —— 重置某个账号的密码（本机唯一的重置途径）。
 *
 *   npm run user:passwd -- selene                      # 交互式隐藏输入，输两次
 *   npm run user:passwd -- selene --generate           # 生成随机密码并打印（最省事）
 *   $env:WORKBENCH_PASSWORD="新密码"; npm run user:passwd -- selene
 *   echo 新密码 | npm run user:passwd -- selene         # stdin 不是终端时自动按管道读
 *   npm run user:passwd -- selene --generate --no-force-change   # 不要求对方下次登录改密
 *
 * 除 --no-force-change 外都会把该账号标记为「下次登录必须改密」。
 */
async function main(): Promise<void> {
  const username = firstPositional() || argValue("--username");
  if (!username) {
    console.error("用法：npm run user:passwd -- <用户名> [--generate | --password-stdin] [--no-force-change]");
    process.exitCode = 1;
    return;
  }

  const databasePath = resolveDatabasePath();
  const password = hasFlag("--generate") ? generatePassword() : await readNewPassword();
  const invalid = password.length < MIN_PASSWORD_LENGTH ? `密码至少 ${MIN_PASSWORD_LENGTH} 位` : null;
  if (invalid) throw new Error(invalid);

  await setAccountPassword({
    databasePath,
    username,
    password,
    mustChangePassword: !hasFlag("--no-force-change"),
  });

  console.log(`数据库：${databasePath}`);
  console.log(`已重置账号 ${username} 的密码${hasFlag("--no-force-change") ? "" : "（下次登录需改密）"}`);
  if (hasFlag("--generate")) {
    console.log("新密码（只显示这一次，请立即保存）：");
    console.log(password);
  }
}

void main().catch((error: unknown) => {
  if (error instanceof AccountNotFoundError) console.error(`${error.message}（用 npm run user:list 查看全部账号）`);
  else console.error(error instanceof Error ? error.message : "重置密码失败");
  process.exitCode = 1;
});

import { listAccounts } from "../security/account";
import { resolveDatabasePath } from "./support";

/**
 * `npm run user:list` —— 列出全部账号（用户名、邮箱、角色、组织、是否待改密）。
 * 不显示任何密码或哈希。
 */
function main(): void {
  const databasePath = resolveDatabasePath();
  const accounts = listAccounts(databasePath);
  console.log(`数据库：${databasePath}`);
  if (accounts.length === 0) {
    console.log("（没有任何账号）");
    return;
  }
  const width = (key: keyof (typeof accounts)[number]): number =>
    Math.max(...accounts.map((account) => String(account[key] ?? "").length), String(key).length);
  const w = {
    username: Math.max(width("username"), 8),
    name: Math.max(width("name"), 4),
    role: 8,
    org: Math.max(width("orgName"), 4),
    email: Math.max(width("email"), 5),
  };
  console.log(
    `${"用户名".padEnd(w.username)}  ${"姓名".padEnd(w.name)}  ${"角色".padEnd(w.role)}  ${"组织".padEnd(w.org)}  ${"邮箱".padEnd(w.email)}  状态`,
  );
  for (const account of accounts) {
    const state = [
      account.hasPassword ? "已设密码" : "**未设密码**",
      account.mustChangePassword ? "待改密" : "",
      account.isActive ? "" : "已停用",
    ]
      .filter(Boolean)
      .join(" / ");
    console.log(
      `${account.username.padEnd(w.username)}  ${account.name.padEnd(w.name)}  ${account.role.padEnd(w.role)}  ${(account.orgName ?? "-").padEnd(w.org)}  ${account.email.padEnd(w.email)}  ${state}`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "读取账号失败");
  process.exitCode = 1;
}

import { ACCOUNTS, createFixture, IDS, SEED_ACCOUNTS, SEED_ORGANIZATIONS } from "./fixture";

/**
 * 生成一个**保留不删**的夹具库，用于本地手工验收（浏览器打开新实现）：
 *   npx tsx tools/contract/make-fixture.ts
 * 输出的路径可直接用作 DATABASE_PATH，可用账号与组织见下面的清单
 * （账号定义在 tools/contract/fixture.ts 的 ACCOUNTS，登录用 POST /api/auth/login）。
 */
const fixture = createFixture();
console.log(`DATABASE_PATH=${fixture.databasePath}`);
console.log(`UPLOADS_DIR=${fixture.uploadsDir}`);
console.log("\n组织：");
for (const org of SEED_ORGANIZATIONS) {
  console.log(`  ${org.id.padEnd(13)} ${org.name}${org.status === "archived" ? "（已解散）" : ""}`);
}
console.log("\n账号（key / 用户名 / 密码 / 角色 / 组织 / 待改密）：");
for (const account of SEED_ACCOUNTS) {
  const credential = ACCOUNTS[account.key];
  const org = account.orgId ?? "（无组织）";
  console.log(
    `  ${account.key.padEnd(11)} ${credential.username.padEnd(13)} ${credential.password.padEnd(16)} ${account.role.padEnd(8)} ${org.padEnd(13)} ${account.mustChange === 1 ? "是" : "否"}`,
  );
}
console.log("\n提示：管理员无组织，创建任务/周报时要显式指定 orgId；no-org 用于申请入组；must-change 用于强制改密门禁。");
console.log(`提示：阿尔法组 = ${IDS.orgAlpha}，贝塔组 = ${IDS.orgBeta}，已解散组织 = ${IDS.orgArchived}。`);

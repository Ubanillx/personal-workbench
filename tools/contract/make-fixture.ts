import { createFixture } from "./fixture";

/**
 * 生成一个**保留不删**的夹具库，用于本地手工验收（浏览器打开新实现）：
 *   npx tsx tools/contract/make-fixture.ts
 * 输出的路径可直接用作 DATABASE_PATH，令牌见 tools/contract/fixture.ts 的 TOKENS。
 */
const fixture = createFixture();
console.log(`DATABASE_PATH=${fixture.databasePath}`);
console.log(`UPLOADS_DIR=${fixture.uploadsDir}`);
console.log("可用令牌：owner-token / assistant-a-token / assistant-b-token / viewer-token");

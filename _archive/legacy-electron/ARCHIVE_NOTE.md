# 归档说明：旧 Electron 工作台

归档日期：2026-09-10

这里是 `personal-workbench` 在 Electron 时代的遗留实现。2026-09-10 的清理把这些内容从项目根目录移入本目录，
**没有永久删除**。正式服务（Node + Fastify + TypeScript + SQLite + React）不依赖本目录中的任何文件。

## 归档内容

| 本目录路径 | 原位置 | 说明 |
| --- | --- | --- |
| `main.js`、`preload.js`、`desktop/` | 项目根 | Electron 主进程入口、preload 桥、窗口与 IPC 实现 |
| `renderer/` | 项目根 | Electron 桌面端界面（app.js / index.html / style.css） |
| `server/http-server.js` | 项目根 | 旧局域网 HTTP 服务与共享 API（仅被 Electron 与旧测试使用） |
| `repositories/json-repository.js` | 项目根 | 旧 JSON 持久化（`data/workbench.json`，含 5 份轮转备份） |
| `share/` | 项目根 | 旧助理/查看者浏览器页，仅由 `server/http-server.js` 托管 |
| `test/unit/repository.test.js`、`test/integration/http-api.test.js`、`test/helpers/harness.js` | `test/` | 针对旧 JSON + 旧 HTTP 链路的测试 |
| `start-workbench.bat` | 项目根 | 双击启动 `node_modules\electron\dist\electron.exe` |
| `fix-firewall.bat` | 项目根 | 旧 17500 防火墙规则，与 `scripts/allow-lan-firewall.ps1` 重复 |
| `scripts/` | `scripts/` | 旧运维与迁移脚本（见下表） |
| `WORKBENCH_REFACTOR_ANALYSIS.md`、`REFACTOR_AUDIT_REPORT.md`、`REFACTOR_HARNESS.md`、`BUG_LIST.md` | 项目根 | 描述旧 Electron 架构的重构过程文档 |
| `logs/` | 项目根 | 旧运行日志（app.log、app-error.log、formal-service*.log） |
| `data/` | `data/` | 旧 JSON 数据源与 JSON 备份（`workbench.json`、`workbench*.json.bak`） |

`scripts/` 归档明细：`start-lan.ps1`、`allow-lan-firewall.ps1`、`reset-owner-token.ps1`、
`dev.ts`、`backup-sqlite.ts`、`reset-owner-token.ts`、`migrate-json-to-sqlite.ts`、`verify-sqlite-migration.ts`。

## 第二批移除（同日，孤儿文件）

这些不在 Electron 集合内，但已无任何代码引用，经确认后一并移出项目：

| 本目录路径 | 原位置 | 说明 |
| --- | --- | --- |
| `data/workbench.stage4.sqlite` | `data/` | 阶段四 JSON→SQLite 迁移的验证库；迁移脚本已归档，无人再读 |
| `data/workbench.before-migration-2026-09-04T16-49-18-826Z.sqlite.bak` 等 3 个 | `data/` | 结构迁移前由 `server/src/db/client.ts` 自动生成的正式库快照 |
| `data/workbench.sqlite.before-web-1788511646943.bak` | `data/` | 切换到 Web 服务前的正式库快照 |
| `test/fixtures/templates/daily-order-plan-v1-draft.json` | `test/fixtures/templates/` | 周报模板字段草案，全仓库无引用（相关计划见本目录 `REFACTOR_HARNESS.md`） |

同时删除了项目根目录下完全为空的 `db/` 目录（无任何文件，无内容可归档）。

保留未动：`data/workbench.sqlite`（正式库）、`data/backups/`（正式备份目录，可用 `npm run db:backup` 继续追加）、
`data/uploads/reports/`（周报上传文件）。

## 连带移除的配置

- `package.json`：删除 `"main": "main.js"`、`start:electron`、`start:lan:managed`、`db:migrate`、`db:verify`、
  `data:migrate-json`、`data:migrate-json:dry`、`test:legacy`、`test:repo`；移除 `electron` 依赖（约 271MB）。
- `server/tsconfig.json`：`include` 去掉 `../scripts/**/*.ts`。
- `.env.example`：去掉 `MIGRATION_TARGET_PATH`、`JSON_SOURCE_PATH`、`SQLITE_BACKUP_DIR`（无代码读取）。

## 命令对应关系

| 旧命令 | 现在 |
| --- | --- |
| `npm run start:electron`、`start-workbench.bat` | 无（Electron 客户端已移除，改用浏览器访问正式服务） |
| `powershell -File scripts/start-lan.ps1`、`npm run start:lan:managed` | `npm run start:lan` |
| `powershell -File scripts/allow-lan-firewall.ps1` | README「局域网访问」中的 `New-NetFirewallRule` 单行命令 |
| `powershell -File scripts/reset-owner-token.ps1 -Confirm` | `npm run owner:reset -- --confirm` |
| `npm run dev`（`scripts/dev.ts`） | `npm run dev`（改用 `concurrently` 同时跑 `dev:server` 与 `dev:web`） |
| `npm run db:backup` | `npm run db:backup`（实现移入 `server/src/cli/backup-sqlite.ts`） |
| `npm run owner:reset` | `npm run owner:reset`（实现移入 `server/src/cli/reset-owner-token.ts`） |
| `npm run db:migrate` / `db:verify` / `data:migrate-json*` | 无（阶段四一次性 JSON→SQLite 迁移已完成） |
| `npm run test:legacy` / `test:repo` | 已移除；`npm test` 依次跑 `test:api`、`test:web`、`test:db` |

## 恢复方式

如需重新运行旧 Electron 版本，把本目录内容按原路径拷回项目根目录，并还原上述 `package.json`、`server/tsconfig.json`、
`.env.example` 配置，再执行 `npm install`（会重新安装 electron）与 `npm run start:electron`。
注意旧版本依赖 `data/workbench.json`，其内容已随本目录一并归档在 `data/`。

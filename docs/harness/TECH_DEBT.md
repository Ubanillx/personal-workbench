# 技术债登记

登记规则：**每条债必须带证据**（文件 + 行为），写清影响、触发条件、修复成本；禁止把"我觉得不好"当债。
状态：`开放` / `已缓解` / `已修复`。

## 登记表

| ID | 事项 | 证据 | 影响 | 触发条件 | 成本 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| DEBT-01 | 无版本控制（无 git 仓库） | 项目根无 `.git`；`git status` 报 `not a repository` | 改动不可回退、不可 diff/review；误删即不可恢复（本次清理只能靠手工归档兜底） | 任何一次改动 | 0.5 天 | 开放（→ TODO-01） |
| DEBT-02 | `.env` 完全不生效，与 README 不符 | `server/src/config/env.ts:21` 只读 `process.env`；`package.json` 无 `--env-file`、无 dotenv 依赖 | 用户按 README 复制 `.env.example` 后改 `HOST/PORT/DATABASE_PATH` 全部无效，容易误判"服务起不来" | 任何按文档配置环境的尝试 | 0.25 天 | 开放（→ TODO-02） |
| DEBT-03 | API 契约测试过薄 | 48 个端点 vs `test:api` 仅 2 条 test（`workbench-workflow.test.ts`、`report-workflow.test.ts` 各一条大 test 串行断言） | 回归漏检；任何重构（含 Go 重写）都缺安全网 | 每次改动端点逻辑 | 1–1.5 天 | 开放（→ TODO-03） |
| DEBT-04 | `node:sqlite` 为实验特性 | 服务启动固定打印 `ExperimentalWarning: SQLite is an experimental feature`；依赖 Node >= 22.5.0 | Node 升级可能带来破坏性 API 变更；无法使用更成熟的驱动（`better-sqlite3` 需原生编译） | Node 大版本升级 | 视变更而定 | 开放 |
| DEBT-05 | 生产代码中存在死代码与死表 | `server/src/db/json-migration.ts`（11,066 B）仅被 `test/db/json-migration.test.ts` 与其已归档的调用方 `scripts/migrate-json-to-sqlite.ts` 引用；`file-repository.ts`、`note-repository.ts`、`todo-repository.ts`、`user-repository.ts`（合计 7,370 B）全仓零引用；`task-repository.ts` 仅测试引用；`api_tokens`、`migration_runs` 两张表只被迁移代码写入、无任何路由读取 | 约 22 KB 服务端代码 + 4.3 KB 测试属于"只能被测试触达"的死重；误导后来者以为存在 repository 分层 | 读代码、做架构判断时 | 0.5 天 | 开放（→ TODO-04） |
| DEBT-06 | 端点文件为超长单行风格 | `server/src/routes/workbench.ts`：39,493 B / 仅 88 行（平均每行 ~450 字符），39 个端点 + 权限判断 + SQL 全部压在一行内 | 可读性差、diff 噪音极大、漏改风险高（改一个字段可能碰掉整行） | 每次修改该文件 | 1–2 天（可选，需契约测试护航） | 开放（→ TODO-08） |
| DEBT-07 | 受管启动器被移除后的能力回退 | 2026-09-10 归档了 `scripts/start-lan.ps1`（含 Node 版本预检、5173/17500 端口冲突预检、构建后前台启动）与 `scripts/reset-owner-token.ps1`；现在只有 npm 脚本 | 启停前的环境校验与冲突提示消失；"双击即启动"入口消失 | 换机器、Node 版本错配、端口被占用时 | 0.5 天 | 开放（→ TODO-05） |
| DEBT-08 | 备份覆盖不全 + 备份文件散落 | `server/src/db/backup.ts` 的 `pruneBackups` 只裁剪 `backupDirectory` 下的 `*.sqlite.bak` 且 `keep=5`；`server/src/db/client.ts:90` 生成的 `<db>.before-migration-*.bak` 落在数据库同目录（`data/` 根），不受裁剪；`data/uploads/` 内的周报文件不在任何备份范围 | 迁移备份会无限累积在 `data/`；周报上传文件丢失即不可恢复（DB 有元数据但文件没了） | 迁移次数增多 / 需要恢复上传文件时 | 0.5 天 | 开放（→ TODO-06） |
| DEBT-09 | 迁移器不校验已应用迁移的内容 | `server/src/db/migration-runner.ts:11-28` 只记录 `version` + `applied_at`，无 SQL 内容哈希 | 若有人改了已应用的迁移文件，服务不会发现，导致"同一版本号、不同结构"的静默分叉 | 修改历史迁移文件时 | 0.5 天 | 开放（→ TODO-07） |
| DEBT-10 | 两套数据访问风格并存 | `routes/report.ts:7` 使用 `ReportRepository` 类；`routes/workbench.ts` 全部内联 SQL（如 `findFile()` 直接写 `SELECT ... FROM important_files`），而同表的 `file-repository.ts` 无人使用 | 同一张表两种访问方式，改 schema 时容易漏改一处 | 修改数据访问层时 | 与 DEBT-05/06 合并处理 | 开放 |
| DEBT-11 | 5 个空目录残留 | `server/src/middleware/`、`server/src/utils/`、`test/unit/`、`test/fixtures/`、`web/src/components/` 均为空 | 误导目录结构认知（看起来有分层，实际没有） | 阅读目录结构时 | 5 分钟 | 开放（→ TODO-09） |

## 旧 BUG_LIST 复核结论（2026-09-10 逐条对现状核实）

旧的 `BUG_LIST.md` 已随 Electron 栈归档到 `_archive/legacy-electron/BUG_LIST.md`。核对结果如下，**不要重复修已修的项**：

| 原编号 | 问题 | 现状 | 依据 |
| --- | --- | --- | --- |
| #1 (P0) | helmet 默认 CSP 的 `upgrade-insecure-requests` 导致局域网白屏 | ✅ 已修复 | `server/src/app.ts:27-38` 显式移除该指令并关闭 HSTS/COOP；`test/integration/workbench-workflow.test.ts:22-26` 有断言 |
| #2 (P1) | `.env` 不生效 | ❌ **仍未修复** | 见 DEBT-02 |
| #3 (P1) | `start`/`start:lan` 不构建前端 | ✅ 已修复 | `package.json` 两个脚本均以 `npm run build &&` 开头 |
| #4 (P1) | Vite `emptyOutDir: false` 导致 dist 累积 | ✅ 已修复 | `web/vite.config.mts:20` 为 `emptyOutDir: true` |
| #5 (P1) | Vite 配置以 CJS 加载 ESM 语法 | ✅ 已修复 | 配置已改名为 `web/vite.config.mts` |
| #6 (P2) | `node`/`npm` 不在系统 PATH | ⚠️ 部分缓解，且新引入回退 | npm 脚本统一用 `%npm_node_execpath%`、README 写明 NVM 步骤；但带预检的受管启动器已被移除 → DEBT-07 |
| #7 (P2) | 通知跳转不会自动选中任务 | ✅ 已修复 | `web/src/pages/WorkbenchPages.tsx:13-14` 读取 `params.get("task")` 并选中，依赖数组含 `params` |

**结论：7 条中 5 条已修复、1 条未修（`.env`）、1 条变成新的能力回退（启动器）。**

## 度量快照（2026-09-10）

| 指标 | 值 | 备注 |
| --- | --- | --- |
| 服务端代码 | 108,274 字符 / 23 文件 | 含约 22 KB 死代码（DEBT-05） |
| 测试代码 | 31,924 字符 / 7 文件 | 其中 4,347 B 属于死代码的测试 |
| 端点数 | 48 | 契约测试覆盖 2 条 |
| 活表数 | 16（含 2 张死表） | 8 个迁移文件 |
| 依赖 | 9 个运行时依赖 + 11 个开发依赖 | 已无 electron（省 271 MB） |
| 实测资源 | 空载 64.8 MB 工作集 / 冷启动 624 ms | Node 24.9.0 + 生产构建 |

## 季度体检清单

1. 跑 `npm run typecheck && npm test && npm run build`，把结果写回 `README.md` 状态快照。
2. 本表逐条复核：能否降级、能否合并、是否已修复。
3. 检查 `data/` 体积与 `data/backups/` 份数，确认没有异常增长。
4. 复查 `PLAN.md` 的 D-05（Go 重写）是否需要复审。

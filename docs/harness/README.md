# 个人工作台 · 项目 Harness

这是本项目的操作台：现状、待办、计划、技术债、目录架构、数据模型都从这里进。

> 维护规则：**任何改动完成时，先更新对应文档，再算这项改动完成。** 只改代码不改文档 = 未完成。

## 当前状态快照（2026-09-10）

| 项 | 值 |
| --- | --- |
| 版本 | `package.json` 1.0.0 |
| 运行时要求 | Node.js >= 22.5.0（本机实测 24.9.0 / npm 11.17.0） |
| 架构 | 单进程 Fastify + SQLite + React SPA；Electron 已移除 |
| 正式数据库 | `data/workbench.sqlite`（256 KB，16 张活表，8 个迁移） |
| API 面 | 48 个端点（health 2 + workbench 39 + report 7） |
| 服务端代码量 | `server/src` 23 文件 / 108,274 字符 |
| 前端代码量 | `web/src` 8 文件 / 63,208 字符 |
| 测试 | 16/16 通过（test:api 2、test:web 7、test:db 7） |
| typecheck | 通过（server + web，TS strict + noUncheckedIndexedAccess） |
| 实测运行开销 | 空载 64.8 MB 工作集 / 32.0 MB 私有；冷启动到首个 200 响应 624 ms |
| 遗留代码 | 已全部归档到 `_archive/legacy-electron/`（含说明与恢复步骤） |
| 版本控制 | ⚠️ **无 git 仓库** → `DEBT-01` |
| 技术债 | 11 项登记，其中 P1 三项 → `TECH_DEBT.md` |

## 命令速查

| 场景 | 命令 | 说明 |
| --- | --- | --- |
| 日常使用（本机） | `npm start` | 构建前端+后端后在 17500 前台启动 |
| 局域网共享 | `npm run start:lan` | 同上，但绑定 `0.0.0.0` |
| 开发（双进程） | `npm run dev` | `concurrently` 同时起 API(17500) 与 Vite(5173) |
| 只起 API | `npm run dev:server` | `--watch` + tsx 热重启 |
| 只起前端预览 | `npm run dev:web` | Vite，`/api` 代理到 17500 |
| 类型检查 | `npm run typecheck` | server + web 两个 tsconfig |
| 全部测试 | `npm test` | 依次跑 `test:api` → `test:web` → `test:db` |
| 单项测试 | `npm run test:api` / `test:web` / `test:db` | 契约 / 前端基础 / 数据库 |
| 手动备份 | `npm run db:backup` | 写入 `data/backups/`，保留最近 5 份 |
| 重置主人令牌 | `npm run owner:reset -- --confirm` | 先自动备份，再撤销旧令牌与会话 |
| 局域网放行端口 | 见根 README「局域网访问」 | 管理员 PowerShell 执行 `New-NetFirewallRule` |

## 文档索引

| 文件 | 内容 | 什么时候看 / 改 |
| --- | --- | --- |
| `README.md`（本文） | 状态快照、命令速查、维护约定 | 每次交付后更新「当前状态快照」 |
| `TODO.md` | 待办清单（P0–P3 + 验收标准） | 开工前挑一项；完成后勾掉并写明日期 |
| `PLAN.md` | 路线选择、里程碑、决策记录、风险 | 改方向、做取舍时 |
| `TECH_DEBT.md` | 技术债登记 + 旧 BUG_LIST 复核结论 | 还债时；每季度体检时 |
| `ARCHITECTURE.md` | 目录架构、模块职责、请求链路、48 端点 | 改代码结构、加接口时 |
| `DATA_MODEL.md` | 16 张表、状态机、迁移机制、备份恢复 | 动数据库、动迁移时 |

## 给 AI Agent 的阅读顺序

1. 本文 → 2. `ARCHITECTURE.md` → 3. `DATA_MODEL.md` → 4. 按任务读 `TODO.md` / `TECH_DEBT.md` / `PLAN.md`。

硬规则（违反会破坏项目一致性）：

- **改数据库**：新增迁移文件（`server/src/db/migrations/00N_*.sql`），**绝不修改已应用的迁移**；同步更新 `DATA_MODEL.md`。
- **改 API**：同步更新 `ARCHITECTURE.md` 的端点清单，并在 `test/integration/` 补对应断言。
- **改配置/命令**：同步更新本文「命令速查」与根 `README.md`。
- **交付前**：`npm run typecheck && npm test && npm run build` 三项全绿，并把结果写回本文状态快照。
- **不要用 PowerShell 文本命令改写这些文档**：本机 pwsh 的 `Get-Content` 按 GBK 解码，UTF-8 中文会被写坏；请用文件写入工具直接改。
- **不要在项目根目录新增散装 .md**：文档统一放 `docs/`。

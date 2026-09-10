# 个人工作台 · 项目 Harness

这是本项目的操作台：现状、待办、计划、技术债、目录架构、数据模型都从这里进。

> 维护规则：**任何改动完成时，先更新对应文档，再算这项改动完成。** 只改代码不改文档 = 未完成。

## 当前状态快照（2026-09-10，全栈迁移完成后）

| 项           | 值                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| 版本         | `package.json` 1.0.0                                                                                                |
| 运行时要求   | Node.js >= 22.5.0（本机实测 24.9.0 / npm 11.17.0）                                                                  |
| 架构         | **单进程 React Router 8 framework mode（SSR 页面 + `/api/*` 资源路由）+ SQLite**；Electron 与 Fastify 均已归档      |
| 正式数据库   | `data/workbench.sqlite`（256 KB，16 张活表，8 个迁移）                                                              |
| API 面       | 48 个端点（health 2 + workbench 39 + report 7），由 39 个 `app/routes/api.*.ts` 承载                                |
| 应用代码量   | `app/` 73 文件 / 192,652 字符 / 5,087 行（含 10 个页面路由、17 个 `lib/*.server.ts`）                               |
| 服务端代码量 | `server/src` 18 文件 / 48,540 字符 / 1,274 行（框架无关的 db / security / config / cli）                            |
| 工具与测试   | `tools/` 7 文件 1,132 行；`test/` 5 文件 339 行；`shared/` 仅剩 `types/domain.ts`                                   |
| 测试         | **185 项全绿**：test:db 7 + test:api 139 + test:owner 1 + test:ui 38                                                |
| 类型检查     | 通过（TS 7.0.2 原生 tsc；server + tools + app + test 四个工程，strict + noUncheckedIndexedAccess）                  |
| Lint         | **0 warning / 0 error**（oxlint 1.82，106 文件）                                                                    |
| 格式化       | Prettier 3.9，`format:check` 无漂移                                                                                 |
| 构建产物     | 客户端 98 资产 / 1,465 KB（路由级分块）；SSR bundle 229 KB                                                          |
| 服务绑定     | `npm start` → `127.0.0.1:17500`（仅本机）；`npm run start:lan` → `0.0.0.0:17500`                                    |
| 遗留代码     | `_archive/legacy-electron/`（Electron 栈）+ `_archive/legacy-fastify/`（20 文件，Fastify + Vite SPA），均含恢复说明 |
| 版本控制     | git 仓库（`main` 分支）                                                                                             |
| 技术债       | 17 项登记（DEBT-01…17）→ `TECH_DEBT.md`                                                                             |
| 契约快照     | 139 条用例覆盖 48 端点 × 五种身份；`contract:compare` 全绿                                                          |
| 前端 UI      | **antd v6.6.3** + icons 6.3.4；`antd doctor` 14 项全过，`antd lint app` 73 文件无问题                               |
| 全栈迁移     | **Phase 0–4 全部完成** → `FULLSTACK_MIGRATION.md`                                                                   |
| 账号与组织   | **改造中**：A 阶段（数据层迁移 + CLI，`db:rehearse` 42 项全绿）已完成，B–E 待做 → `ACCOUNTS_AND_ORGS.md`            |

## 命令速查

| 场景             | 命令                                                      | 说明                                                                                  |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 日常使用（本机） | `npm start`                                               | 构建后以 `HOST=127.0.0.1 PORT=17500` 前台启动单进程服务                               |
| 局域网共享       | `npm run start:lan`                                       | 同上，但绑定 `0.0.0.0`                                                                |
| 只重启不重建     | `npm run serve`                                           | 直接跑 `build/` 产物；**不要**裸调 `react-router-serve`（会默认 3000 并绑定所有网卡） |
| 开发（热更新）   | `npm run dev`                                             | `react-router dev`，单进程同时提供页面与 API（默认 5173，仅本机）                     |
| 构建             | `npm run build`                                           | 客户端 + SSR 一起产出到 `build/`                                                      |
| 类型检查         | `npm run typecheck`                                       | server + tools + app + test 四个 tsconfig                                             |
| Lint             | `npm run lint` / `npm run lint:fix`                       | oxlint，门禁 0 warning / 0 error                                                      |
| 格式化           | `npm run format` / `npm run format:check`                 | Prettier，全量或只检查漂移                                                            |
| 契约快照录制     | `npm run contract:capture`                                | 黑盒跑 139 条用例，写入 `test/contract/golden/`                                       |
| 契约回放比对     | `npm run contract:compare`                                | 默认自己拉起 `npm run serve` + 夹具库，逐条比对                                       |
| antd 用法检查    | `npx antd lint app`                                       | **提交前必跑**：废弃用法 / a11y / 性能                                                |
| antd API 查询    | `npx antd info` / `demo` / `doc <组件>`                   | 写 antd 代码前先查，禁止凭记忆写 v6 API                                               |
| antd 项目诊断    | `npx antd doctor`                                         | 版本冲突、重复安装、主题配置                                                          |
| 全部测试         | `npm test`                                                | 依次 `test:db` → `test:api` → `test:owner` → `test:ui`                                |
| 单项测试         | `npm run test:db` / `test:api` / `test:owner` / `test:ui` | 数据层 / 139 条契约回放 / 重置主人令牌端到端 / SSR 冒烟                               |
| 生成夹具库       | `npm run contract:fixture`                                | 输出可直接用作 `DATABASE_PATH` 的临时库（含固定令牌）                                 |
| SSR 冒烟         | `npm run smoke:ui -- --require-migrated`                  | 逐页验收；`--paths` 限定页面，`--require-migrated` 把占位页计为失败                   |
| 手动备份         | `npm run db:backup`                                       | 写入 `data/backups/`，保留最近 5 份                                                   |
| 重置主人令牌     | `npm run owner:reset -- --confirm`                        | 先自动备份，再撤销旧令牌与会话（**B 阶段退役**，改用 `user:passwd`）                  |
| 账号清单         | `npm run user:list`                                       | 用户名 / 邮箱 / 角色 / 组织 / 是否待改密（**B 阶段启用**）                            |
| 重置账号密码     | `npm run user:passwd -- <用户名> [--generate]`            | 本机唯一的重置途径；也可用 `WORKBENCH_PASSWORD` 环境变量或管道输入                    |
| 初始化初始密码   | `npm run user:init -- --confirm`                          | 迁移后一次性：给仍是 `locked$` 的账号生成初始密码并打印（幂等）                       |
| 迁移演练         | `npm run db:rehearse [-- --keep]`                         | 在**正式库副本**上试跑 `server/src/db/migrations-pending/`，42 项核对                 |
| 局域网放行端口   | 见根 README「局域网访问」                                 | 管理员 PowerShell 执行 `New-NetFirewallRule`                                          |

## 文档索引

| 文件                     | 内容                                                   | 什么时候看 / 改                            |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------ |
| `README.md`（本文）      | 状态快照、命令速查、维护约定                           | 每次交付后更新「当前状态快照」             |
| `TODO.md`                | 待办清单（P0–P3 + 验收标准）                           | 开工前挑一项；完成后勾掉并写明日期         |
| `PLAN.md`                | 路线选择、里程碑、决策记录、风险                       | 改方向、做取舍时                           |
| `TECH_DEBT.md`           | 技术债登记 + 旧 BUG_LIST 复核结论                      | 还债时；每季度体检时                       |
| `ARCHITECTURE.md`        | 目录架构、模块职责、请求链路、48 端点                  | 改代码结构、加接口时                       |
| `DATA_MODEL.md`          | 16 张表、状态机、迁移机制、备份恢复                    | 动数据库、动迁移时                         |
| `CODE_STYLE.md`          | TS 约束、oxlint 规则、Prettier、抑制规范               | 写代码前；加规则、遇误报时                 |
| `FULLSTACK_MIGRATION.md` | 全栈迁移（React Router 8）阶段、决策、回退             | 迁移期间的主线文档；每阶段结束都要更新     |
| `ACCOUNTS_AND_ORGS.md`   | 账号密码 + 多组织改造（D-18…D-34）、权限矩阵、A–E 阶段 | 改造期间的主线文档；改认证/权限/组织前必读 |

## 给 AI Agent 的阅读顺序

1. 本文 → 2. `ARCHITECTURE.md` → 3. `DATA_MODEL.md` → 4. `CODE_STYLE.md` → 5. 迁移期间先读 `FULLSTACK_MIGRATION.md` → 6. **改造期间先读 `ACCOUNTS_AND_ORGS.md`** → 7. 按任务读 `TODO.md` / `TECH_DEBT.md` / `PLAN.md`。

硬规则（违反会破坏项目一致性）：

- **改数据库**：新增迁移文件（`server/src/db/migrations/00N_*.sql`），**绝不修改已应用的迁移**；同步更新 `DATA_MODEL.md`。
- **改 API**：同步更新 `ARCHITECTURE.md` 的端点清单，并在 `tools/contract/cases.ts` 补对应用例、重新 `contract:capture` 录制 golden。
- **改配置/命令**：同步更新本文「命令速查」与根 `README.md`。
- **交付前四件套**：`npm run lint`（0 warning / 0 error）、`npm run typecheck`、`npm test`（185 项全绿）、`npm run build` 全绿，另跑 `npm run format:check` 与 `npx antd lint app`，并把结果写回本文状态快照。
- **契约门禁（长期有效）**：任何改动端点或数据层的提交，都必须让 `npm run contract:compare` 保持 139 条 100% 一致；不一致时不允许提交，除非是**有意**的行为变更并同步重新 capture。
- **改端点行为时**：先改代码 → 跑 `contract:compare` 看差异 → 确认是预期变更后 `contract:capture` 重新录制 → 在提交信息里说明行为变更点。
- **只写 TypeScript**：源码禁用 `.js` / `.jsx`；命名约定、抑制注释与规则增删流程见 `CODE_STYLE.md`。
- **不要用 PowerShell 文本命令改写仓库文件**：本机 pwsh 的 `Get-Content` 按 GBK 解码，UTF-8 中文会被写坏（已实际踩坑 2 次）；读写一律用文件工具，只读命令（`git status`、`npx oxlint` 等）不受影响。
- **不要直接调用 `react-router-serve`**：它在没有 `PORT` 时默认 3000，端口被占用时静默换随机端口，没有 `HOST` 时绑定所有网卡。启动一律走 `npm start` / `npm run start:lan` / `npm run serve`。
- **不要在项目根目录新增散装 .md**：文档统一放 `docs/`。

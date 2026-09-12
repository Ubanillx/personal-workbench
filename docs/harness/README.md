# 个人工作台 · 项目 Harness

这是本项目的操作台：现状、待办、计划、技术债、目录架构、数据模型都从这里进。

> 维护规则：**任何改动完成时，先更新对应文档，再算这项改动完成。** 只改代码不改文档 = 未完成。

## 当前状态快照（2026-09-12，重要文件支持远端下载之后）

| 项           | 值                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 版本         | `package.json` 1.0.0                                                                                                                                                                       |
| 运行时要求   | Node.js >= 22.9.0（本机实测 24.9.0 / npm 11.17.0）                                                                                                                                         |
| 架构         | **单进程 React Router 8 framework mode（SSR 页面 + `/api/*` 资源路由）+ SQLite**；Electron 与 Fastify 均已归档                                                                             |
| 正式数据库   | `data/workbench.sqlite`（19 张活表，14 个迁移 001–014）                                                                                                                                    |
| API 面       | 66 个端点（health 2 + 认证/访问 6 + 组织 13 + 成员 3 + 概览与任务 14 + 通知与验收 4 + 待办/随手记 8 + 文件 5 + 企微导入 2 + WebDAV 2 + 周报 7），由 53 个 `app/routes/api.*.ts` 承载       |
| 应用代码量   | `app/` 115 文件 / 14,476 行（85 个 `.ts` + 30 个 `.tsx`；含 12 个页面路由、53 个 API 路由、21 个 `lib/*.server.ts`）                                                                       |
| 服务端代码量 | `server/src` 19 文件 / 1,981 行（框架无关的 db / security / config / cli / webdav）                                                                                                        |
| 工具与测试   | `tools/` 11 文件 3,775 行；`test/` 9 文件 1,342 行；`shared/` 仅剩 `types/domain.ts`                                                                                                       |
| 测试         | **全绿**：test:db 25 + test:webdav 13 + test:api 324（契约）+ test:auth 2 + test:ui 98（SSR 冒烟）= 462 项                                                                                 |
| 类型检查     | 通过（TS 7.0.2 原生 tsc；server + tools + app + test 四个工程，strict + noUncheckedIndexedAccess）                                                                                         |
| Lint         | **0 warning / 0 error**（oxlint 1.82，155 文件）                                                                                                                                           |
| 格式化       | Prettier 3.9，`format:check` 无漂移                                                                                                                                                        |
| 服务绑定     | `npm start` → `127.0.0.1:17500`（仅本机）；`npm run start:lan` → `0.0.0.0:17500`                                                                                                           |
| 遗留代码     | `_archive/legacy-electron/`（Electron 栈）+ `_archive/legacy-fastify/`（20 文件，Fastify + Vite SPA），均含恢复说明                                                                        |
| 版本控制     | git 仓库（`main` 分支）                                                                                                                                                                    |
| 技术债       | 18 项登记（DEBT-01…18）→ `TECH_DEBT.md`                                                                                                                                                    |
| 契约快照     | **324 条用例 / 128 个 method+path 组合 / 17 个域**，覆盖九种身份（含跨组织隔离、webdav.* 与 files.download.* 用例）；`contract:compare` 全绿                                               |
| 前端 UI      | **antd v6.6.3** + icons 6.3.4；`antd doctor` 14 项全过，`antd lint app` 114 文件无问题                                                                                                     |
| 全栈迁移     | **Phase 0–4 全部完成** → `FULLSTACK_MIGRATION.md`                                                                                                                                          |
| 账号与组织   | **A–E 全部完成**（正式库已迁移至 011，契约 324/324）→ `ACCOUNTS_AND_ORGS.md`                                                                                                               |
| 周报存储     | **D-46 已实现**：正文只写 NAS（`<上传根>/<用户名>/<起止日期>/<文件名>`），归属人=登录账号，管理员不提交 → `REPORTS_WEBDAV.md`                                                              |
| 重要文件     | **D-48 / D-49 已实现**：新建/编辑抽屉用「选择文件」挑路径（保存才落库），远端条目可流式下载，与「浏览 WebDAV」共用浏览器 → `WEBDAV.md`                                                     |
| 部署         | **Jenkins CI/CD**：GitHub push → Jenkins 构建 + 测试 + 打包（内含生产依赖）→ scp/ssh → 目标机 systemd，`releases/` + `current` 原子切换 + 健康检查失败自动回滚 → `deploy/README-DEPLOY.md` |

## 命令速查

| 场景             | 命令                                                                     | 说明                                                                                                    |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 日常使用（本机） | `npm start`                                                              | 构建后以 `HOST=127.0.0.1 PORT=17500` 前台启动单进程服务                                                 |
| 局域网共享       | `npm run start:lan`                                                      | 同上，但绑定 `0.0.0.0`                                                                                  |
| 只重启不重建     | `npm run serve`                                                          | 直接跑 `build/` 产物；**不要**裸调 `react-router-serve`（会默认 3000 并绑定所有网卡）                   |
| 开发（热更新）   | `npm run dev`                                                            | `react-router dev`，单进程同时提供页面与 API（默认 5173，仅本机）                                       |
| 构建             | `npm run build`                                                          | 先跑 `tools/build/prebuild.ts` 解锁 `build/`，再产出客户端 + SSR                                        |
| 类型检查         | `npm run typecheck`                                                      | server + tools + app + test 四个 tsconfig                                                               |
| Lint             | `npm run lint` / `npm run lint:fix`                                      | oxlint，门禁 0 warning / 0 error                                                                        |
| 格式化           | `npm run format` / `npm run format:check`                                | Prettier，全量或只检查漂移                                                                              |
| 契约快照录制     | `npm run contract:capture`                                               | 黑盒跑 324 条用例，写入 `test/contract/golden/`（**先 `npm run build`**；自动拉起假 WebDAV）            |
| 契约回放比对     | `npm run contract:compare`                                               | 默认自己拉起 `npm run serve` + 夹具库 + 假 WebDAV，逐条比对                                             |
| antd 用法检查    | `npx antd lint app`                                                      | **提交前必跑**：废弃用法 / a11y / 性能                                                                  |
| antd API 查询    | `npx antd info` / `demo` / `doc <组件>`                                  | 写 antd 代码前先查，禁止凭记忆写 v6 API                                                                 |
| antd 项目诊断    | `npx antd doctor`                                                        | 版本冲突、重复安装、主题配置                                                                            |
| 全部测试         | `npm test`                                                               | 依次 `test:db` → `test:webdav` → `test:api` → `test:auth` → `test:ui`                                   |
| 单项测试         | `npm run test:db` / `test:webdav` / `test:api` / `test:auth` / `test:ui` | 数据层 / WebDAV 客户端（假服务器）/ 324 条契约回放 / 注册登录改密端到端 / SSR 冒烟                      |
| 生成夹具库       | `npm run contract:fixture`                                               | 输出可直接用作 `DATABASE_PATH` 的临时库（含固定令牌与周报上传配置行）                                   |
| SSR 冒烟         | `npm run smoke:ui -- --require-migrated`                                 | 逐页验收；`--paths` 限定页面，`--require-migrated` 把占位页计为失败                                     |
| 手动备份         | `npm run db:backup`                                                      | 写入 `data/backups/`，保留最近 5 份                                                                     |
| 周报正文搬迁     | `npm run reports:migrate-webdav [-- --dry-run] [-- --purge]`             | 把本地老周报推到 NAS 并回写索引（幂等）；默认不删本地，`--purge` 才清                                   |
| 账号清单         | `npm run user:list`                                                      | 用户名 / 邮箱 / 角色 / 组织 / 是否待改密                                                                |
| 重置账号密码     | `npm run user:passwd -- <用户名> [--generate]`                           | 本机唯一的重置途径；也可用 `WORKBENCH_PASSWORD` 环境变量或管道输入                                      |
| 初始化初始密码   | `npm run user:init -- --confirm`                                         | 给仍是 `locked$` 的账号生成初始密码并打印（幂等；全新空库自举的 `admin` 也走它）                        |
| 迁移演练         | `npm run db:rehearse [-- --keep] [-- --source <路径>]`                   | 在库副本上试跑 `server/src/db/migrations/`，逐表核对（迁移前库 44 项；已迁移库自动跳过 6 项初始态断言） |
| 局域网放行端口   | 见根 README「局域网访问」                                                | 管理员 PowerShell 执行 `New-NetFirewallRule`                                                            |
| 部署（自动）     | Jenkins 任务 → `ACTION=deploy`                                           | push `main` 由 webhook 触发；详见 `deploy/README-DEPLOY.md`                                             |
| 部署（查状态）   | `sudo /opt/personal-workbench/bin/deploy.sh status`                      | 目标机上执行：当前 release / 服务状态 / 健康检查 / 历史版本                                             |
| 部署（回滚）     | `sudo …/deploy.sh rollback` 或 Jenkins `ACTION=rollback`                 | 切回上一个 release 并重启；**只回代码不回数据库结构**                                                   |

## 文档索引

| 文件                            | 内容                                                                       | 什么时候看 / 改                                |
| ------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------- |
| `README.md`（本文）             | 状态快照、命令速查、维护约定                                               | 每次交付后更新「当前状态快照」                 |
| `TODO.md`                       | 待办清单（P0–P3 + 验收标准）                                               | 开工前挑一项；完成后勾掉并写明日期             |
| `PLAN.md`                       | 路线选择、里程碑、决策记录、风险                                           | 改方向、做取舍时                               |
| `TECH_DEBT.md`                  | 技术债登记 + 旧 BUG_LIST 复核结论                                          | 还债时；每季度体检时                           |
| `ARCHITECTURE.md`               | 目录架构、模块职责、请求链路、65 端点                                      | 改代码结构、加接口时                           |
| `DATA_MODEL.md`                 | 19 张表、状态机、迁移机制、备份恢复                                        | 动数据库、动迁移时                             |
| `CODE_STYLE.md`                 | TS 约束、oxlint 规则、Prettier、抑制规范                                   | 写代码前；加规则、遇误报时                     |
| `FULLSTACK_MIGRATION.md`        | 全栈迁移（React Router 8）阶段、决策、回退                                 | 迁移期间的主线文档；每阶段结束都要更新         |
| `ACCOUNTS_AND_ORGS.md`          | 账号密码 + 多组织改造（D-18…D-42）、权限矩阵、A–E 阶段                     | 改造主线文档（已收尾）；改认证/权限/组织前必读 |
| `WEBDAV.md`                     | 「重要文件」的 WebDAV 接入：配置、结构、边界、取舍                         | 动远端文件/上传链路前必读（D-41）              |
| `REPORTS_WEBDAV.md`             | 周报/总结正文改存 WebDAV：冻结点、命名、配置、迁移、回滚                   | **已实现（D-46）**；改周报提交/存储/下载前必读 |
| `../../deploy/README-DEPLOY.md` | 部署与 CI/CD：目标机布局、Jenkins 配置、首次接入、回滚边界、排障、安全清单 | 上线、改部署脚本、出事回滚前必读               |
| `../../Jenkinsfile`             | 流水线本身（构建/测试/打包/发布/回滚参数）                                 | 改流水线阶段或目标机时                         |

## 给 AI Agent 的阅读顺序

1. 本文 → 2. `ARCHITECTURE.md` → 3. `DATA_MODEL.md` → 4. `CODE_STYLE.md` → 5. 迁移历史见 `FULLSTACK_MIGRATION.md` → 6. **改认证/权限/组织前先读 `ACCOUNTS_AND_ORGS.md`** → 7. 按任务读 `TODO.md` / `TECH_DEBT.md` / `PLAN.md`。

硬规则（违反会破坏项目一致性）：

- **改数据库**：新增迁移文件（`server/src/db/migrations/00N_*.sql`），**绝不修改已应用的迁移**；同步更新 `DATA_MODEL.md`。
- **改 API**：同步更新 `ARCHITECTURE.md` 的端点清单，并在 `tools/contract/cases.ts` 补对应用例、重新 `contract:capture` 录制 golden。
- **改配置/命令**：同步更新本文「命令速查」与根 `README.md`。
- **交付前四件套**：`npm run lint`（0 warning / 0 error）、`npm run typecheck`、`npm test`（463 项全绿）、`npm run build` 全绿，另跑 `npm run format:check` 与 `npx antd lint app`，并把结果写回本文状态快照。
- **契约门禁（长期有效）**：任何改动端点或数据层的提交，都必须让 `npm run contract:compare` 保持 **324** 条 100% 一致；不一致时不允许提交，除非是**有意**的行为变更并同步重新 capture。
- **改端点行为时**：先改代码 → 跑 `contract:compare` 看差异 → 确认是预期变更后 `contract:capture` 重新录制 → 在提交信息里说明行为变更点。
- **周报正文只写 NAS（D-46）**：改周报的提交 / 存储 / 下载前先读 `REPORTS_WEBDAV.md`；契约与 SSR 冒烟的「远端」是
  `tools/webdav/fake-server.ts`（由 `contract:*` 与 `smoke:ui` 自动拉起并通过 `WEBDAV_URL` 注入），**不要**为了跑通用例给夹具开本地落盘后门。
- **不要直接读 `.env` 里的地址做判断**：WebDAV 地址是部署级的（`WEBDAV_URL`），凭据分两份——按账号的 `webdav_settings`（重要文件）与全局单行的 `report_upload_settings`（周报上传），别把两者混用。
- **只写 TypeScript**：源码禁用 `.js` / `.jsx`；命名约定、抑制注释与规则增删流程见 `CODE_STYLE.md`。
- **不要用 PowerShell 文本命令改写仓库文件**：本机 pwsh 的 `Get-Content` 按 GBK 解码，UTF-8 中文会被写坏（已实际踩坑 2 次）；读写一律用文件工具，只读命令（`git status`、`npx oxlint` 等）不受影响。
- **不要直接调用 `react-router-serve`**：它在没有 `PORT` 时默认 3000，端口被占用时静默换随机端口，没有 `HOST` 时绑定所有网卡。启动一律走 `npm start` / `npm run start:lan` / `npm run serve`。
- **不要手删 `build/`**：清空 `build/` 本来就是 `react-router build` 的第一步，不需要人工做。这一步在 Windows 上会因 `build/`
  被残留的 `serve` / `start` 进程占用而 `EBUSY` / `EPERM` 失败，且**在编译前**中止构建；`npm run build` 已内建
  `tools/build/prebuild.ts` 检测并结束占用进程，遇到时看该脚本的输出即可。
- **不要在项目根目录新增散装 .md**：文档统一放 `docs/`。

## 2026-09-10 E2E 验收

- 浏览器：覆盖登录、首页、任务、待办、随手记、企微收件箱、周报/总结、管理页和回顾统计。
- 响应式：在 390 × 844 视口检查导航展开、菜单跳转、自动收起和横向溢出。
- 自动化：数据库、认证、API 契约和页面冒烟测试通过；页面冒烟共 79 项（该次为 74 项，ORG-D 后增至 79）。
- 工程检查：执行测试、类型检查、代码检查、格式检查、构建和 Ant Design 规范检查。
- 证据：截图保存在 docs/qa/2026-09-10。

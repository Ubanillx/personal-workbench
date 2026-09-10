# 全栈迁移计划：Fastify SPA+API → React Router 8 framework mode

状态：**进行中**（2026-09-10 立项）。目标是把项目变成名副其实的 Node.js 全栈单进程应用：统一路由、服务端取数、一套类型契约、一个启动命令。

## 已定决策

| ID   | 决策                                                      | 说明                                                                                                            |
| ---- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| D-05 | **放弃 Go 重写**（原为"暂不启动"）                        | 与 Node 全栈方向冲突；项目当前健康，重写收益不足以抵消双栈维护成本                                              |
| D-09 | 采用 **React Router 8 framework mode**（而非 Next.js 16） | 保留现有 Vite 构建与 react-router 使用习惯，改动面最小；Next.js 的 RSC/SSR 心智模型与依赖树对单机自用工具是负担 |
| D-10 | **Phase 0 契约快照先行**，不直接重写                      | 48 端点只有 2 条契约测试；没有 golden 回放，行为偏移（403/404 边界、字段名、错误码）会静默丢失                  |
| D-11 | Fastify 完全退役，不保留双框架                            | 与"全栈单进程"目标一致；框架的 route handler 接管 48 个端点                                                     |
| D-15 | 前端先完成 antd v6 组件化，再做 Phase 3 的路由迁移        | 组件替换与路由框架替换互相独立；先组件后框架，Phase 3 只做结构搬运（见 `PLAN.md` D-12/D-14）                    |

## 代码盘点（实测）

| 分类       | 规模               | 处置                                                                                                                                            |
| ---------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 可原样复用 | 22 文件 / 1,247 行 | `db/`（client、migration-runner、backup、health、migrations）、`security/`、`config/`、`types/`、`cli/`、`shared/` —— 纯 TS，与框架无关，直接搬 |
| 需要重塑   | 5 文件 / 1,591 行  | `routes/workbench.ts`(1,026)、`routes/report.ts`(381)、`app.ts`(110)、`index.ts`(54)、`routes/health.ts` → 变成框架的 route/loader + action     |
| 前端迁移   | 8 文件 / 2,110 行  | 页面搬到文件路由；`apiClient.ts`（226 行）大概率整体消失，改由 loader/action + `useFetcher` 承担                                                |
| 测试重写   | 7 文件 / 630 行    | 现有测试依赖 Fastify `app.inject()`，必须改写；`test/web/foundation.test.ts` 里对静态托管的断言也要重写                                         |

## 阶段与验收

### Phase 0 · 契约快照（已完成 2026-09-10）

**产物**：`tools/contract/` 三件套 + `test/contract/golden/*.json`。

- `seed.ts`：用 `node:sqlite` 直接建临时库并灌入确定性种子数据（三角色 + 各类状态的任务 + 周报 + 文件），时间戳写死，避免随机。
- `cases.ts`：声明式用例表，覆盖 **48 个端点 × 三种角色**，外加边界（无令牌、越权、非法字段、404、归档态、重复指纹）。
- `capture.ts`：以**黑盒 HTTP** 方式启动被测服务（子进程 + 临时库 + 临时端口），用 cookie jar 跑用例，对易变字段做归一化（uuid → `<uuid>`、ISO 时间 → `<ts>`、令牌 → `<token>`），写出 golden。
- `compare.ts`：对任意 base URL 回放同一批用例并与 golden 逐条比对，输出差异报告。

**为什么必须黑盒**：只有走 HTTP，同一套用例才能在迁移后原样回放；`app.inject()` 是 Fastify 专属，换了框架就作废。

**验收（已完成 2026-09-10）**：

| 检查       | 结果                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| 录制       | `npm run contract:capture` → **139 条用例**写入 `test/contract/golden/contract.golden.json`              |
| 覆盖率     | 48 个端点全部覆盖，含 owner/assistant/assistantB/viewer/anon 五种身份                                    |
| 状态码分布 | 200×66、201×17、400×17、401×5、403×22、404×12                                                            |
| 正向自检   | 对**当前**实现回放 139 条 → **全部一致**（证明工具可复现、golden 无随机性）                              |
| 反向自检   | 篡改 golden 两处（403→200、body 注入字段）→ 回放精确报出这 2 条不一致并 exit 1（证明安全网真能抓到漂移） |

迁移期间的门禁：任何触及端点或数据层的提交都必须让 `contract:compare` 保持 100% 一致。

### Phase 1 · 数据与安全层搬迁（预计 0.5 天）← 下一步

把 1,247 行原样复用代码搬进新工程结构，先跑通「迁移器 + 认证 + health」。

**前置兼容性尖兵（2026-09-10 已完成，结论：可行）**

在临时目录（不碰项目）搭了一个最小 RR8 framework mode 应用并实测：

| 验证点                                                            | 结果                                                                                                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| RR8 8.3.1 + Vite 8.2.2 + React 19.2.8 + TypeScript 7.0.2 能否构建 | ✅ `react-router build` 通过（客户端 143ms + 服务端 29ms）                                                                                    |
| **`node:sqlite` 能否在 RR8 server loader 里直接用**               | ✅ 返回 `{ok:true, node:"24.9.0", row:{…}}`，`runtime:"server"`                                                                               |
| SSR 渲染                                                          | ✅ `/` 返回 200 且含渲染后的 `<h1>`                                                                                                           |
| 未知路由                                                          | ✅ 返回 404                                                                                                                                   |
| 环境坑（**必须记住**）                                            | `npx react-router build` 会改动 npm 依赖树并导致 `ERR_MODULE_NOT_FOUND`；**必须用本地 bin**（`node_modules\.bin\react-router` 或 npm script） |

结论：Phase 1 不需要为「TS 7 原生编译器 / `node:sqlite` / Vite 8」做额外适配，按 RR8 官方结构落地即可。

**验收**：新工程能用临时库启动并对 `/api/health`、`/api/ping` 通过 golden 比对（`/api/auth/*` 依赖 workbench 路由代码，实际归入 Phase 2）。

**Phase 1 进度（2026-09-10，骨架与 health 已完成）**

| 事项                | 状态                                                                                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RR8 依赖            | ✅ `react-router@8.3.1` + `@react-router/{dev,node,serve}@8.3.1`；`@react-router/dev` 的 peer 明确支持 `typescript ^7.0.0`                                                                                                                                                                              |
| **依赖冲突解法**    | 旧前端依赖 `react-router-dom@7`（内含 `react-router@7`），与 RR8 的 peer 冲突。解法是**统一版本**：旧前端 3 处导入由 `react-router-dom` 改为 `react-router`（v8 仍导出 BrowserRouter/Routes/Route/NavLink/useNavigate/useSearchParams 等 129 个导出），并卸载 `react-router-dom`；旧前端 typecheck 通过 |
| 新工程骨架          | ✅ 根目录 `react-router.config.ts`（`ssr:true`）、`vite.config.ts`、`tsconfig.json`，以及 `app/{root.tsx,routes.ts,routes/,lib/}`                                                                                                                                                                       |
| 数据/安全层复用方式 | **相对导入原地复用**（`app/lib/context.server.ts` → `server/src/db                                                                                                                                                                                                                                      | config`），不做物理搬迁；物理搬迁放到 Phase 4 与归档一起做（否则旧实现立刻不可运行） |
| 一处必须改的代码    | `server/src/db/client.ts` 的 `createRequire(__filename)` 在 ESM 下会在**模块加载时**崩溃 → 改为 `typeof __filename === "string" ? __filename : path.join(process.cwd(), "index.js")`，双运行时兼容（旧实现 typecheck + 16 测试仍全过）                                                                  |
| 响应信封对齐        | 新增 `app/lib/http.server.ts`，逐字节复刻旧实现的 `{ok,data}` / `{ok,error:{code,message}}`、`application/json; charset=utf-8`、helmet 的 CSP（去除 `upgrade-insecure-requests`）、`X-Content-Type-Options: nosniff`，且不发 HSTS/COOP                                                                  |
| 验收结果            | ✅ `npm run rr:build` 通过（客户端 84 模块 / SSR 14 模块）；新实现 `/api/ping` 与旧实现**逐字节一致**（仅时间戳不同）；`contract:compare --base-url … --only health.ping.anon,health.status.anon` → **全部一致**                                                                                        |
| 正式库安全          | ✅ `data/workbench.sqlite` 验收前后 size 与 mtime 完全一致（运行指向临时副本）                                                                                                                                                                                                                          |
| 新增工具能力        | 契约工具支持 `--only <前缀,前缀>`，可按阶段/按域分批验收                                                                                                                                                                                                                                                |

**两处环境坑（已踩，务必记住）**

1. **npmmirror 上的 `@react-router/dev@8.3.1` 包不完整**（缺 `module-sync-enabled/index.mjs`），构建报 `ERR_MODULE_NOT_FOUND`，且失败过程会触发 npm 清理把该包整个删掉。解法：`npm install -D @react-router/dev@8.3.1 --registry=https://registry.npmjs.org`。
2. 本工具的 `pwsh` 实际是 **Windows PowerShell 5.1**（不支持 `??` 等 PS7 语法，`Get-Content` 按 GBK 解码 UTF-8）→ 脚本避免 PS7 语法，读写仓库文件一律用文件工具。

### Phase 2 · 48 个端点迁移（已完成 2026-09-10）

`workbench.ts` 39 个 + `report.ts` 7 个 + `health.ts` 2 个已全部搬成框架资源路由。

**完成证据**：新旧两套实现**各自**通过全量 golden 回放 **139/139 一致**（exit 0）；oxlint 0/0（102 文件）、typecheck（server+web+tools+app）通过、`npm test` 16/16、新旧两套 build 均通过、format:check 无漂移；`data/workbench.sqlite` 全程 size/mtime 未变。

**"Fastify 退役"的口径**：API 层已**不再依赖 Fastify**——48 个端点全部由 RR8 资源路由提供且行为等价。但**物理移除/归档放在 Phase 4**：Phase 3 之前新工程还没有 UI（只有占位首页），此刻切换默认启动会让日常使用失去界面。所以 Phase 2 的"退役"是依赖层面，删除层面归 Phase 4。

**验收**：`contract:compare` 对**新**实现回放 100% 一致；`lint`、`typecheck`、`test`、`build` 全绿。

**分批策略（每批独立验收，避免一次性重写 1,400 行）**

| 批次 | 范围                                                   | 用例前缀                                                                 | 状态                                  |
| ---- | ------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------- |
| A    | 认证 + 访问信息（4 端点）                              | `auth.` `access-info.`                                                   | ✅ 12/12 一致（2026-09-10）           |
| B    | dashboard + 任务全流程 + 评论/时间线 + 通知 + 验收视图 | `dashboard.` `tasks.` `comments.` `activity.` `notifications.` `review.` | 进行中                                |
| C    | users / todos / notes / files / inbox                  | `users.` `todos.` `notes.` `files.` `inbox.`                             | 待开始（依赖 B 抽出的任务域辅助函数） |
| D    | reports（multipart 上传 + 文件下载）                   | `reports.`                                                               | 进行中                                |

**验收命令**（契约工具自己拉起被测实现并注入夹具库，无需手工准备数据库）：

```bash
npm run rr:build
npm run contract:compare -- --serve-npm rr:start --only "auth.,access-info."
```

**路由组织**：各批次只改自己的片段文件（`app/routes.tasks.ts` / `routes.people.ts` / `routes.reports.ts`），由 `app/routes.ts` 统一展开——并行迁移不会争抢同一文件。共享辅助函数在 `app/lib/{http,session,db,tasks}.server.ts`。

**RR8 的三条硬约束（迁移时踩到才明确）**

1. **`action` 负责该路径的所有非 GET 方法**：`PATCH /api/todos/:id` 与 `DELETE /api/todos/:id` 必须写在同一个路由文件里、在 `action` 内按 `request.method` 分派；拆成两个文件会互相覆盖。
2. **只含服务端代码的模块必须用 `.server.ts` 后缀**，否则构建报 `Server-only module referenced by client`（客户端包会试图引入 `node:sqlite`、`node:crypto`）。资源路由只跑在服务端，可放心导入这些模块。
3. **`db.prepare(...)` 的参数类型是 `SQLInputValue[]`**，不接受 `unknown[]`，helper 内需显式 cast（`params as SQLInputValue[]`）。

**工具侧已修的坑**：`build/server/index.js` 只导出请求处理器、单独运行会立即退出（exit 0），必须由 `react-router-serve` 监听端口 → 新增 `--serve-npm <脚本名>`；Windows 下 spawn `.cmd` 需要 `shell:true`，于是 `stop()` 改用 `taskkill /T` 杀整棵进程树，否则孙进程会继续占用夹具 SQLite 导致清理失败。

### Phase 3 · 前端迁移（预计 1.5–2 天）

8 个页面搬到文件路由；`apiClient` 的职责拆给 loader/action；表单改 action 提交；保留现有 UI 与交互。

**验收**：页面功能与旧版一致（人工逐页走查）；测试重写完成。

### Phase 4 · 切换与归档（预计 0.5 天）

`npm start` 指向新实现；旧 Fastify 实现移入 `_archive/`；README、harness 各文档回写。

**验收**：`npm start` 单进程可用；`data/workbench.sqlite` 的 SHA-256 全程不变；旧实现可一键回退。

## 风险与对策

| 风险                             | 对策                                                                    |
| -------------------------------- | ----------------------------------------------------------------------- |
| 行为静默偏移                     | Phase 0 的 golden 回放是硬门禁，Phase 2 结束前不允许进 Phase 3          |
| 迁移期无法日常使用               | 旧实现保留在 `main` 上直到 Phase 4；新实现在独立分支/目录推进           |
| SSR 引入后 cookie/CSRF 语义变化  | 保持同源 + `SameSite=Lax` + `HttpOnly`；Cookie 逻辑原样复用 `security/` |
| `node:sqlite` 在框架运行时不兼容 | 强制 Node runtime（不用 edge）；Phase 1 就先验证                        |
| 测试重写期间失去保护             | golden 回放 + 现有 16 条测试在新实现上逐步等价替换，不一次性删除        |
| 前端 2,110 行搬出 UI 回归        | 逐页走查清单；不趁机改设计，保持"等价迁移"                              |

## 回退方案

Phase 4 之前，`main` 分支始终是可用的 Fastify 实现；新实现独立推进。若迁移失败或中止，删除新目录即可，`data/` 与线上使用方式不受影响。

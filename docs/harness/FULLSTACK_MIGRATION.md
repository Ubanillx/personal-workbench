# 全栈迁移计划：Fastify SPA+API → React Router 8 framework mode

状态：**已完成**（2026-09-10 立项，2026-09-10 Phase 0–4 全部完成）。项目现在是名副其实的 Node.js 全栈单进程应用：统一路由、服务端取数、一套类型契约、一个启动命令。

> Phase 4 收尾后，旧实现已归档到 `_archive/legacy-fastify/`（含 `ARCHIVE_NOTE.md` 与一键回退步骤），本文保留全过程记录。
>
> **数字口径提示（2026-09-11）**：本文出现的 48 端点 / 139 条契约 / 8 页面 / 38 项冒烟都是迁移时点的口径。
> 随后的**账号密码 + 多组织改造**（见 `ACCOUNTS_AND_ORGS.md`）把端点扩到 65、契约扩到 **311 条**、页面扩到 13、冒烟扩到 79 项；
> 本文不逐处改写，以免破坏"当时证据"的可追溯性。

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

### Phase 1 · 数据与安全层搬迁（已完成 2026-09-10）

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

**两处真实差异（有意保留，Phase 4 统一时需决策）**

1. **owner 校验文案不同源**：旧 `workbench.ts` 的 owner 拦截是「只有主人可以访问此功能」，而旧 `report.ts` 是「只有主人可以执行此操作」。新实现里 `app/lib/session.server.ts` 的 `requireOwner` 用前者，周报域单独用 `requireOwnerForReports` 用后者——**这是刻意的**，否则 6 条周报用例会因文案不一致失败。Phase 4 若要统一文案，必须同时改 golden（属**有意**行为变更，需重新 capture 并在提交信息里说明）。
2. **契约 runner 的上传 mimetype**：runner 用无 type 的 Blob，旧 @fastify/multipart 报 `application/octet-stream`，而 Web `FormData` 的 `File.type` 是空串 → 新实现用 `file.type || "application/octet-stream"` 对齐。

**未覆盖边界（已知，未加用例）**：旧实现由 Fastify 的 `files:1 / fields:10 / parts:20` 限制兜底，超限返回 400 `BAD_REQUEST`「上传内容无法解析」；新实现是"取第一个文件、忽略多余部分"。golden 无用例覆盖此路径，因此**两套实现在该边界上可能不同**——已登记 `TODO-13`。

**验收**：`contract:compare` 对**新**实现回放 100% 一致；`lint`、`typecheck`、`test`、`build` 全绿。

**分批策略（每批独立验收，避免一次性重写 1,400 行）**

| 批次 | 范围                                                   | 用例前缀                                                                 | 状态                        |
| ---- | ------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------- |
| A    | 认证 + 访问信息（4 端点）                              | `auth.` `access-info.`                                                   | ✅ 12/12 一致（2026-09-10） |
| B    | dashboard + 任务全流程 + 评论/时间线 + 通知 + 验收视图 | `dashboard.` `tasks.` `comments.` `activity.` `notifications.` `review.` | ✅ 完成（2026-09-10）       |
| C    | users / todos / notes / files / inbox                  | `users.` `todos.` `notes.` `files.` `inbox.`                             | ✅ 完成（2026-09-10）       |
| D    | reports（multipart 上传 + 文件下载）                   | `reports.`                                                               | ✅ 完成（2026-09-10）       |

**验收命令**（契约工具自己拉起被测实现并注入夹具库，无需手工准备数据库）：

```bash
npm run build
npm run contract:compare -- --serve-npm serve --only "auth.,access-info."
```

**路由组织**：各批次只改自己的片段文件（`app/routes.tasks.ts` / `routes.people.ts` / `routes.reports.ts`），由 `app/routes.ts` 统一展开——并行迁移不会争抢同一文件。共享辅助函数在 `app/lib/{http,session,db,tasks}.server.ts`。

**RR8 的三条硬约束（迁移时踩到才明确）**

1. **`action` 负责该路径的所有非 GET 方法**：`PATCH /api/todos/:id` 与 `DELETE /api/todos/:id` 必须写在同一个路由文件里、在 `action` 内按 `request.method` 分派；拆成两个文件会互相覆盖。
2. **只含服务端代码的模块必须用 `.server.ts` 后缀**，否则构建报 `Server-only module referenced by client`（客户端包会试图引入 `node:sqlite`、`node:crypto`）。资源路由只跑在服务端，可放心导入这些模块。
3. **`db.prepare(...)` 的参数类型是 `SQLInputValue[]`**，不接受 `unknown[]`，helper 内需显式 cast（`params as SQLInputValue[]`）。

**工具侧已修的坑**：`build/server/index.js` 只导出请求处理器、单独运行会立即退出（exit 0），必须由 `react-router-serve` 监听端口 → 新增 `--serve-npm <脚本名>`；Windows 下 spawn `.cmd` 需要 `shell:true`，于是 `stop()` 改用 `taskkill /T` 杀整棵进程树，否则孙进程会继续占用夹具 SQLite 导致清理失败。

### Phase 3 · 前端迁移（已完成 2026-09-10）

8 个页面已从 `web/src/pages`（antd v6 版）搬进 `app/routes/`，用 loader/action + 共享服务取代 `apiClient`，测试体系同步重写。

**完成证据**：`smoke:ui --require-migrated` **8/8 页面**「已完成迁移」且**逐页渲染出夹具数据**（/tasks 逾期任务、/todos 跟进报价、/notes 会议要点、/inbox 粘贴聊天记录、/reports 第八周、/collaboration 长期令牌、/files 报价单模板、/review 任务明细），共 38 项 0 失败；`npm test`（db 7 + 契约 139/139 + 冒烟 38）全过；oxlint 0/0、typecheck（5 个 tsconfig）0 错误、format:check 无漂移；契约对**新旧两套实现**各 139/139。

**页面实测补充**（批次 C 自带，契约覆盖不到 UI）：周报页角色化渲染 27 项、写链路 8/8（建单 → 退回 → 重新上传版本 +1 → 通过 → 下载正文逐字节一致）。

**参考实现已完成（2026-09-10）**：`app/root.tsx`（antd 外壳 + 导航 + 通知 + 退出）、`app/routes/access.tsx`（登录）、`app/routes/logout.ts`、`app/routes/dashboard.tsx`（概览）。验收工具 `npm run smoke:ui` **14/14 通过**：SSR 渲染登录页、登录下发会话、会话对 API 与页面同时生效、外壳含导航与数据、页面 action 新增待办、退出后会话失效。

**Phase 3 的七条约定（后续页面必须照此实现）**

1. **页面路由**：`app/routes/<page>.tsx`，导出 `loader`（取数）、可选 `action`（表单提交）、默认导出的 antd 组件。
2. **取数不绕 HTTP**：loader 直接调用共享服务（`app/lib/<域>.server.ts`），**不要**在前端 fetch 自己的 API；页面与资源路由共用同一份实现，从根上杜绝两套逻辑漂移（参考 `app/lib/dashboard.server.ts`）。
3. **写操作两条合法路径**：① RR8 `<Form method="post">` → 本页 `action` 读 formData → 调共享服务（表单是 form-urlencoded，不能直接打收 JSON 的 API 路由）；② 需要 JSON 响应的交互（如通知已读）用 `fetch("/api/...")`，因为那条 API 已是同一份服务实现。
4. **刷新数据用 `useRevalidator()`**，不要自己再维护一份 state 副本。
5. **认证**：页面用 `requireUserOrRedirect(request)`（未登录重定向 `/access?redirectTo=…`）；API 仍用 `requireAuth/requireOwner`（401/403 JSON）。两者语义不同，不要混用。
6. **索引路由的表单必须带 `?index`**：RR8 的 `<Form>` 会自动补；手写 fetch 时必须自己加，否则会被父级 layout 路由吞掉并返回 405。
7. **`react-router` 与 antd 的同名导出必须起别名**：`Layout`（RR8 的文档布局）与 antd 的 `Layout`、`Form`（RR8 的提交表单）与 antd 的 `Form` 都会冲突。已踩两次：`app/root.tsx` 用 `Layout as AntdLayout`；页面里若要用 antd 的表单能力（`Form.Item` / `onFinish` / `initialValues`），必须 `import { Form as AntdForm }`，并用 `useSubmit()` 驱动提交，例如：
   ```tsx
   const submit = useSubmit();
   <AntdForm onFinish={(values) => submit(values, { method: "post" })}>
     <AntdForm.Item name="title">…</AntdForm.Item>
   </AntdForm>;
   ```
   若不需要 antd 的表单能力，直接用 RR8 的 `<Form method="post">` + 原生 `name` 属性（参考 `app/routes/dashboard.tsx`）。

**接缝**：共享服务只能放在 `app/lib/*.server.ts`（路由文件不得有额外导出）；页面注册在 `app/routes.ts`、导航开关在 `app/root.tsx` 的 `MIGRATED_PATHS`，二者由主线统一维护，页面批次不要改。

**验收**：页面功能与旧版一致（人工逐页走查）；测试重写完成。

### Phase 4 · 切换与归档（已完成 2026-09-10）

`npm start` 指向新实现；旧 Fastify + Vite SPA 实现移入 `_archive/legacy-fastify/`；README 与 harness 各文档回写。

**归档与清理**

| 动作 | 内容                                                                                                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 归档 | `git mv` 到 `_archive/legacy-fastify/`：`server/src/{app.ts,index.ts,routes/}`（5 文件）、`web/`（11 文件）、`shared/{constants/index.ts,types/api.ts,types/auth.ts}`（3 文件），共 **20 文件**                                                                                                                                 |
| 删除 | `dist-server/`（旧 tsc 产物）、`web/dist/`（旧 Vite 产物）——两者都是可重新生成的构建产物，不归档                                                                                                                                                                                                                                |
| 依赖 | 删除 `fastify`、`@fastify/{cookie,cors,helmet,multipart,static}`、`concurrently` → `npm install` 移除 **84 个包**                                                                                                                                                                                                               |
| 脚本 | 删除 `dev:server`、`dev:web`、`build:web`、`build:server`、`typecheck:web`、`rr:dev`、`rr:build`、`rr:start`                                                                                                                                                                                                                    |
| 配置 | `server/src/config/env.ts` 去掉 `webDistPath`/`WEB_DIST_PATH`；`server/tsconfig.json` 去掉 `rootDir`/`outDir` 改 `noEmit: true`；`.env.example` 去掉 `WEB_DIST_PATH`/`API_PROXY_TARGET`；`.gitignore`/`.prettierignore`/`.oxlintrc.json` 去掉 `dist-server/`、`web/dist/`，oxlint 浏览器 override 由 `web/src/**` 改为 `app/**` |

**测试替换（旧测试依赖 Fastify `app.inject()`，必须改写）**

| 测试                           | 处置                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/db/owner-token.test.ts`  | 改为**纯数据层**断言：备份库仍是重置前状态（证明备份发生在撤销之前）、旧令牌/旧会话被撤销、主人名下只剩 1 个可用令牌、助理令牌与会话不受影响                                                                      |
| `test/api/owner-reset.test.ts` | **新增**（脚本 `test:owner`）：端到端验证重置后 HTTP 层真的拒绝旧令牌/旧会话。为此把 `tools/contract/runner.ts` 的 `startServer` 夹具参数放宽为 `Pick<Fixture, "databasePath" \| "uploadsDir">`，可直接吃自定义库 |
| `tools/contract/smoke-ui.ts`   | 默认 `--serve-npm` 由已删除的 `rr:start` 改为 `serve`                                                                                                                                                             |

**过程中发现并修掉的真实缺陷（`npm start`）**

首次按文档跑 `npm start` 时服务起在 **3000** 端口，且可被局域网访问。查 `@react-router/serve` 源码确认两件事：

- `let port = parseNumber(process.env.PORT) ?? await getAvailablePort(3000, process.env.HOST)` —— **没有 `PORT` 时默认 3000；3000 被占用时静默改用随机空闲端口**，不会报错。
- `process.env.HOST ? app.listen(port, HOST) : app.listen(port)` —— **没有 `HOST` 时绑定所有网卡**，不是本机回环。

这与旧实现"默认 `127.0.0.1:17500`"的语义不同。修法是在 `npm start` / `start:lan` 里显式固定：

```text
start     : NODE_ENV=production HOST=127.0.0.1 PORT=17500 npm run serve
start:lan : NODE_ENV=production HOST=0.0.0.0   PORT=17500 npm run serve
```

README 已就此加了显式警告：**不要直接调用 `react-router-serve`**。

**试过但放弃的改动**：为消除启动日志里的 `[MODULE_TYPELESS_PACKAGE_JSON]` 警告，试过给 `package.json` 加 `"type": "module"`。结果是 `server/` 在 `module: NodeNext` 下转为 ESM 语义，13 处相对导入立刻要求显式 `.js` 扩展名（`error TS2835`）。为一个只在启动时重复解析一次的性能提示去改遍服务端导入路径不划算，**已回退**，并把警告登记为 `TECH_DEBT.md` 的 DEBT-17。

**验收（全部完成 2026-09-10）**

| 检查          | 结果                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lint          | `npm run lint` → **0 warning / 0 error**（106 文件）                                                                                                                |
| antd 官方检查 | `npx antd lint app` → Scanned 73 files. **No issues found.**                                                                                                        |
| 类型检查      | `npm run typecheck` → server + tools + app + test 四个工程 **0 错误**                                                                                               |
| 数据库测试    | `npm run test:db` → **7/7**                                                                                                                                         |
| 契约回放      | `npm run test:api` → **139 条全部一致**（现在回放的是唯一的实现）                                                                                                   |
| 重置端到端    | `npm run test:owner` → **1/1**（旧令牌 401、旧会话 401、新令牌 200、助理不受影响）                                                                                  |
| SSR 冒烟      | `npm run test:ui` → **38 项 0 失败**，8/8 页面渲染出真实数据                                                                                                        |
| 构建          | `npm run build` 通过（客户端 98 资产 / 1.43 MB，SSR bundle 229 KB）                                                                                                 |
| 格式化        | `npm run format:check` → 无漂移                                                                                                                                     |
| 正式库安全    | 停旧服务后 `data/workbench.sqlite` = 262144 B / mtime `2026-09-07 17:26:21` / SHA-256 `017B3467…48F403`；新服务启动并处理请求后三项**完全一致**，`data/` 无新增文件 |
| 单进程可用    | `npm start` 后监听 **127.0.0.1:17500**（LAN 地址 `192.168.1.230:17500` 确认不可达）；`/api/health` 返回 `db ready`；未登录 `/` → 302，`/access` → 200               |
| 一键回退      | 见 `_archive/legacy-fastify/ARCHIVE_NOTE.md`「恢复方式」                                                                                                            |

## 风险与对策

| 风险                               | 对策                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------- |
| 行为静默偏移                       | Phase 0 的 golden 回放是硬门禁，Phase 2 结束前不允许进 Phase 3          |
| 迁移期无法日常使用                 | 旧实现保留到 Phase 4 才归档；归档后仍可按 `ARCHIVE_NOTE.md` 一键回退    |
| SSR 引入后 cookie/CSRF 语义变化    | 保持同源 + `SameSite=Lax` + `HttpOnly`；Cookie 逻辑原样复用 `security/` |
| `node:sqlite` 在框架运行时不兼容   | 强制 Node runtime（不用 edge）；Phase 1 就先验证                        |
| 测试重写期间失去保护               | golden 回放 + 原有 16 条测试在新实现上等价替换，不一次性删除            |
| 前端 2,110 行搬出 UI 回归          | 逐页走查清单；不趁机改设计，保持"等价迁移"                              |
| 服务绑定与端口语义被框架默认值改变 | 已在 npm scripts 中显式固定 `HOST`/`PORT`，并在 README 写明原因与后果   |

## 回退方案

旧实现已归档在 `_archive/legacy-fastify/`（20 文件 + `ARCHIVE_NOTE.md`）。需要临时回退时，按该说明把文件拷回原路径并还原
`package.json` 的 fastify 依赖与脚本、`env.ts` 的 `webDistPath`，再 `npm install` + `npm run build:server`。

正式数据库格式未变（`data/workbench.sqlite`，migrations 001–008），两套实现读写同一份库，回退不会丢数据。

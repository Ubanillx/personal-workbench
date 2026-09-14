# AGENTS.md

This file provides guidance to CodeBuddy when working with code in this repository.

个人工作台：单进程本地 Web 应用，数据默认留在本机。深入细节见 `docs/harness/`（操作台），本文只保留上手必需的命令与「大图」。

> 本仓库另有一套常驻规则在 `.codebuddy/rules/`：项目概览与代码规范为 `alwaysApply`，架构 / 数据迁移 / 验证门禁 / antd v6 / WebDAV 按 `description` 按需加载。

## 命令速查

日常启动（先 `nvm use 22.22.2`，Node 必须 >= 22.9.0）：

```bash
npm run dev        # 开发：react-router dev 单进程提供页面 + API，默认 127.0.0.1:5173，热更新
npm start          # 正式：build 后以 127.0.0.1:17500 启动（等价 build + serve）
npm run start:lan  # 同上，但 HOST=0.0.0.0，供局域网成员访问
npm run serve      # 只重启不重建，直接跑 build/ 产物
```

门禁（提交前四项都要过）：

```bash
npm run lint          # oxlint，要求 0 warning / 0 error
npm run typecheck     # server + tools + app + test 四个 tsconfig
npm test              # 依次 test:db → test:webdav → test:api → test:auth → test:ui
npm run build         # 客户端 + SSR 产物到 build/
npx antd lint app     # antd 官方检查，必须 No issues found
npm run format:check  # Prettier 漂移检查
```

测试（`test:api` / `test:auth` / `test:ui` 依赖 `npm run build`，`pretest` 已自动执行）：

```bash
npm run test:db      # 数据层：迁移/备份/密码/自举/周报存储，临时库
npm run test:webdav  # WebDAV 客户端，跑在本地假服务器上
npm run test:api     # 契约回放，逐条对比 test/contract/golden/contract.golden.json
npm run test:auth    # 注册 → 登录 → 强制改密 → 业务端点恢复
npm run test:ui      # SSR 冒烟，逐页渲染真实数据 + 权限边界
```

**跑单个测试文件**：直接用 Node 内置 test runner，`node --import tsx --test test/db/password.test.ts`（放在 `test/db/`、`test/api/`、`test/webdav/` 下的用例都适用）。SSR 冒烟可限定页面：`npm run smoke:ui -- --paths /tasks --require-migrated`。

契约工具（改端点前必看）：

```bash
npm run contract:compare   # 回放比对 golden；不一致不得提交，除非是有意变更
npm run contract:capture   # 确认行为变更后重新录制 golden
npm run contract:fixture   # 生成可直接当 DATABASE_PATH 的临时夹具库
```

运维 CLI（仅限数据所在机器，网页端没有重置他人密码入口）：

```bash
npm run user:list                    # 账号 / 邮箱 / 角色 / 组织
npm run user:passwd -- <用户名>       # 交互式改密，加 --generate 打印随机密码
npm run user:init -- --confirm       # 给仍是 locked$ 的账号生成初始密码
npm run db:backup                    # 备份到 data/backups/，保留最近 5 份
npm run db:rehearse                  # 在库副本上试跑迁移并逐表核对
npm run reports:migrate-webdav       # 把本地老周报推到 NAS 并回写索引（幂等）
```

## 配置与首次运行

配置来自**进程环境变量**，`.env` 只是便利层（被 gitignore，可从 `.env.example` 复制）：**已存在的进程环境变量优先于 `.env`**，因此 `$env:PORT=18000; npm run serve` 这类临时覆盖仍然有效，没有 `.env` 也能启动。`HOST` / `PORT` 由 `npm run serve` 的适配器读取（所以 `serve` 脚本带 `--env-file-if-exists=.env`），其余变量由 `server/src/config/env.ts` 读取。唯一的「秘密」变量是 `WORKBENCH_ADMIN_PASSWORD`，只在 `admin` 还没有密码时自举生效一次。

首次运行：空库启动会幂等自举「默认管理员 `admin` + 默认组织」，用 `admin` 在 `/login` 登录。成员首次使用需先去 `/register` 注册——注册后**没有组织**，只能进 `/join` 提交加入申请，由管理员或该组织管理者审批（或直接拉入）；停用成员会立即撤销其全部会话。

数据位置：`data/workbench.sqlite`（正式库）、`data/backups/`（备份，保留最近 5 份）、`data/uploads/reports/`（**老式**周报正文目录，D-46 起新正文只写 NAS，这里只剩还没被 `reports:migrate-webdav` 搬走的文件）。`_archive/legacy-electron/` 与 `_archive/legacy-fastify/` 是已归档的旧实现，**不要修改、也不要依赖**。

## 架构

单进程 **React Router 8 framework mode**（SSR 页面 + `/api/*` 资源路由）+ **SQLite**（`node:sqlite` 的 `DatabaseSync`）。不存在独立后端进程；Fastify 与 Electron 实现已归档到 `_archive/`，当前代码不依赖它们。

### 目录职责

| 路径            | 职责                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `app/`          | 唯一的 UI + API 层：路由表、页面、antd 外壳、`/api` 资源路由、共享服务 `lib/*.server.ts`           |
| `server/src/`   | 与框架无关的服务端层：SQLite 客户端 / 迁移 / 备份 / 自举、密码与会话安全、配置、CLI、WebDAV 客户端 |
| `shared/`       | 前后端共享的领域类型（仅类型）                                                                     |
| `tools/`        | 构建前处理、契约录制/回放/冒烟、夹具库、迁移演练、假 WebDAV 服务器                                 |
| `test/`         | 数据层、WebDAV 客户端、认证端到端用例                                                              |
| `docs/harness/` | 操作台文档（架构、数据模型、代码规范、账号权限、WebDAV、部署）                                     |

### 请求链路与核心约束

页面 `loader`/`action` 与 `/api/*` 资源路由**共用同一份共享服务**（`app/lib/*.server.ts`），服务再落到 `server/src/db` 与内联 SQL。硬规则：**页面 loader/action 不允许去 fetch 自己的 `/api`**，因此「页面能跑但 API 挂了」这类漂移在结构上不可能出现。

响应统一信封由 `app/lib/http.server.ts` 产出：成功 `{ ok: true, data }`，失败 `{ ok: false, error: { code, message } }`。认证靠 HttpOnly cookie `workbench_session`，命中 `access_sessions`（sha256 存储、可撤销、可过期）。授权用 `requireAuth`（未登录 401）/ `requireManager` / `requireAdmin`（权限不足 403）。

### 路由与 API

`app/routes.ts` 是路由表，按域拆到 `routes.{orgs,people,reports,tasks}.ts`。**只有 loader/action、没有默认导出的资源路由就是 API 端点**；带组件的路由即页面。注意 RR8 里一个 `action` 负责该路径的**所有非 GET 方法**，所以 `PATCH` 与 `DELETE /api/todos/:id` 写在同一个 `api.todos.$id.ts` 里，在 action 内按 `request.method` 分派。新增页面路径必须登记进 `app/root.tsx` 的 `MIGRATED_PATHS`，否则不出现在导航里。

### 数据与权限模型

角色在 `users.role`：**admin**（全局管理员，不隶属组织）/ **manager**（组织管理者）/ **member**。业务数据带 `org_id`，可见范围先按组织切、再按角色切。两条不可违反的边界：

- **跨组织按 id 访问一律 404**（不泄露资源存在性）；同组织但无可见权（别人的私密任务、别人的待办）才返回 403。
- **能看见才改得动**：写操作与读操作共用同一个可见性判据，列表里看不见的接口里也必须改不动。

任务状态不能通过 `PATCH /api/tasks/:id` 修改（`progress`/`status` 返回 `FIELD_FORBIDDEN`），必须走 `progress` / `submit-review` / `approve` / `return`，以保证状态机与通知一致。其中**验收（`approve` / `return`）只允许任务的发布人**（`created_by`，全局管理员兜底），执行者永远不能验收自己负责的任务；判据是 `app/lib/task-permissions.ts` 的 `canReviewTask()`，服务端与页面共用（D-57）。完整权限矩阵见 `docs/harness/ACCOUNTS_AND_ORGS.md` §4/§23/§25。

### 数据库与迁移

正式库 `data/workbench.sqlite`。迁移在 `server/src/db/migrations/00N_*.sql`，由 `migration-runner` 按文件名顺序执行，`schema_migrations` 记录已应用版本。

- **绝不修改已应用的迁移**，只新增下一个编号文件；迁移前会自动在 `data/backups/` 生成快照（`db/client.ts`）。
- 空库启动时会幂等自举：建默认管理员 `admin` 与默认组织；初始密码走 `.env` 的 `WORKBENCH_ADMIN_PASSWORD` 或 `npm run user:init`。

### 前端（antd v6）

`app/root.tsx` 用 `ConfigProvider`（`locale=zh_CN`、`theme.token.colorPrimary=#185fa5`）→ `AntdApp` → `Layout`（Sider + Header 通知铃）包裹整棵树；未入组账号不套工作台壳。反馈组件一律用 `AntdApp.useApp()`，**禁止** `message.success()` 这类静态方法（拿不到主题与 locale）。列表页统一骨架：`PageHeader` → `Card`(`TableToolbar` + `Table`) → 右侧 `FormDrawer`/`Drawer`；表格排版统一走 `dataTable()`（`app/components/table-layout.ts`），不要手写 `scroll.x`。页面 loader 取数走共享服务，写操作走本页 action，刷新用 `useRevalidator()`。

### WebDAV（可选，两个用途、连接口径不同）

- **重要文件**：每个账号在 `/settings → WebDAV` 存自己的连接（`webdav_settings`），仅存 `webdav:<路径>` 索引，不复制文件到本机。
- **周报/总结正文**：只写 NAS，本机不留副本；**共用管理员那份连接**（D-52），**上传根目录按组织配**（D-53，`report_upload_settings`），落点 `<本组织上传根>/<用户名>/<起止日期>/<文件名>`，远端已有文件绝不被覆盖。

部署级地址是 `.env` 的 `WEBDAV_URL`（改完需重启）。不要另找第二份凭据表。契约与冒烟的「远端」是 `tools/webdav/fake-server.ts`，由 `contract:*` / `smoke:ui` 自动拉起并按 `WEBDAV_URL` 注入，**不要**给夹具开本地落盘后门。

## 硬规则（违反会破坏一致性）

**编码与文件**

- 源码只写 TypeScript（`.ts`/`.tsx`/`.mts`），禁止新增 `.js`/`.jsx`/`.cjs`。
- **不要用 PowerShell 文本命令改写仓库文件**：本机 `pwsh` 解析到 Windows PowerShell 5.1，`Get-Content` 默认按 GBK 解码，会把 UTF-8 中文写坏。读写一律用编辑工具；只读命令（`git status`、`npx oxlint`）不受影响。
- 不要用 `Get-Content`/`Set-Content` 处理源码；必须脚本化时用 PowerShell 7 的绝对路径并显式指定 `-Encoding UTF8`。
- 文档统一放 `docs/`，不在项目根目录新增散装 `.md`。

**服务与构建**

- **不要直接调用 `react-router-serve`**：它无 `PORT` 时默认 3000，端口被占用会静默换随机端口，无 `HOST` 时绑定所有网卡。一律走 `npm start` / `start:lan` / `serve`。
- **不要手删 `build/`**：清空本来就是 `react-router build` 的第一步；Windows 上被残留进程占用会 `EBUSY`/`EPERM` 且在编译前中止，`npm run build` 已内建 `tools/build/prebuild.ts` 自动处理。

**改动的连带更新（只改代码不改文档 = 未完成）**

- 改数据库：新增迁移文件 + 同步 `docs/harness/DATA_MODEL.md`。
- 改 API：同步 `docs/harness/ARCHITECTURE.md` 端点清单，在 `tools/contract/cases.ts` 补用例；行为变更先跑 `contract:compare` 看差异，确认后 `contract:capture` 重录 golden。
- 改配置/命令：同步 `docs/harness/README.md` 命令速查与根 `README.md`。
- 改 UI 文案：SSR 冒烟用字符串断言界面，改完 grep `tools/contract/smoke-ui.ts` 里的原句一起更新。
- 改认证/权限：先读 `docs/harness/ACCOUNTS_AND_ORGS.md`。

**已知工具约束**

- TypeScript 是 7.0.2 原生 Go 编译器，经典 compiler API 已不存在，因此 `typescript-eslint` / `knip` / `ts-prune` 都不可用；lint 用 oxlint，格式化用 Prettier，死代码靠人工核对。
- `exactOptionalPropertyTypes: true`：可选 prop 不能显式传 `undefined`，antd 条件样式/状态要用条件展开。

## 部署

Jenkins 构建 → SSH → Linux 目标机 systemd：push `main` → 构建 + 测试 + 打包（内含生产依赖）→ `scp`/`ssh` 调 `deploy.sh deploy`：原子切换 `current` 软链接 → 重启服务 → 探 `/api/ping`（要求 `status=ok` 且 `database.status=ready`），不通过自动回滚。数据与配置在目标机 `shared/`（`data/`、`.env`），不随 release 替换。

```bash
sudo /opt/personal-workbench/bin/deploy.sh status | rollback | logs
```

回滚**只回代码，不回数据库结构**——这条边界必须清楚。完整说明见 `deploy/README-DEPLOY.md`。

<!-- antd-cli setup start -->

## Ant Design CLI Skill

Use the shared Ant Design skill at `.agents/skills/antd/SKILL.md` before working on Ant Design code in this repository.

The skill teaches agents when and how to call `@ant-design/cli` commands such as `antd info`, `antd doc`, `antd demo`, `antd token`, `antd semantic`, and `antd changelog`.

<!-- antd-cli setup end -->

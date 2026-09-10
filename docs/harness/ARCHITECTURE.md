# 目录架构

> 2026-09-10 全栈迁移（Phase 4）后的架构：**单进程 React Router 8 framework mode**，同一进程既渲染 SSR 页面又提供 `/api/*`。

## 顶层目录职责

| 路径                        | 职责                                                                            | 备注                                     |
| --------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------- |
| `app/`                      | **应用主体**：路由、页面、SSR 外壳、`/api` 资源路由、共享服务（`lib/`）         | 唯一的 UI + API 层                       |
| `server/src/`               | 框架无关的服务端层：SQLite 客户端/迁移/备份、令牌与会话安全、配置、CLI          | 不依赖 React Router，可被独立测试        |
| `shared/`                   | 前后端共享的领域类型（仅类型，无运行时逻辑）                                    | 迁移后只剩 `types/domain.ts`             |
| `tools/contract/`           | 契约工具与验收工具：夹具库（3 组织 / 8 账号）、305 条用例、录制、回放、SSR 冒烟 | `npm test` 的主要执行体                  |
| `test/`                     | 数据层测试（密码/账号/迁移/备份）+ 注册登录改密端到端                           | 5 + 1 个测试文件                         |
| `build/`                    | 生产构建产物（客户端 + SSR）                                                    | 构建生成，可安全删除                     |
| `.react-router/`            | RR8 生成的类型（`+types/*`）                                                    | 构建生成，可安全删除                     |
| `data/`                     | 运行时数据：正式库、备份、上传文件                                              | 见 `DATA_MODEL.md`                       |
| `docs/`                     | 项目文档；`docs/harness/` 为操作台                                              | 不往根目录放散装 .md                     |
| `_archive/legacy-electron/` | 已移除的 Electron 实现与旧 JSON 数据                                            | 见其中的 `ARCHIVE_NOTE.md`               |
| `_archive/legacy-fastify/`  | 迁移前的 Fastify 后端 + Vite SPA 实现                                           | 见其中的 `ARCHIVE_NOTE.md`（含回退步骤） |

## app/ 模块职责

| 文件 / 目录                        | 职责                                                                                                                                                                             | 备注                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `root.tsx`                         | antd 外壳：`ConfigProvider`(zh_CN + `#185fa5`) → `AntdApp` → Sider/Menu 导航 + Header 通知/退出                                                                                  | 导航开关 `MIGRATED_PATHS`，新页面在此登记       |
| `routes.ts`                        | 路由表：页面路由 + `api` 资源路由，按域展开片段文件                                                                                                                              | 加路由只改这里与对应文件                        |
| `routes/*.tsx`（10 个）            | 页面：`access`、`dashboard`、`tasks`、`todos`、`notes`、`inbox`、`files`、`collaboration`、`review`、`reports`                                                                   | 每页导出 `loader`（取数）/ 可选 `action`（写）  |
| `routes/logout.ts`                 | `POST /logout`：撤销会话并重定向回登录页                                                                                                                                         | 无 UI                                           |
| `routes/api.*.ts`（39 个）         | **48 个端点**的全部实现（health 2 + workbench 39 + report 7）                                                                                                                    | 每个都是共享服务的薄包装                        |
| `routes.{tasks,people,reports}.ts` | 路由片段：按域声明各自的页面与 API 路由，由 `routes.ts` 展开                                                                                                                     | 分批迁移时避免争抢同一文件                      |
| `lib/*.server.ts`（17 个）         | 共享服务层：`session`、`http`、`db`、`context`、`task-service`、`tasks`、`todos`、`notes`、`records`、`users`、`files`、`review`、`access`、`reports`、`dashboard`、`form`、`ui` | 页面与 API 路由**共用同一份实现**，杜绝两套逻辑 |
| `components/placeholder-page.tsx`  | 迁移期的占位页组件                                                                                                                                                               | 8/8 页面迁移完成后已无页面使用                  |
| `styles/layout.css`                | 结构性辅助类                                                                                                                                                                     | antd 之外的少量样式                             |

## server/src 模块职责

| 文件 / 目录                            | 职责                                                                           | 备注                             |
| -------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------- |
| `runtime.ts`                           | `assertSupportedNodeRuntime()`（>=22.5.0 硬校验）与运行时标签                  |                                  |
| `network.ts`                           | 局域网 IPv4 地址枚举（`getLanIPv4Addresses`）                                  | 供 `/api/access-info` 使用       |
| `config/env.ts`                        | 配置装载（`NODE_ENV/HOST/PORT/DATABASE_PATH/SESSION_COOKIE_NAME/UPLOADS_DIR`） | 只读 `process.env`（见 DEBT-02） |
| `db/client.ts`                         | SQLite 连接（`node:sqlite`）、迁移触发、迁移前自动备份、只读/可写两种打开方式  | 双运行时兼容的 `createRequire`   |
| `db/migration-runner.ts`               | 迁移执行器：读 `schema_migrations` → 按文件名顺序执行未应用迁移                |                                  |
| `db/migrations/*.sql`                  | 8 个版本化迁移（001–008）                                                      | 见 `DATA_MODEL.md`               |
| `db/backup.ts`                         | `backupSqlite` / `backupOpenDatabase`，写入 `data/backups/` 并按 `keep=5` 裁剪 |                                  |
| `db/health.ts`                         | 数据库健康探测（供 `/api/health` 返回 `database.status`）                      |                                  |
| `db/repositories/report-repository.ts` | 周报数据访问（**唯一在用的 repository**）                                      |                                  |
| `db/repositories/*.ts`（其余 5 个）    | 未被引用的旧分层实现                                                           | 见 `DEBT-05`                     |
| `db/json-migration.ts`                 | 一次性 JSON→SQLite 迁移（调用方已归档）                                        | 仅供 `test:db` 的 3 条用例使用   |
| `security/owner-token.ts`              | 主人令牌重置：备份 → 撤销旧令牌/会话 → 生成新令牌（仅 sha256 落库）            |                                  |
| `cli/reset-owner-token.ts`             | `npm run owner:reset` 入口                                                     |                                  |
| `cli/backup-sqlite.ts`                 | `npm run db:backup` 入口                                                       |                                  |

## 请求链路

```
浏览器
  │  cookie: workbench_session（HttpOnly，同源）
  ▼
React Router 8（单进程，react-router-serve 监听 17500）
  ├─ 页面路由（GET）  → loader → app/lib/*.server.ts ─┐
  ├─ 页面 action（POST）→ action → 同一份共享服务 ────┤
  └─ /api/* 资源路由  → loader/action → 薄包装 ───────┤
                                                      ▼
                                     共享服务层（app/lib/*.server.ts）
                                       ├─ 认证：sha256(cookie) 命中 access_sessions（未撤销/未过期/用户启用）
                                       ├─ 授权：requireAuth → 401 UNAUTHENTICATED；requireOwner → 403 FORBIDDEN
                                       ├─ 校验：手写字段校验 → 400 VALIDATION_ERROR；业务冲突 → 400 + 语义 code
                                       └─ 数据：server/src/db 与内联 SQL
                                             └─ node:sqlite (DatabaseSync) → data/workbench.sqlite
```

响应统一信封：成功 `{ ok: true, data: ... }`；失败 `{ ok: false, error: { code, message } }`（由 `app/lib/http.server.ts` 统一产出，
包含 `application/json; charset=utf-8`、去除了 `upgrade-insecure-requests` 的 CSP、`X-Content-Type-Options: nosniff`，不发 HSTS/COOP）。

**架构硬规则**：页面 loader/action 直接调用共享服务，**不允许**去 fetch 自己的 `/api`。API 资源路由与页面共享同一份服务实现，
所以"页面能用但 API 挂了"这类漂移在结构上不可能发生。

## 权限模型（三角色）

| 能力                                 | owner                                    | assistant                                   | viewer                       |
| ------------------------------------ | ---------------------------------------- | ------------------------------------------- | ---------------------------- |
| 登录方式                             | 主人令牌 / 会话                          | 成员令牌 / 会话                             | 查看者令牌 / 会话            |
| 可见任务                             | 全部                                     | **仅自己负责的**（`canView`）               | **负责人是助理的任务**       |
| 创建任务                             | ✅ 可指定负责人                          | ✅ 但负责人强制为自己，`source='assistant'` | ❌ 403「查看者不能创建任务」 |
| 修改任务元信息                       | ✅（`PATCH /api/tasks/:id`，owner only） | ❌                                          | ❌                           |
| 进度 / 提交验收 / 评论               | ✅                                       | ✅（限自己任务）                            | 只读                         |
| 审批 / 退回 / 归档 / 删除            | ✅                                       | ❌                                          | ❌                           |
| 成员管理、访问信息、验收视图、文件库 | ✅                                       | ❌ 403                                      | ❌ 403                       |
| 企微收件箱导入                       | ✅                                       | ✅（限自己）                                | ❌ 403                       |
| 周报                                 | 审批/退回                                | 提交自己的                                  | 依路由判定                   |

补充规则：

- **私密任务**（`tasks.is_private=1`）只能由主人负责，`PATCH` 会校验；由于助理不可能成为其负责人，助理天然看不到。
- **任务状态不能通过 `PATCH` 改**：`progress`/`status` 字段会返回 `FIELD_FORBIDDEN`，必须走 `progress` / `submit-review` / `approve` / `return` 接口，保证状态机与通知一致。

## API 清单（48）

构成：健康检查 2 + workbench 域 39 + report 域 7 = 48，全部由 `app/routes/api.*.ts` 承载。
下表按域分组，括号内为该域端点数。

> 注意：RR8 的 `action` 负责该路径的**所有非 GET 方法**，因此 `PATCH /api/todos/:id` 与 `DELETE /api/todos/:id` 写在同一个
> `api.todos._id.ts` 文件里，在 `action` 内按 `request.method` 分派——**不是**两个文件。

### health（2）

| 方法 | 路径          | 说明                     |
| ---- | ------------- | ------------------------ |
| GET  | `/api/ping`   | 存活探测，不需要令牌     |
| GET  | `/api/health` | 版本、运行时、数据库状态 |

### 认证与访问（4）

| 方法 | 路径               | 说明                     |
| ---- | ------------------ | ------------------------ |
| POST | `/api/auth/access` | 用令牌换取会话 cookie    |
| POST | `/api/auth/logout` | 撤销当前会话并清 cookie  |
| GET  | `/api/auth/me`     | 当前用户                 |
| GET  | `/api/access-info` | 主人可见：端口与访问地址 |

### 仪表盘与任务（18）

| 方法   | 路径                           | 说明                                             |
| ------ | ------------------------------ | ------------------------------------------------ |
| GET    | `/api/dashboard`               | 概览统计                                         |
| GET    | `/api/tasks`                   | 任务列表（`includeArchived`，按角色过滤）        |
| POST   | `/api/tasks`                   | 创建任务                                         |
| PATCH  | `/api/tasks/:id`               | 修改元信息（owner）                              |
| POST   | `/api/tasks/:id/progress`      | 汇报进度                                         |
| POST   | `/api/tasks/:id/submit-review` | 提交验收                                         |
| POST   | `/api/tasks/:id/approve`       | 验收通过（owner）                                |
| POST   | `/api/tasks/:id/return`        | 退回（owner）                                    |
| POST   | `/api/tasks/:id/archive`       | 归档                                             |
| POST   | `/api/tasks/:id/restore`       | 恢复归档                                         |
| DELETE | `/api/tasks/:id`               | 删除                                             |
| GET    | `/api/tasks/:id/comments`      | 评论列表                                         |
| POST   | `/api/tasks/:id/comments`      | 新增评论                                         |
| GET    | `/api/tasks/:id/activity`      | 时间线（`task_events`）                          |
| GET    | `/api/notifications`           | 通知列表                                         |
| POST   | `/api/notifications/read`      | 标记已读（可带 `taskId`）                        |
| GET    | `/api/review`                  | 验收视图（owner，支持 `from/to/ownerId/status`） |
| POST   | `/api/inbox/preview`           | 企微文本解析预览                                 |

### 成员（4）

| 方法  | 路径                   | 说明                                |
| ----- | ---------------------- | ----------------------------------- |
| GET   | `/api/users`           | 成员列表（owner）                   |
| POST  | `/api/users`           | 新建成员并返回一次性令牌（owner）   |
| PATCH | `/api/users/:id`       | 启用/停用（停用即撤销其会话与令牌） |
| POST  | `/api/users/:id/token` | 重新签发成员令牌（owner）           |

### 待办与随手记（8）

| 方法           | 路径             |
| -------------- | ---------------- |
| GET / POST     | `/api/todos`     |
| PATCH / DELETE | `/api/todos/:id` |
| GET / POST     | `/api/notes`     |
| PATCH / DELETE | `/api/notes/:id` |

### 重要文件（4）

| 方法   | 路径                 | 说明                         |
| ------ | -------------------- | ---------------------------- |
| GET    | `/api/files`         | 列表（`search`、`category`） |
| POST   | `/api/files`         | 收藏文件路径                 |
| POST   | `/api/files/:id/use` | 标记最近使用                 |
| DELETE | `/api/files/:id`     | 删除收藏                     |

### 企微收件箱（1）

| 方法 | 路径                | 说明                                                         |
| ---- | ------------------- | ------------------------------------------------------------ |
| POST | `/api/inbox/import` | 批量导入（指纹去重，`allowDuplicates` 可覆盖，单次上限 100） |

### 周报（7）

| 方法 | 路径                             | 说明                                              |
| ---- | -------------------------------- | ------------------------------------------------- |
| GET  | `/api/reports`                   | 列表（按角色与筛选条件）                          |
| GET  | `/api/reports/:id`               | 详情                                              |
| POST | `/api/reports`                   | 创建并提交                                        |
| POST | `/api/reports/:id/file`          | 上传新版本文件（`.xlsx/.xls/.docx/.doc`，≤20 MB） |
| POST | `/api/reports/:id/approve`       | 审批通过（owner）                                 |
| POST | `/api/reports/:id/return`        | 退回（owner）                                     |
| GET  | `/api/reports/:id/file/:version` | 下载指定版本（`filename*=UTF-8''` 编码中文名）    |

## 前端结构

UI 层统一使用 **antd v6**（`antd@6.6.3` + `@ant-design/icons@6.3.4`）：`app/root.tsx` 用 `ConfigProvider`（`locale=zh_CN`、`theme.token.colorPrimary=#185fa5`）与 `AntdApp` 包裹整棵树，反馈组件一律走 `AntdApp.useApp()`。组件 API 规范、v6 差异清单与 `antd lint` 门禁见 `CODE_STYLE.md` 第 10 节。

| 文件                                    | 职责                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `app/root.tsx`                          | 入口外壳：`ConfigProvider`(zh_CN + 主题) → `AntdApp` → antd `Layout`（Sider 导航 + Header 通知/用户/退出）+ `Outlet` |
| `app/routes.ts`                         | 路由表：页面 + `api` 资源路由，按域展开                                                                              |
| `app/routes/access.tsx`                 | 令牌登录页（`POST` 到本页 action → 下发会话 Cookie → 重定向）                                                        |
| `app/routes/dashboard.tsx`              | 首页概览（Card + Statistic + List；含快捷新增待办表单）                                                              |
| `app/routes/tasks.tsx`                  | 任务列表/详情/时间线/评论/进度（591 行，最重的页面）                                                                 |
| `app/routes/reports.tsx`                | 周报提交、上传新版本、审批/退回、下载（480 行）                                                                      |
| `app/routes/{todos,notes}.tsx`          | 待办与随手记（列表 + 行内编辑 + 删除）                                                                               |
| `app/routes/{inbox,files}.tsx`          | 企微收件箱（粘贴解析 → 批量导入）与重要文件库                                                                        |
| `app/routes/{collaboration,review}.tsx` | 成员管理与长期令牌；验收视图（owner）                                                                                |
| `app/lib/*.server.ts`                   | 共用的 UI 辅助与页面级数据整形（`ui.server.ts`）                                                                     |
| `app/components/placeholder-page.tsx`   | 迁移期占位页组件；8/8 页面迁移完成后已无页面使用                                                                     |
| `app/styles/layout.css`                 | 结构性辅助类（antd 之外的少量样式）                                                                                  |

**页面实现的七条约定**（完整说明与代码示例见 `FULLSTACK_MIGRATION.md` Phase 3）：loader 取数不绕 HTTP；写操作走本页 `action` 或
已共享同一份实现的 `/api`；刷新用 `useRevalidator()`；页面用 `requireUserOrRedirect`、API 用 `requireAuth/requireOwner`；
索引路由表单必须带 `?index`；`react-router` 与 antd 的同名导出（`Layout`、`Form`）必须起别名。

## 已知架构不一致

1. **两套数据访问风格（已消除）**：旧 `report.ts` 用 repository 类、旧 `workbench.ts` 全内联 SQL 的分裂，随 Phase 4 归档消失；
   当前 `app/lib/*.server.ts` 是唯一数据访问路径。残留的 5 个无人引用 repository 文件见 `DEBT-05`。
2. **端点粒度不一致（已消除）**：旧 39 个端点挤在单文件 `workbench.ts` 的问题由 RR8 文件路由自然拆成 39 个 `api.*.ts`。
3. **空目录（已修复）**：`server/src/{middleware,utils}`、`test/{unit,fixtures}`、`web/src/components` 已在 Phase 4 删除（`DEBT-11`）。
4. **`app/components/placeholder-page.tsx` 已成为死代码**：8/8 页面迁移完成后没有页面再引用它，保留仅作为后续新增页面的起点。

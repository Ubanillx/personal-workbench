# 目录架构

## 顶层目录职责

| 路径                        | 职责                                                           | 备注                       |
| --------------------------- | -------------------------------------------------------------- | -------------------------- |
| `server/`                   | Node + Fastify 后端（TypeScript，编译到 `dist-server/`）       | 唯一的生产进程             |
| `web/`                      | React + Vite 前端 SPA（源码 `web/src`，构建产物 `web/dist`）   | 生产由后端静态托管         |
| `shared/`                   | 前后端共享的领域类型与常量（仅类型，无运行时逻辑）             | 2,430 字符                 |
| `test/`                     | 测试（`db/` 数据库、`integration/` 接口契约、`web/` 前端基础） | 16 个用例                  |
| `data/`                     | 运行时数据：正式库、备份、上传文件                             | 见 `DATA_MODEL.md`         |
| `docs/`                     | 项目文档；`docs/harness/` 为操作台                             | 不往根目录放散装 .md       |
| `_archive/legacy-electron/` | 已移除的 Electron 实现与旧 JSON 数据                           | 见其中的 `ARCHIVE_NOTE.md` |
| `dist-server/`              | 后端编译产物                                                   | 构建生成，可安全删除       |
| `web/dist/`                 | 前端构建产物                                                   | 构建生成，可安全删除       |

## server/src 模块职责

| 文件 / 目录                            | 职责                                                                                                               | 备注                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `index.ts`                             | 进程入口：校验 Node 版本 → 载入配置 → `buildApp` → 监听端口 → 打印本机/局域网地址                                  | 2,392 B                                    |
| `app.ts`                               | Fastify 组装：helmet/CSP、cookie、multipart(20MB)、非生产环境 CORS、路由注册、生产环境静态托管 SPA、404 与错误处理 | 5,242 B                                    |
| `runtime.ts`                           | `assertSupportedNodeRuntime()`（>=22.5.0 硬校验）与运行时标签                                                      |                                            |
| `network.ts`                           | 局域网 IPv4 地址枚举（`getLanIPv4Addresses`）                                                                      | 409 B                                      |
| `config/env.ts`                        | 配置装载（`NODE_ENV/HOST/PORT/DATABASE_PATH/WEB_DIST_PATH/SESSION_COOKIE_NAME/UPLOADS_DIR`）                       | 只读 `process.env`                         |
| `routes/health.ts`                     | `GET /api/ping`、`GET /api/health`                                                                                 |                                            |
| `routes/workbench.ts`                  | **39 个端点**：认证、仪表盘、任务全流程、评论/时间线、通知、成员、待办、随手记、重要文件、验收、企微收件箱         | 1,026 行 / 44,262 B（2026-09-10 已格式化） |
| `routes/report.ts`                     | **7 个端点**：周报提交/查询/上传/审批/退回/下载                                                                    | 381 行 / 16,709 B，使用 `ReportRepository` |
| `db/client.ts`                         | SQLite 连接（`node:sqlite`）、pragma、迁移触发、迁移前自动备份、只读/可写两种打开方式                              |                                            |
| `db/migration-runner.ts`               | 迁移执行器：读 `schema_migrations` → 按文件名顺序执行未应用迁移                                                    |                                            |
| `db/migrations/*.sql`                  | 8 个版本化迁移（001–008）                                                                                          | 见 `DATA_MODEL.md`                         |
| `db/backup.ts`                         | `backupSqlite` / `backupOpenDatabase`，写入 `data/backups/` 并按 `keep=5` 裁剪                                     |                                            |
| `db/health.ts`                         | 数据库健康探测（供 `/api/health` 返回 `database.status`）                                                          |                                            |
| `db/repositories/report-repository.ts` | 周报数据访问（**唯一在用的 repository**）                                                                          |                                            |
| `db/repositories/*.ts`（其余 5 个）    | 未被引用的旧分层实现                                                                                               | 见 `DEBT-05`                               |
| `db/json-migration.ts`                 | 一次性 JSON→SQLite 迁移（调用方已归档）                                                                            | 生产死代码                                 |
| `security/owner-token.ts`              | 主人令牌重置：备份 → 撤销旧令牌/会话 → 生成新令牌（仅 sha256 落库）                                                |                                            |
| `cli/reset-owner-token.ts`             | `npm run owner:reset` 入口                                                                                         |                                            |
| `cli/backup-sqlite.ts`                 | `npm run db:backup` 入口                                                                                           |                                            |
| `middleware/`、`utils/`                | **空目录**（无文件）                                                                                               | 见 `DEBT-11`                               |

## 请求链路

```
浏览器 (SPA)
  │  cookie: workbench_session（HttpOnly，同源）
  ▼
Fastify (app.ts)
  ├─ 生产环境：@fastify/static 托管 web/dist；"/" 与 SPA 路由回退到 index.html
  ├─ 非生产环境：CORS 全开（供 5173 Vite 预览跨源调用）
  └─ /api/*  → 路由处理器
        ├─ 认证：auth() 用 sha256(cookie) 命中 access_sessions（未撤销/未过期/用户启用）
        ├─ 授权：require() → 401 UNAUTHENTICATED；requireOwner() → 403 FORBIDDEN
        ├─ 校验：手写字段校验 → 400 VALIDATION_ERROR；业务冲突 → 400 + 语义 code
        └─ 数据：workbench.ts 内联 SQL ／ report.ts 走 ReportRepository
              └─ node:sqlite (DatabaseSync) → data/workbench.sqlite
```

响应统一信封：成功 `{ ok: true, data: ... }`；失败 `{ ok: false, error: { code, message } }`。
`index.ts` 启动时按 `HOST` 决定绑定地址，并在日志中打印 `http://127.0.0.1:<port>` 与检测到的局域网地址（不带令牌）。

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

构成：健康检查 2 + `workbench.ts` 39 + `report.ts` 7 = 48。下表按域分组，括号内为该域端点数。

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

| 文件                                          | 职责                                                      |
| --------------------------------------------- | --------------------------------------------------------- |
| `web/src/main.tsx` / `App.tsx`                | 入口、路由与鉴权外壳；30 秒轮询通知                       |
| `web/src/services/apiClient.ts`               | 统一 API 客户端（214 行），所有请求与错误归一化的唯一出口 |
| `web/src/pages/DashboardPage.tsx`             | 首页概览                                                  |
| `web/src/pages/WorkbenchPages.tsx`            | 任务列表/详情/时间线、待办、随手记（592 行）              |
| `web/src/pages/MorePages.tsx`                 | 成员管理、文件库、收件箱、验收视图等（645 行）            |
| `web/src/pages/ReportsPage.tsx`               | 周报提交与审批                                            |
| `web/src/styles/global.css`                   | 全局样式（840 行）                                        |
| `web/src/components/`、`web/src/types/api.ts` | 组件目录为空；types 仅含健康检查类型                      |

## 已知架构不一致

1. **两套数据访问风格**：`report.ts` 用 repository 类，`workbench.ts` 全部内联 SQL，而同表的 repository 文件无人使用（`DEBT-10`）。
2. **端点集中于单文件**：39 个端点、权限判断、SQL 全在 `workbench.ts`，与 `report.ts` 的拆分粒度不一致（`DEBT-06`）。
3. **空目录暗示了不存在的分层**：`middleware/`、`utils/`、`components/`（`DEBT-11`）。

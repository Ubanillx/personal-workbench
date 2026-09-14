# 目录架构

> 2026-09-10 全栈迁移（Phase 4）+ 2026-09-11 账号密码 & 多组织改造后的架构：
> **单进程 React Router 8 framework mode**，同一进程既渲染 SSR 页面又提供 `/api/*`；所有业务数据按 `org_id` 做组织隔离。

## 顶层目录职责

| 路径                        | 职责                                                                            | 备注                                     |
| --------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------- |
| `app/`                      | **应用主体**：路由、页面、SSR 外壳、`/api` 资源路由、共享服务（`lib/`）         | 唯一的 UI + API 层                       |
| `server/src/`               | 框架无关的服务端层：SQLite 客户端/迁移/备份、账号密码与会话安全、配置、CLI      | 不依赖 React Router，可被独立测试        |
| `shared/`                   | 前后端共享的领域类型（仅类型，无运行时逻辑）                                    | 迁移后只剩 `types/domain.ts`             |
| `tools/contract/`           | 契约工具与验收工具：夹具库（3 组织 / 8 账号）、378 条用例、录制、回放、SSR 冒烟 | `npm test` 的主要执行体                  |
| `test/`                     | 数据层测试（密码/账号/迁移/备份/自举）+ WebDAV 客户端 + 注册登录改密端到端      | 8 个测试文件                             |
| `build/`                    | 生产构建产物（客户端 + SSR）                                                    | 构建生成，可安全删除                     |
| `.react-router/`            | RR8 生成的类型（`+types/*`）                                                    | 构建生成，可安全删除                     |
| `data/`                     | 运行时数据：正式库、备份、上传文件                                              | 见 `DATA_MODEL.md`                       |
| `docs/`                     | 项目文档；`docs/harness/` 为操作台                                              | 不往根目录放散装 .md                     |
| `_archive/legacy-electron/` | 已移除的 Electron 实现与旧 JSON 数据                                            | 见其中的 `ARCHIVE_NOTE.md`               |
| `_archive/legacy-fastify/`  | 迁移前的 Fastify 后端 + Vite SPA 实现                                           | 见其中的 `ARCHIVE_NOTE.md`（含回退步骤） |

## app/ 模块职责

| 文件 / 目录                        | 职责                                                                                                                                                                                                                                                    | 备注                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `root.tsx`                         | antd 外壳：`ConfigProvider`(zh_CN + `#185fa5`) → `AntdApp` → Sider/Menu 导航 + Header 通知/退出；未入组普通账号不套工作台壳，直接渲染全屏页                                                                                                             | 导航开关 `MIGRATED_PATHS`，新页面在此登记       |
| `routes.ts`                        | 路由表：页面路由 + `api` 资源路由，按域展开片段文件                                                                                                                                                                                                     | 加路由只改这里与对应文件                        |
| `routes/*.tsx`（12 个）            | 页面：`login`、`register`、`password`、`join`、`settings`、`dashboard`、`tasks`、`todos`、`notes`、`files`、`review`、`reports`                                                                                                                         | 每页导出 `loader`（取数）/ 可选 `action`（写）  |
| `routes/logout.ts`                 | `POST /logout`：撤销会话并重定向回登录页                                                                                                                                                                                                                | 无 UI                                           |
| `routes/api.*.ts`（53 个）         | **66 个端点**的全部实现（按域分组见「API 清单」）                                                                                                                                                                                                       | 每个都是共享服务的薄包装                        |
| `routes.{tasks,people,reports}.ts` | 路由片段：按域声明各自的页面与 API 路由，由 `routes.ts` 展开                                                                                                                                                                                            | 分批迁移时避免争抢同一文件                      |
| `lib/*.server.ts`（21 个）         | 共享服务层：`session`、`http`、`db`、`context`、`task-service`、`tasks`、`todos`、`notes`、`records`、`organization`、`files`、`webdav`、`webdav-settings`、`report-storage`、`review`、`access`、`reports`、`dashboard`、`notifications`、`form`、`ui` | 页面与 API 路由**共用同一份实现**，杜绝两套逻辑 |
| `components/placeholder-page.tsx`  | 迁移期的占位页组件                                                                                                                                                                                                                                      | 13 个页面全部自实现后已无引用                   |
| `styles/layout.css`                | 结构性辅助类                                                                                                                                                                                                                                            | antd 之外的少量样式                             |

## server/src 模块职责

| 文件 / 目录                                       | 职责                                                                                                                      | 备注                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `runtime.ts`                                      | `assertSupportedNodeRuntime()`（>=22.9.0 硬校验，由 `appConfig()` 调用）与运行时标签                                      |                                                 |
| `network.ts`                                      | 局域网 IPv4 地址枚举（`getLanIPv4Addresses`）                                                                             | 供 `/api/access-info` 使用                      |
| `config/env.ts`                                   | 配置装载（`NODE_ENV/HOST/PORT/DATABASE_PATH/SESSION_COOKIE_NAME/UPLOADS_DIR/WEBDAV_URL`）+ `loadDotEnv()` 自动加载 `.env` | 进程环境变量**优先于** `.env`（DEBT-02 已修复） |
| `db/client.ts`                                    | SQLite 连接（`node:sqlite`）、迁移触发、迁移前自动备份、只读/可写两种打开方式                                             | 双运行时兼容的 `createRequire`                  |
| `db/migration-runner.ts`                          | 迁移执行器：读 `schema_migrations` → 按文件名顺序执行未应用迁移                                                           |                                                 |
| `db/migrations/*.sql`                             | 14 个版本化迁移（001–014）                                                                                                | 见 `DATA_MODEL.md`                              |
| `db/backup.ts`                                    | `backupSqlite` / `backupOpenDatabase`，写入 `data/backups/` 并按 `keep=5` 裁剪                                            |                                                 |
| `db/health.ts`                                    | 数据库健康探测（供 `/api/health` 返回 `database.status`）                                                                 |                                                 |
| `db/bootstrap.ts`                                 | 启动自举：保证「有全局管理员 + 有默认组织」，幂等且不碰已有数据                                                           | 见 `ACCOUNTS_AND_ORGS.md` §16                   |
| `db/repositories/task-repository.ts`              | 遗留分层实现，仅被 `test/db/json-migration.test.ts` 引用（无生产调用）                                                    | 见 `DEBT-05`                                    |
| `db/json-migration.ts`                            | 一次性 JSON→SQLite 迁移（调用方已归档）                                                                                   | 仅供 `test:db` 的用例使用                       |
| `security/password.ts`                            | scrypt 哈希/校验、`locked$` 占位语义、随机初始密码生成                                                                    | 参数 `N=16384,r=8,p=1`，keylen 64               |
| `security/account.ts`                             | 账号运维（列表/改密/批量初始化），**仅本机 CLI 可达**                                                                     | 网页端无重置他人密码入口                        |
| `webdav/client.ts`                                | 极简 WebDAV 客户端（`PROPFIND`/`PUT`/`MKCOL` + 条件 PUT + `GET` 流式），仅 Node 内置 fetch                                | 见 [`WEBDAV.md`](WEBDAV.md)                     |
| `cli/{list-users,set-password,init-passwords}.ts` | `npm run user:list` / `user:passwd` / `user:init` 入口                                                                    | 共用 `cli/support.ts`                           |
| `cli/backup-sqlite.ts`                            | `npm run db:backup` 入口                                                                                                  |                                                 |

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
                                       ├─ 授权：requireAuth → 401 UNAUTHENTICATED；requireAdmin / requireManager → 403 FORBIDDEN
                                       ├─ 校验：手写字段校验 → 400 VALIDATION_ERROR；业务冲突 → 400 + 语义 code
                                       └─ 数据：server/src/db 与内联 SQL
                                             └─ node:sqlite (DatabaseSync) → data/workbench.sqlite
```

响应统一信封：成功 `{ ok: true, data: ... }`；失败 `{ ok: false, error: { code, message } }`（由 `app/lib/http.server.ts` 统一产出，
包含 `application/json; charset=utf-8`、去除了 `upgrade-insecure-requests` 的 CSP、`X-Content-Type-Options: nosniff`，不发 HSTS/COOP）。

**架构硬规则**：页面 loader/action 直接调用共享服务，**不允许**去 fetch 自己的 `/api`。API 资源路由与页面共享同一份服务实现，
所以"页面能用但 API 挂了"这类漂移在结构上不可能发生。

## 权限模型（三角色 + 组织隔离）

角色在 `users.role` 上：**admin**（全局管理员，不隶属组织）、**manager**（组织管理者）、**member**（组织成员）。
业务数据带 `org_id`，可见范围先按组织切、再按角色切。完整矩阵与不变式清单见
[`ACCOUNTS_AND_ORGS.md`](ACCOUNTS_AND_ORGS.md) §4，这里只留速查：

| 能力                           | `admin`                       | `manager`                              | `member`                     |
| ------------------------------ | ----------------------------- | -------------------------------------- | ---------------------------- |
| 查看组织列表                   | 全部（含已归档）              | 全部（可看不可管）                     | 全部 active（申请）          |
| 创建组织 / 恢复归档组织        | ✅                            | ❌                                     | ❌                           |
| 改组织名描述 / 解散本组织      | ✅                            | ✅ 仅本组织                            | ❌                           |
| 审批入组与退出申请 / 拉人入组  | ✅                            | ✅ 仅本组织                            | ❌                           |
| 启用停用成员、改成员角色       | ✅（不能动 admin）            | ✅ 仅本组织                            | ❌                           |
| 任务：查看                     | 全部组织（带筛选器）          | 本组织全部                             | 本组织全部非私密任务         |
| 任务：创建并指派负责人         | ✅ 任意组织任意人             | ✅ 本组织                              | 只能建给自己的               |
| 任务：改元信息/归档/删除       | ✅                            | ✅ 本组织（看不见的私密任务除外）      | ❌                           |
| 任务：**验收（通过 / 退回）**  | 全部任务（负责人之外）        | **自己发布的本组织任务**（负责人之外） | ❌                           |
| 私密任务（`is_private=1`）     | ✅ 全部                       | **发布人或负责人才可见**               | **发布人或负责人才可见**     |
| 待办 / 随手记                  | 仅自己的                      | 仅自己的                               | 仅自己的                     |
| 周报：查看                     | ✅ 全部                       | ✅ 本组织全部                          | ✅ 本组织全部                |
| 周报：提交                     | ❌（**D-46 起管理员不提交**） | ✅（只能提交自己的）                   | 只能提交自己的               |
| 周报：审批 / 退回              | ✅ 任意组织                   | ✅ 本组织                              | ❌                           |
| 重要文件：查看/新增/编辑/下载  | ✅ 全部（带筛选器）           | ✅ 本组织（别人的个人文件除外）        | ✅ 本组织自己的 + 组织可见的 |
| 重要文件：删除                 | ✅ 全部                       | ✅ 本组织的组织文件                    | ✅ **自己登记的**            |
| 组织与成员管理页               | ✅ 全部（带筛选器）           | ✅ 本组织                              | ❌                           |
| 企微导入（在「任务进展」页内） | ✅                            | ✅ 本组织                              | ✅ 限自己                    |
| 备份 / CLI / 改任何人的密码    | 只能在本机用 CLI              | ❌                                     | ❌                           |

> 上表是 **D-54 / D-55 / D-57 / D-58（2026-09-14）之后**的口径。逐条差异与判据落点见
> [`ACCOUNTS_AND_ORGS.md`](ACCOUNTS_AND_ORGS.md) §4、§23、§24、§25 与 §26。
> 「重要文件」的两个可见范围：`org`（默认，组织内公开）与 `private`（创建人 + 本组织管理员）。

补充规则：

- **跨组织按 id 访问一律 404**（不是 403），避免泄露资源是否存在。**同组织但没有可见权
  （别人的私密任务、别人的待办）返回 403**。
- **能看见才改得动**：写操作与读操作共用同一个可见性判据（私密任务 / 本人数据），
  不允许出现「列表里看不见、接口里改得动」。
- **任务状态不能通过 `PATCH` 改**：`progress`/`status` 返回 `FIELD_FORBIDDEN`，必须走
  `progress` / `submit-review` / `approve` / `return`，保证状态机与通知一致。
- **任务验收由发布任务的组织管理者执行**（D-58）：`approve` / `return` 要求当前账号是
  本组织 `manager` 且为任务发布人；全局 `admin` 只作应急兜底，**任务的负责人永远不能验收自己负责的任务**。判据是
  [`app/lib/task-permissions.ts`](mdc:app/lib/task-permissions.ts) 的 `canReviewTask()`，
  服务端与页面共用同一份；普通成员被组织管理者指派后进度到 `100%` 自动进入待验收，自己发布并自己执行时可直接完成。
- 组织里**最后一个 `manager`** 不能被停用、退出或降级；`admin` 不能把自己降级（只能本机 CLI 恢复）。

## API 清单（66）

构成：health/认证 8 + 组织与成员 16 + 业务域 42 = 66，全部由 `app/routes/api.*.ts`（53 个文件）承载。
下表按域分组，括号内为该域端点数。

> 注意：RR8 的 `action` 负责该路径的**所有非 GET 方法**，因此 `PATCH /api/todos/:id` 与 `DELETE /api/todos/:id` 写在同一个
> `api.todos.$id.ts` 文件里，在 `action` 内按 `request.method` 分派——**不是**两个文件。

### health（2）

| 方法 | 路径          | 说明                     |
| ---- | ------------- | ------------------------ |
| GET  | `/api/ping`   | 存活探测，不需要登录     |
| GET  | `/api/health` | 版本、运行时、数据库状态 |

### 认证与访问（6）

| 方法 | 路径                 | 说明                          |
| ---- | -------------------- | ----------------------------- |
| POST | `/api/auth/register` | 注册新账号（默认无组织）      |
| POST | `/api/auth/login`    | 用户名密码登录，建会话 cookie |
| POST | `/api/auth/logout`   | 撤销当前会话并清 cookie       |
| GET  | `/api/auth/me`       | 当前用户                      |
| POST | `/api/auth/password` | 修改自己的密码                |
| GET  | `/api/access-info`   | 管理员可见：端口与访问地址    |

### 组织（13）

| 方法   | 路径                             | 说明                                      |
| ------ | -------------------------------- | ----------------------------------------- |
| GET    | `/api/organizations`             | 组织列表（管理员含已归档，成员仅 active） |
| POST   | `/api/organizations`             | 创建组织（仅管理员）                      |
| PATCH  | `/api/organizations/:id`         | 改名称/描述（管理员或本组织管理者）       |
| GET    | `/api/organizations/:id/members` | 组织成员列表                              |
| POST   | `/api/organizations/:id/invite`  | 拉人入组（管理员或本组织管理者）          |
| POST   | `/api/organizations/:id/archive` | 归档组织（管理员）                        |
| POST   | `/api/organizations/:id/restore` | 恢复归档组织（管理员）                    |
| GET    | `/api/join-requests`             | 入组申请列表（管理员/本组织管理者）       |
| POST   | `/api/join-requests`             | 提交入组申请                              |
| DELETE | `/api/join-requests/:id`         | 撤回自己尚未处理的申请                    |
| POST   | `/api/join-requests/:id/approve` | 通过入组申请                              |
| POST   | `/api/join-requests/:id/reject`  | 驳回入组申请                              |
| POST   | `/api/leave-requests`            | 提交退出组织申请                          |

### 成员（3）

| 方法   | 路径               | 说明                                       |
| ------ | ------------------ | ------------------------------------------ |
| GET    | `/api/members`     | 成员列表（管理员看全部，管理者看本组织）   |
| PATCH  | `/api/members/:id` | 启用/停用、改角色（`LAST_MANAGER` 时 400） |
| DELETE | `/api/members/:id` | 移出组织（退回「未加入」）                 |

### 概览与任务（14）

> 站内通知有两条读通道：轮询式的 `GET /api/notifications`（页面/API 通用）与
> 常驻 SSE `GET /api/notifications/stream`（`text/event-stream`，按收件人实时推送）。
> 二者的写入点是同一处 `app/lib/notifications.server.ts` 的 `createNotification`（落库 + 进程内事件总线），
> 前端由 `app/components/notification-bell.tsx` 消费并触发浏览器桌面通知。

| 方法   | 路径                           | 说明                                                     |
| ------ | ------------------------------ | -------------------------------------------------------- |
| GET    | `/api/dashboard`               | 概览统计（只读展板）                                     |
| GET    | `/api/tasks`                   | 任务列表（`includeArchived`、`org`，按角色过滤）         |
| POST   | `/api/tasks`                   | 创建任务                                                 |
| PATCH  | `/api/tasks/:id`               | 修改元信息（状态字段禁止，走专用端点）                   |
| DELETE | `/api/tasks/:id`               | 删除                                                     |
| POST   | `/api/tasks/:id/progress`      | 汇报进度                                                 |
| POST   | `/api/tasks/:id/submit-review` | 提交验收                                                 |
| POST   | `/api/tasks/:id/approve`       | 验收通过（任务发布人；管理员应急兜底；负责人除外；D-58） |
| POST   | `/api/tasks/:id/return`        | 退回（同上，与通过同一道门）                             |
| POST   | `/api/tasks/:id/archive`       | 归档                                                     |
| POST   | `/api/tasks/:id/restore`       | 恢复归档                                                 |
| GET    | `/api/tasks/:id/comments`      | 评论列表                                                 |
| POST   | `/api/tasks/:id/comments`      | 新增评论                                                 |
| GET    | `/api/tasks/:id/activity`      | 时间线（`task_events`）                                  |

### 通知与验收（4）

| 方法 | 路径                        | 说明                                 |
| ---- | --------------------------- | ------------------------------------ |
| GET  | `/api/notifications`        | 通知列表（`?unread=1` 只看未读）     |
| GET  | `/api/notifications/stream` | SSE 实时推送（`text/event-stream`）  |
| POST | `/api/notifications/read`   | 标记已读（可带 `taskId`）            |
| GET  | `/api/review`               | 验收视图（`from/to/ownerId/status`） |

### 待办与随手记（8）

| 方法           | 路径             |
| -------------- | ---------------- |
| GET / POST     | `/api/todos`     |
| PATCH / DELETE | `/api/todos/:id` |
| GET / POST     | `/api/notes`     |
| PATCH / DELETE | `/api/notes/:id` |

### 重要文件（5）

| 方法   | 路径                      | 说明                                                                     |
| ------ | ------------------------- | ------------------------------------------------------------------------ |
| GET    | `/api/files`              | 列表（`search`、`category`）                                             |
| POST   | `/api/files`              | 收藏文件路径                                                             |
| POST   | `/api/files/:id/use`      | 标记最近使用                                                             |
| DELETE | `/api/files/:id`          | 删除收藏                                                                 |
| GET    | `/api/files/:id/download` | 下载远端条目（`webdav:` 路径，流式代理，D-49）；本机路径 400、未配置 503 |

### 企微导入（2，入口在「任务进展」页）

两个端点都从 `/tasks` 页头的「从企微导入」抽屉调用（`app/components/wecom-import-drawer.tsx`）；
功能不再单独占一个导航页面，`/inbox` 只保留一条跳转到 `/tasks` 的重定向（老书签用）。

| 方法 | 路径                 | 说明                                                         |
| ---- | -------------------- | ------------------------------------------------------------ |
| POST | `/api/inbox/preview` | 企微文本解析预览                                             |
| POST | `/api/inbox/import`  | 批量导入（指纹去重，`allowDuplicates` 可覆盖，单次上限 100） |

### WebDAV（2，可选接入）

| 方法 | 路径          | 说明                                                                           |
| ---- | ------------- | ------------------------------------------------------------------------------ |
| GET  | `/api/webdav` | 列远端目录（`?path=`，条目自带可入库的 `filePath`）；当前账号未配 WebDAV → 503 |
| POST | `/api/webdav` | multipart 上传到远端（可选 `register=1` 同时登记索引）                         |

权限与文件库一致（`requireManager`：管理员 / 组织管理者）；细节见 [`WEBDAV.md`](WEBDAV.md)。
周报正文用的连接就是**管理员那份 WebDAV 连接**（`webdav_settings` 里 `role='admin'` 的那一行，D-52），
不在这两个端点里；周报的「上传根目录」**按组织**配置（D-53），由 `/settings?tab=webdav` 的「周报上传」区块维护
（组织管理者改本组织，管理员可切换组织；默认用那份连接的浏览根目录），见 [`REPORTS_WEBDAV.md`](REPORTS_WEBDAV.md)。

### 周报（7）

| 方法 | 路径                             | 说明                                                                                               |
| ---- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| GET  | `/api/reports`                   | 列表（按角色与筛选条件）                                                                           |
| GET  | `/api/reports/:id`               | 详情                                                                                               |
| POST | `/api/reports`                   | 创建并提交（**归属人恒为提交者本人**，不接受 `ownerId`；管理员 403；正文写 NAS，D-46）             |
| POST | `/api/reports/:id/file`          | 上传新版本文件（`.xlsx/.xls/.docx/.doc`，≤20 MB；远端名加 `_v{n}` 后缀，绝不覆盖）                 |
| POST | `/api/reports/:id/approve`       | 审批通过（管理者）                                                                                 |
| POST | `/api/reports/:id/return`        | 退回（管理者）                                                                                     |
| GET  | `/api/reports/:id/file/:version` | 下载指定版本：**服务端流式代理到 NAS**（`filename*=UTF-8''` 编码中文名；老记录回落到本地目录读取） |

周报正文的存储规则（D-46，连接口径见 D-52、目录口径见 D-53）见 [`REPORTS_WEBDAV.md`](REPORTS_WEBDAV.md)：落点
`<本组织的上传根目录>/<登录用户名>/<起止日期>/<原文件名>`，上传根目录在 `/settings → WebDAV → 周报上传` 里选
（组织管理者配本组织、管理员可换组织；默认用共用连接的浏览根目录）。

## 前端结构

UI 层统一使用 **antd v6**（`antd@6.6.3` + `@ant-design/icons@6.3.4`）：`app/root.tsx` 用 `ConfigProvider`（`locale=zh_CN`、`theme.token.colorPrimary=#185fa5`）与 `AntdApp` 包裹整棵树，反馈组件一律走 `AntdApp.useApp()`。组件 API 规范、v6 差异清单与 `antd lint` 门禁见 `CODE_STYLE.md` 第 10 节。

| 文件                                       | 职责                                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `app/root.tsx`                             | 入口外壳：`ConfigProvider`(zh_CN + 主题) → `AntdApp` → antd `Layout`（Sider 导航 + Header 实时通知铃铛/用户/退出）+ `Outlet` |
| `app/routes.ts`                            | 路由表：页面 + `api` 资源路由，按域展开                                                                                      |
| `app/routes/{login,register,password}.tsx` | 用户名密码登录页（`POST` 到本页 action → 建会话 Cookie → 重定向）                                                            |
| `app/routes/dashboard.tsx`                 | 首页概览（只读展板：统计卡 + 状态分布 + 到期任务 + 待办/随手记/文件；无编辑入口）                                            |
| `app/routes/tasks.tsx`                     | 任务列表/详情/时间线/评论/进度，以及**企微导入抽屉**的入口（最重的页面）                                                     |
| `app/components/wecom-import-drawer.tsx`   | 企微导入抽屉：粘贴聊天记录 → 解析 → 逐条校对 → 批量导入（调用 `/api/inbox/*`，导入完回刷任务列表）                           |
| `app/routes/reports.tsx`                   | 周报提交、上传新版本、审批/退回、下载（管理员无上传入口，D-46）                                                              |
| `app/routes/{todos,notes}.tsx`             | 待办与随手记（列表 + 行内编辑 + 删除）                                                                                       |
| `app/routes/files.tsx`                     | 重要文件库（含可选 WebDAV 通道：「选择文件」进表单 +「浏览 WebDAV」选中即登记 / 上传，见 `WEBDAV.md`）                       |
| `app/routes/{settings,join,review}.tsx`    | 设置页（组织/成员/账号 + 每账号一份的 WebDAV 连接 + **按组织**的周报上传目录，按角色显示 Tab）；验收视图                     |
| `app/lib/*.server.ts`                      | 共用的 UI 辅助与页面级数据整形（`ui.server.ts`）                                                                             |
| `app/components/placeholder-page.tsx`      | 迁移期占位页组件；8/8 页面迁移完成后已无页面使用                                                                             |
| `app/styles/layout.css`                    | 结构性辅助类（antd 之外的少量样式）                                                                                          |

**页面实现的七条约定**（完整说明与代码示例见 `FULLSTACK_MIGRATION.md` Phase 3）：loader 取数不绕 HTTP；写操作走本页 `action` 或
已共享同一份实现的 `/api`；刷新用 `useRevalidator()`；页面用 `requireUserOrRedirect`、API 用 `requireAuth / requireManager / requireAdmin`；
索引路由表单必须带 `?index`；`react-router` 与 antd 的同名导出（`Layout`、`Form`）必须起别名。

## 已知架构不一致

1. **两套数据访问风格（已消除）**：旧 `report.ts` 用 repository 类、旧 `workbench.ts` 全内联 SQL 的分裂，随 Phase 4 归档消失；
   当前 `app/lib/*.server.ts` 是唯一生产数据访问路径。仅剩 1 个无生产调用的 repository 文件（`task-repository.ts`，只被 `test:db` 引用）见 `DEBT-05`。
2. **端点粒度不一致（已消除）**：旧 39 个端点挤在单文件 `workbench.ts` 的问题由 RR8 文件路由自然拆开——现为 53 个 `api.*.ts` 承载 66 个端点。
3. **空目录（已修复）**：`server/src/{middleware,utils}`、`test/{unit,fixtures}`、`web/src/components` 已在 Phase 4 删除（`DEBT-11`）。
4. **`app/components/placeholder-page.tsx` 已成为死代码**：8/8 页面迁移完成后没有页面再引用它，保留仅作为后续新增页面的起点。

# 数据架构

> 账号密码 + 多组织改造（`009`/`010`）已在本分支生效：新增 `organizations` 与 `organization_join_requests`，
> `users` 重建（用户名/邮箱/密码哈希/组织归属/强制改密），`task_comments` 与 `notifications` 重建（角色与事件类型的 CHECK 放开），
> 五张业务表补 `NOT NULL org_id`，`access_tokens` 已删除。设计和决策见 `ACCOUNTS_AND_ORGS.md`。

## 存储位置

| 路径                                               | 内容                                       | 是否纳入备份                                           |
| -------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| `data/workbench.sqlite`                            | **正式数据库**（单文件 SQLite，约 332 KB） | ✅ 手动/自动备份                                       |
| `data/backups/workbench-<ISO时间戳>.sqlite.bak`    | 正式库备份，保留最近 5 份                  | 自身即备份                                             |
| `data/uploads/reports/<reportId>/v<版本>.<ext>`    | **老式**周报正文（迁移脚本还没搬走的那些） | ❌ 无备份；D-46 起新正文只写 NAS，本机不再持有唯一副本 |
| `data/workbench.sqlite.before-migration-<ISO>.bak` | 应用新迁移前的自动快照                     | 由 `db/client.ts` 生成，不受 5 份裁剪约束              |

- 时间戳统一为 ISO-8601 UTC 字符串（`new Date().toISOString()`），主键统一 `randomUUID()`（TEXT）。
- 数据库路径由 `DATABASE_PATH` 决定，默认 `data/workbench.sqlite`。

## 表清单（19 张活表 + 14 个迁移）

### 身份、组织与认证（5）

| 表                           | 关键字段                                                                                                           | 说明                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `users`                      | `username` UNIQUE, `email` UNIQUE, `password_hash`, `role(admin/manager/member)`, `org_id`, `must_change_password` | 角色与归属受 CHECK 约束；管理员 `org_id` 为 NULL，其他人**必须**有组织 |
| `organizations`              | `name` UNIQUE, `status(active/archived)`, `created_by`, `archived_at`                                              | 多组织主体；解散 = `archived`（数据保留，管理员可恢复）                |
| `organization_join_requests` | `kind(join/leave/invite)`, `user_id`, `org_id`, `status(pending/approved/rejected/cancelled)`, `decided_by`        | 入组/退组/被拉入的完整台账；部分唯一索引保证「同时只有一个 pending」   |
| `access_sessions`            | `session_hash` UNIQUE, `expires_at`, `revoked_at`                                                                  | 浏览器会话（cookie 值的 sha256），有效期 30 天                         |
| `api_tokens`                 | `token_hash` UNIQUE                                                                                                | ⚠️ 仅由 JSON 迁移代码写入，无路由读取（`DEBT-05`）                     |

> `access_tokens`（用户长期令牌）已在 `010` 迁移中删除：登录改为用户名 + 密码，会话仍走 `access_sessions`。

### 任务（4）

| 表                   | 关键字段                                                                                                                                                | 说明                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `tasks`              | `org_id`, `status`, `priority`, `progress`, `owner_id`, `created_by`, `source`, `is_private`, `archived_at`, `wecom_fingerprint`, `overdue_notified_at` | 主表，见下方状态机                                    |
| `task_progress_logs` | `task_id`, `content`, `progress_snapshot`                                                                                                               | 进度汇报流水（经 `task_id` 归属组织）                 |
| `task_comments`      | `task_id`, `author_role(admin/manager/member)`, `content`                                                                                               | 评论                                                  |
| `task_events`        | `task_id`, `event_type`, `content`                                                                                                                      | 时间线（创建/改派/提交/通过/退回/归档/恢复/调整组织） |

### 协作（1）

| 表              | 关键字段                                                                               | 说明                                                                |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `notifications` | `recipient_id`, `actor_id`, `task_id`, `report_id`, `event_type`, `is_read`, `read_at` | 站内通知，15 种事件类型（含 4 种组织事件），前端经 SSE 实时推送未读 |

### 个人（3）

| 表                | 关键字段                                                                            | 说明                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `todos`           | `org_id`, `owner_id`, `content`, `todo_date`, `is_completed`                        | 待办：**本人数据**（`owner_id` 由迁移 017 加入，管理员也只看自己的）                                     |
| `notes`           | `org_id`, `owner_id`, `content`, `is_pinned`                                        | 随手记：同上                                                                                             |
| `important_files` | `org_id`, `owner_id`, `visibility`, `name`, `file_path`, `category`, `last_used_at` | 重要文件收藏：`visibility` **每条自己选**（`org` = 组织内公开，`private` = 创建人 + 本组织管理员，D-55） |

> `todos` / `notes` 的 `owner_id` 是 D-54 加的：改造前这两张表只有 `org_id`（同组织互相可见），
> 而「随手记」本来就该是私人的。迁移 017 把历史行认领给本组织**最早的启用组织管理者**
> （没有 manager 就回落到最早的启用管理员）；`owner_id` 允许为 NULL 只服务于
> 「老数据 + 当时没有可认领账号」这一种情况，那种行按「不存在」处理（谁都读不到）。
> 刻意**不加外键**：`ALTER TABLE ADD COLUMN` 加不了，归属人账号消失后记录不再属于任何人。

> `important_files` 的 `visibility` / `owner_id` 是 D-55 加的（迁移 018，同一套回填规则）：
> `visibility` 缺省与老数据一律按 `org` 处理（`NULL` 也当 `org`），所以升级后行为零变化；
> `private` 只给**创建人**与**本组织的全局管理员**看，且**归属不可转让**。
> 详见 [`ACCOUNTS_AND_ORGS.md`](ACCOUNTS_AND_ORGS.md) §24。

> `important_files.file_path` 有两种取值，**没有加列、没有迁移**（D-41）：
> 本机绝对路径 / 共享盘路径（`C:\work\x.xlsx`、`\\server\share\...`）原样存；
> 从 WebDAV 选进来的存 `webdav:<相对「浏览根目录」的路径>`（例如 `webdav:报价/2026报价单.xlsx`）。
> 页面按前缀区分两类条目并展示不同的「文件情况」（远端条目会实时探测大小/修改时间/是否还在），
> 详见 [`WEBDAV.md`](WEBDAV.md)。

### 周报（2）

| 表               | 关键字段                                                                                         | 说明                                   |
| ---------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `weekly_reports` | `org_id`, `owner_id`, `period_start/end`, `doc_type`, `status`, `current_version`, `review_note` | 周报主体（经 `report_id` 归属组织）    |
| `report_files`   | `report_id`, `version`, `original_name`, `stored_name`, `size_bytes`, `ext`, `mime_type`         | 文件版本，`UNIQUE(report_id, version)` |

> `report_files.stored_name` 自 **D-46** 起换了值域（**表结构没动**，只换值的含义）：
> 新记录存 `webdav:<相对 WebDAV 服务根的路径>`（含**本组织**的上传根目录，例如
> `webdav:/阿尔法/zhangsan/2026-09-01_2026-09-07/第八周周报.docx`；组织没配目录时就是
> `webdav:/zhangsan/2026-09-01_2026-09-07/第八周周报.docx`，即连接的浏览根，D-53）；
> **没有前缀的值是迁移脚本还没搬到的老记录**，仍指向本机 `data/uploads/reports/<reportId>/v<N>.<ext>`。
> 下载路由按前缀分派（远端流式代理 / 本地文件），见 [`REPORTS_WEBDAV.md`](REPORTS_WEBDAV.md) §3.4 与 §6.3。

### 系统（2）

| 表                  | 关键字段                                         | 说明                                                   |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| `schema_migrations` | `version`（迁移文件名去掉 `.sql`）, `applied_at` | 迁移记账                                               |
| `migration_runs`    | `source_sha256`, `status`, `statistics_json`     | ⚠️ 仅一次性 JSON 迁移使用，现已无生产调用（`DEBT-05`） |

### WebDAV（2）

| 表                       | 关键字段                                                                        | 说明                                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webdav_settings`        | `user_id` PK（→ `users` CASCADE）, `username`, `password`, `root`, `timeout_ms` | 每个账号一份远端连接凭据（「重要文件」用；D-43；地址已按 D-44 上收到环境变量 `WEBDAV_URL`，`011` 建表、`012` 删掉 `url` 列）；`password` 明文，页面只读 `hasPassword`                                                                                                       |
| `report_upload_settings` | `org_id` PK（→ `organizations` CASCADE）, `root`, `updated_by`, `updated_at`    | 每个组织一行：周报正文的**上传根目录**（D-46 建表、D-52 缩表、D-53 改成按组织）。连接不存在这里——它取 `webdav_settings` 里**管理员**那一行；`root` 空串 = 用那份连接的浏览根目录。**没有这一行 = 用默认目录**，照样能交周报；周报上传/下载 503 的唯一条件是「没有可用连接」 |

### 组织隔离落在哪张表

| 方式                        | 表                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 直接有 `org_id`（NOT NULL） | `tasks`、`todos`、`notes`、`important_files`、`weekly_reports`                                                                                     |
| 经父级关联（无 `org_id`）   | `task_progress_logs`/`task_comments`/`task_events` → `tasks`；`report_files` → `weekly_reports`；`notifications` → `recipient_id` → `users.org_id` |

**归属与可见性不是一回事**（D-54 / D-55）：`org_id` 决定「这条数据属于哪个组织」，
而**谁能看见**还要看另一层判据——`tasks.is_private`（私密任务三个可见方）、
`todos.owner_id` / `notes.owner_id`（本人数据）、`important_files.visibility`（**每条自己选**：
组织公开或个人文件）。三者的差别见 `ACCOUNTS_AND_ORGS.md` §4 权限矩阵、§23 与 §24。
两类失败的响应也刻意不同：**跨组织 404、同组织但没权限 403**。

## 状态机与枚举

| 字段                                | 取值                                                                                                                                         | 约束位置                                                                                                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks.status`                      | `todo` → `in_progress` → `pending_review` → `completed`                                                                                      | CHECK 约束；**不能通过 `PATCH` 直接改**，必须走 `progress`/`submit-review`/`approve`/`return` 接口                                                                                                                         |
| `tasks.priority`                    | `P0` / `P1` / `P2`                                                                                                                           | CHECK                                                                                                                                                                                                                      |
| `tasks.progress`                    | 0–100 整数                                                                                                                                   | CHECK                                                                                                                                                                                                                      |
| `tasks.source`                      | `manual` / `wecom` / `api` / `assistant`                                                                                                     | CHECK                                                                                                                                                                                                                      |
| `tasks.is_private`                  | 0/1；为 1 时只有**发布人（`created_by`）、负责人（`owner_id`）、全局管理员**可见                                                             | 应用层校验；写操作与读操作共用同一个 `canView`（D-54，见 `ACCOUNTS_AND_ORGS.md` §23.1）                                                                                                                                    |
| `tasks.archived_at`                 | 非空表示已归档（归档任务不可 `PATCH`，需先 `restore`）                                                                                       | 应用层                                                                                                                                                                                                                     |
| `task_events.event_type`            | `task_created` / `task_reassigned` / `task_submitted` / `task_approved` / `task_returned` / `task_archived` / `task_restored` / `task_moved` | CHECK（`task_moved` 由迁移 013 放开，D-47）                                                                                                                                                                                |
| `notifications.event_type`          | 共 15 种：11 种任务/周报事件 + `org_invited` / `org_join_approved` / `org_join_rejected` / `org_removed`                                     | CHECK（008、009 两次重建后生效）                                                                                                                                                                                           |
| `weekly_reports.status`             | `submitted` / `approved` / `returned`                                                                                                        | CHECK                                                                                                                                                                                                                      |
| `weekly_reports.doc_type`           | `weekly_report` / `summary` / `other`                                                                                                        | CHECK                                                                                                                                                                                                                      |
| `users.role`                        | `admin` / `manager` / `member`                                                                                                               | CHECK；另有两条：`CHECK (role<>'manager' OR org_id IS NOT NULL)`（管理者必须有组织）与 `CHECK (role<>'admin' OR org_id IS NULL)`（管理员不得隶属组织）。**普通成员允许没有组织**（注册后、被解散/移出/退出后都是这个状态） |
| `organizations.status`              | `active` / `archived`（解散 = archived，成员退回未加入，数据保留）                                                                           | CHECK                                                                                                                                                                                                                      |
| `organization_join_requests.kind`   | `join`（申请加入）/ `leave`（申请退出或被移出）/ `invite`（管理者直接拉人）                                                                  | CHECK                                                                                                                                                                                                                      |
| `organization_join_requests.status` | `pending` / `approved` / `rejected` / `cancelled`                                                                                            | CHECK + 部分唯一索引：同一用户同时只能有一个 `pending`                                                                                                                                                                     |

## 外键与删除策略

| 策略                 | 关系                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ON DELETE CASCADE`  | 用户 → 会话；任务 → 进度日志/评论/事件/通知；周报 → 文件；用户 → 通知（收件人）；用户/组织 → 入组申请                                                                                |
| `ON DELETE SET NULL` | 作者/操作人 → 日志/评论/事件/通知的 `author_id`/`actor_id`；`tasks.owner_id`（负责人被删则变为未分配）                                                                               |
| `ON DELETE RESTRICT` | `tasks.created_by`（创建人不可删除）；`tasks`/`todos`/`notes`/`important_files`/`weekly_reports` → `organizations`（有数据的组织删不掉，只能归档）；`users.org_id` → `organizations` |

迁移期间 `PRAGMA foreign_keys = OFF`（004/008/009 采用「建新表→拷贝→换名」重建表），事务结束恢复为 `ON`。

## 迁移机制

1. `db/client.ts` 打开数据库后先比对 `schema_migrations`，若有未应用迁移，先在数据库同目录生成 `.before-migration-<ISO>.bak` 快照。
2. `db/migration-runner.ts` 按文件名排序，逐个执行未应用的 `*.sql`；`version` = 文件名去掉 `.sql`。
3. 整体包在 `BEGIN IMMEDIATE` 事务中；先 `PRAGMA foreign_keys = OFF`，提交后再打开。
4. 失败则 `ROLLBACK` 并恢复 `foreign_keys = ON`，服务启动失败（生产环境直接抛错）。

**硬规则**：迁移一旦被应用就**不允许修改文件内容**；只能新增迁移（见 `DEBT-09`：当前没有内容校验和）。

已有迁移：`001_initial_schema`、`002_indexes`、`003_sessions`、`004_collaboration_workflow`、`005_file_metadata`、`006_task_events`、`007_weekly_reports`、`008_report_notifications`、`009_accounts_and_organizations`（账号密码 + 多组织）、`010_drop_access_tokens`（令牌表退役）、`011_webdav_settings`（WebDAV 配置落库）、`012_webdav_url_from_env`（WebDAV 地址改由 `WEBDAV_URL` 提供，删掉 `webdav_settings.url`）、`013_task_moved_event`（重建 `task_events` 放开 `task_moved`，D-47）、`014_report_upload_settings`（周报正文改存 NAS 的全局单行配置，D-46）、`015_report_upload_shared_connection`（周报上传改为共用管理员那份连接，这张表只剩 `root`，D-52）、`016_report_upload_settings_per_org`（上传目录改为按组织，主键 `org_id`，D-53）。

> `009` 里有一个必须记住的坑：初始组织只在「已存在主人账号」的库上创建（`WHERE u.role='owner' ... LIMIT 1`）。
> 早期写法用子查询取 owner id，在**全新空库**上会得到 NULL 而违反 `created_by NOT NULL`，导致每一次全新初始化都失败。

**全新空库的由谁补组织**：迁移层依旧保持「空库 = 0 账号 0 组织」（不写进迁移，否则会给每个测试/夹具空库插一个 `admin` 账号）。
开箱即用由 `server/src/db/bootstrap.ts` 的自举负责，它在**应用启动、迁移之后**执行，见 `ACCOUNTS_AND_ORGS.md` §16（D-39）：
有管理员没组织就补「默认组织」，两者都没有就建默认管理员 `admin` + 「默认组织」。自举幂等，已有数据的库不会被改动。

## 备份与恢复

| 操作         | 命令                              | 行为                                                                 |
| ------------ | --------------------------------- | -------------------------------------------------------------------- |
| 手动备份     | `npm run db:backup`               | 复制到 `data/backups/workbench-<时间戳>.sqlite.bak`，裁剪到最近 5 份 |
| 重置账号密码 | `npm run user:passwd -- <用户名>` | 本机 CLI 直接改 `password_hash`（**唯一**的重置途径）                |
| 恢复         | 手动                              | 停止服务 → 把目标 `.bak` 覆盖为 `data/workbench.sqlite` → 启动服务   |

`pruneBackups` 只裁剪 `data/backups/` 下的 `*.sqlite.bak`，`data/uploads/` 与 `data/` 根目录下的 `.before-migration-*.bak` 都不受管理（`DEBT-08`）。

## 敏感数据

- 会话**只存 sha256 哈希**（`session_hash`），明文 cookie 值只在创建时下发一次。
- 密码**只存 scrypt 哈希**（格式 `scrypt$N$r$p$salt$hash`），盐与参数都在串里；`locked$` 前缀表示「尚未设置密码」，任何输入都校验失败。
- `webdav_settings.password` 是**例外**：WebDAV 走 Basic 认证需要原文，因此明文存储；它只进 `Authorization` 头，页面与 API 响应只读 `hasPassword`。
- `.env` 会被自动加载（`loadDotEnv`），但**进程环境变量优先**；`.env` 已被 gitignore，不要把密钥提交上去。
- 备份文件、`data/` 目录、上传文件都不应提交到公开仓库（见 `TODO-01` 的 `.gitignore`）。

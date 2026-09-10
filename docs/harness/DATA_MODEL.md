# 数据架构

> 账号密码 + 多组织改造（`009`/`010`）已在本分支生效：新增 `organizations` 与 `organization_join_requests`，
> `users` 重建（用户名/邮箱/密码哈希/组织归属/强制改密），`task_comments` 与 `notifications` 重建（角色与事件类型的 CHECK 放开），
> 五张业务表补 `NOT NULL org_id`，`access_tokens` 已删除。设计和决策见 `ACCOUNTS_AND_ORGS.md`。

## 存储位置

| 路径                                               | 内容                                    | 是否纳入备份                              |
| -------------------------------------------------- | --------------------------------------- | ----------------------------------------- |
| `data/workbench.sqlite`                            | **正式数据库**（单文件 SQLite，256 KB） | ✅ 手动/自动备份                          |
| `data/backups/workbench-<ISO时间戳>.sqlite.bak`    | 正式库备份，保留最近 5 份               | 自身即备份                                |
| `data/uploads/reports/<reportId>/v<版本>.<ext>`    | 周报上传文件                            | ❌ **当前无备份**（`DEBT-08`）            |
| `data/workbench.sqlite.before-migration-<ISO>.bak` | 应用新迁移前的自动快照                  | 由 `db/client.ts` 生成，不受 5 份裁剪约束 |

- 时间戳统一为 ISO-8601 UTC 字符串（`new Date().toISOString()`），主键统一 `randomUUID()`（TEXT）。
- 数据库路径由 `DATABASE_PATH` 决定，默认 `data/workbench.sqlite`。

## 表清单（17 张活表 + 10 个迁移）

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

| 表                   | 关键字段                                                                                                                                                | 说明                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `tasks`              | `org_id`, `status`, `priority`, `progress`, `owner_id`, `created_by`, `source`, `is_private`, `archived_at`, `wecom_fingerprint`, `overdue_notified_at` | 主表，见下方状态机                           |
| `task_progress_logs` | `task_id`, `content`, `progress_snapshot`                                                                                                               | 进度汇报流水（经 `task_id` 归属组织）        |
| `task_comments`      | `task_id`, `author_role(admin/manager/member)`, `content`                                                                                               | 评论                                         |
| `task_events`        | `task_id`, `event_type`, `content`                                                                                                                      | 时间线（创建/改派/提交/通过/退回/归档/恢复） |

### 协作（1）

| 表              | 关键字段                                                                               | 说明                                                     |
| --------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `notifications` | `recipient_id`, `actor_id`, `task_id`, `report_id`, `event_type`, `is_read`, `read_at` | 站内通知，15 种事件类型（含 4 种组织事件），前端轮询未读 |

### 个人（3）

| 表                | 关键字段                                                         | 说明                                       |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| `todos`           | `org_id`, `content`, `todo_date`, `is_completed`, `completed_at` | 待办（改造前是全局共享，现在按组织隔离）   |
| `notes`           | `org_id`, `content`, `is_pinned`                                 | 随手记（同上）                             |
| `important_files` | `org_id`, `name`, `file_path`, `category`, `last_used_at`        | 重要文件收藏（只存路径，不复制文件；同上） |

### 周报（2）

| 表               | 关键字段                                                                                         | 说明                                   |
| ---------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `weekly_reports` | `org_id`, `owner_id`, `period_start/end`, `doc_type`, `status`, `current_version`, `review_note` | 周报主体（经 `report_id` 归属组织）    |
| `report_files`   | `report_id`, `version`, `original_name`, `stored_name`, `size_bytes`, `ext`, `mime_type`         | 文件版本，`UNIQUE(report_id, version)` |

### 系统（2）

| 表                  | 关键字段                                         | 说明                                                   |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| `schema_migrations` | `version`（迁移文件名去掉 `.sql`）, `applied_at` | 迁移记账                                               |
| `migration_runs`    | `source_sha256`, `status`, `statistics_json`     | ⚠️ 仅一次性 JSON 迁移使用，现已无生产调用（`DEBT-05`） |

### 组织隔离落在哪张表

| 方式                        | 表                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 直接有 `org_id`（NOT NULL） | `tasks`、`todos`、`notes`、`important_files`、`weekly_reports`                                                                                     |
| 经父级关联（无 `org_id`）   | `task_progress_logs`/`task_comments`/`task_events` → `tasks`；`report_files` → `weekly_reports`；`notifications` → `recipient_id` → `users.org_id` |

## 状态机与枚举

| 字段                                | 取值                                                                                                                          | 约束位置                                                                                                                                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks.status`                      | `todo` → `in_progress` → `pending_review` → `completed`                                                                       | CHECK 约束；**不能通过 `PATCH` 直接改**，必须走 `progress`/`submit-review`/`approve`/`return` 接口                                                                                                                         |
| `tasks.priority`                    | `P0` / `P1` / `P2`                                                                                                            | CHECK                                                                                                                                                                                                                      |
| `tasks.progress`                    | 0–100 整数                                                                                                                    | CHECK                                                                                                                                                                                                                      |
| `tasks.source`                      | `manual` / `wecom` / `api` / `assistant`                                                                                      | CHECK                                                                                                                                                                                                                      |
| `tasks.is_private`                  | 0/1；为 1 时只有管理员、以及创建它的本组织管理者可见                                                                          | 应用层校验                                                                                                                                                                                                                 |
| `tasks.archived_at`                 | 非空表示已归档（归档任务不可 `PATCH`，需先 `restore`）                                                                        | 应用层                                                                                                                                                                                                                     |
| `task_events.event_type`            | `task_created` / `task_reassigned` / `task_submitted` / `task_approved` / `task_returned` / `task_archived` / `task_restored` | CHECK                                                                                                                                                                                                                      |
| `notifications.event_type`          | 共 15 种：11 种任务/周报事件 + `org_invited` / `org_join_approved` / `org_join_rejected` / `org_removed`                      | CHECK（008、009 两次重建后生效）                                                                                                                                                                                           |
| `weekly_reports.status`             | `submitted` / `approved` / `returned`                                                                                         | CHECK                                                                                                                                                                                                                      |
| `weekly_reports.doc_type`           | `weekly_report` / `summary` / `other`                                                                                         | CHECK                                                                                                                                                                                                                      |
| `users.role`                        | `admin` / `manager` / `member`                                                                                                | CHECK；另有两条：`CHECK (role<>'manager' OR org_id IS NOT NULL)`（管理者必须有组织）与 `CHECK (role<>'admin' OR org_id IS NULL)`（管理员不得隶属组织）。**普通成员允许没有组织**（注册后、被解散/移出/退出后都是这个状态） |
| `organizations.status`              | `active` / `archived`（解散 = archived，成员退回未加入，数据保留）                                                            | CHECK                                                                                                                                                                                                                      |
| `organization_join_requests.kind`   | `join`（申请加入）/ `leave`（申请退出或被移出）/ `invite`（管理者直接拉人）                                                   | CHECK                                                                                                                                                                                                                      |
| `organization_join_requests.status` | `pending` / `approved` / `rejected` / `cancelled`                                                                             | CHECK + 部分唯一索引：同一用户同时只能有一个 `pending`                                                                                                                                                                     |

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

已有迁移：`001_initial_schema`、`002_indexes`、`003_sessions`、`004_collaboration_workflow`、`005_file_metadata`、`006_task_events`、`007_weekly_reports`、`008_report_notifications`、`009_accounts_and_organizations`（账号密码 + 多组织）、`010_drop_access_tokens`（令牌表退役）。

> `009` 里有一个必须记住的坑：初始组织只在「已存在主人账号」的库上创建（`WHERE u.role='owner' ... LIMIT 1`）。
> 早期写法用子查询取 owner id，在**全新空库**上会得到 NULL 而违反 `created_by NOT NULL`，导致每一次全新初始化都失败。

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
- 无 `.env` 实际加载（`DEBT-02`），因此不要把任何密钥写进 `.env` 期待生效。
- 备份文件、`data/` 目录、上传文件都不应提交到公开仓库（见 `TODO-01` 的 `.gitignore`）。

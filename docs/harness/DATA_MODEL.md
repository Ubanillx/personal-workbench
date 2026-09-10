# 数据架构

> **待启用结构（尚未生效）**：账号密码 + 多组织改造的 `009`/`010` 迁移暂存在
> `server/src/db/migrations-pending/`，**正式库仍是下面描述的结构**（16 张活表、迁移 001–008）。
> 那两份迁移会新增 `organizations` 与 `organization_join_requests`、重建 `users`/`task_comments`、
> 给 5 张业务表补 `org_id`、删除 `access_tokens`。看设计看 `ACCOUNTS_AND_ORGS.md`，
> 在副本上演练用 `npm run db:rehearse`。启用（E 阶段）后本文件会整体回写。

## 存储位置

| 路径                                               | 内容                                    | 是否纳入备份                              |
| -------------------------------------------------- | --------------------------------------- | ----------------------------------------- |
| `data/workbench.sqlite`                            | **正式数据库**（单文件 SQLite，256 KB） | ✅ 手动/自动备份                          |
| `data/backups/workbench-<ISO时间戳>.sqlite.bak`    | 正式库备份，保留最近 5 份               | 自身即备份                                |
| `data/uploads/reports/<reportId>/v<版本>.<ext>`    | 周报上传文件                            | ❌ **当前无备份**（`DEBT-08`）            |
| `data/workbench.sqlite.before-migration-<ISO>.bak` | 应用新迁移前的自动快照                  | 由 `db/client.ts` 生成，不受 5 份裁剪约束 |

- 时间戳统一为 ISO-8601 UTC 字符串（`new Date().toISOString()`），主键统一 `randomUUID()`（TEXT）。
- 数据库路径由 `DATABASE_PATH` 决定，默认 `data/workbench.sqlite`。

## 表清单（16 张活表 + 8 个迁移）

### 身份与认证（4）

| 表                | 关键字段                                                  | 说明                                                               |
| ----------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| `users`           | `id`, `name`, `role(owner/assistant/viewer)`, `is_active` | 角色三值受 CHECK 约束                                              |
| `access_tokens`   | `token_hash` UNIQUE, `expires_at`, `revoked_at`           | 用户长期令牌；**只存 sha256 哈希**                                 |
| `access_sessions` | `session_hash` UNIQUE, `expires_at`, `revoked_at`         | 浏览器会话（cookie 值的 sha256），有效期 30 天                     |
| `api_tokens`      | `token_hash` UNIQUE                                       | ⚠️ 仅由迁移代码写入 `legacy-incoming-api`，无路由读取（`DEBT-05`） |

### 任务（4）

| 表                   | 关键字段                                                                                                                                      | 说明                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `tasks`              | `status`, `priority`, `progress`, `owner_id`, `created_by`, `source`, `is_private`, `archived_at`, `wecom_fingerprint`, `overdue_notified_at` | 主表，见下方状态机                           |
| `task_progress_logs` | `task_id`, `content`, `progress_snapshot`                                                                                                     | 进度汇报流水                                 |
| `task_comments`      | `task_id`, `author_role`, `content`                                                                                                           | 评论                                         |
| `task_events`        | `task_id`, `event_type`, `content`                                                                                                            | 时间线（创建/改派/提交/通过/退回/归档/恢复） |

### 协作（1）

| 表              | 关键字段                                                                               | 说明                                    |
| --------------- | -------------------------------------------------------------------------------------- | --------------------------------------- |
| `notifications` | `recipient_id`, `actor_id`, `task_id`, `report_id`, `event_type`, `is_read`, `read_at` | 站内通知，11 种事件类型，前端 30 秒轮询 |

### 个人（3）

| 表                | 关键字段                                               | 说明                                 |
| ----------------- | ------------------------------------------------------ | ------------------------------------ |
| `todos`           | `content`, `todo_date`, `is_completed`, `completed_at` | 待办                                 |
| `notes`           | `content`, `is_pinned`                                 | 随手记                               |
| `important_files` | `name`, `file_path`, `category`, `last_used_at`        | 重要文件收藏（只存路径，不复制文件） |

### 周报（2）

| 表               | 关键字段                                                                                 | 说明                                   |
| ---------------- | ---------------------------------------------------------------------------------------- | -------------------------------------- |
| `weekly_reports` | `owner_id`, `period_start/end`, `doc_type`, `status`, `current_version`, `review_note`   | 周报主体                               |
| `report_files`   | `report_id`, `version`, `original_name`, `stored_name`, `size_bytes`, `ext`, `mime_type` | 文件版本，`UNIQUE(report_id, version)` |

### 系统（2）

| 表                  | 关键字段                                         | 说明                                                   |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| `schema_migrations` | `version`（迁移文件名去掉 `.sql`）, `applied_at` | 迁移记账                                               |
| `migration_runs`    | `source_sha256`, `status`, `statistics_json`     | ⚠️ 仅一次性 JSON 迁移使用，现已无生产调用（`DEBT-05`） |

## 状态机与枚举

| 字段                       | 取值                                                                                                                                                                                                                    | 约束位置                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `tasks.status`             | `todo` → `in_progress` → `pending_review` → `completed`                                                                                                                                                                 | CHECK 约束；**不能通过 `PATCH` 直接改**，必须走 `progress`/`submit-review`/`approve`/`return` 接口 |
| `tasks.priority`           | `P0` / `P1` / `P2`                                                                                                                                                                                                      | CHECK                                                                                              |
| `tasks.progress`           | 0–100 整数                                                                                                                                                                                                              | CHECK                                                                                              |
| `tasks.source`             | `manual` / `wecom` / `api` / `assistant`                                                                                                                                                                                | CHECK                                                                                              |
| `tasks.is_private`         | 0/1；为 1 时负责人必须是主人                                                                                                                                                                                            | 应用层校验                                                                                         |
| `tasks.archived_at`        | 非空表示已归档（归档任务不可 `PATCH`，需先 `restore`）                                                                                                                                                                  | 应用层                                                                                             |
| `task_events.event_type`   | `task_created` / `task_reassigned` / `task_submitted` / `task_approved` / `task_returned` / `task_archived` / `task_restored`                                                                                           | CHECK                                                                                              |
| `notifications.event_type` | 共 11 种：`task_assigned` / `task_reassigned` / `task_commented` / `task_progress` / `task_submitted` / `task_approved` / `task_returned` / `task_overdue` / `report_submitted` / `report_approved` / `report_returned` | CHECK（008 迁移重建后生效）                                                                        |
| `weekly_reports.status`    | `submitted` / `approved` / `returned`                                                                                                                                                                                   | CHECK                                                                                              |
| `weekly_reports.doc_type`  | `weekly_report` / `summary` / `other`                                                                                                                                                                                   | CHECK                                                                                              |
| `users.role`               | `owner` / `assistant` / `viewer`                                                                                                                                                                                        | CHECK                                                                                              |

## 外键与删除策略

| 策略                 | 关系                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `ON DELETE CASCADE`  | 用户 → 令牌/会话；任务 → 进度日志/评论/事件/通知；周报 → 文件；用户 → 通知（收件人）                   |
| `ON DELETE SET NULL` | 作者/操作人 → 日志/评论/事件/通知的 `author_id`/`actor_id`；`tasks.owner_id`（负责人被删则变为未分配） |
| `ON DELETE RESTRICT` | `tasks.created_by`（创建人不可删除，避免丢失归属）                                                     |

迁移期间 `PRAGMA foreign_keys = OFF`（004/008 采用「建新表→拷贝→换名」重建表），事务结束恢复为 `ON`。

## 迁移机制

1. `db/client.ts` 打开数据库后先比对 `schema_migrations`，若有未应用迁移，先在数据库同目录生成 `.before-migration-<ISO>.bak` 快照。
2. `db/migration-runner.ts` 按文件名排序，逐个执行未应用的 `*.sql`；`version` = 文件名去掉 `.sql`。
3. 整体包在 `BEGIN IMMEDIATE` 事务中；先 `PRAGMA foreign_keys = OFF`，提交后再打开。
4. 失败则 `ROLLBACK` 并恢复 `foreign_keys = ON`，服务启动失败（生产环境直接抛错）。

**硬规则**：迁移一旦被应用就**不允许修改文件内容**；只能新增 `009_*.sql`（见 `DEBT-09`：当前没有内容校验和）。

已有迁移：`001_initial_schema`、`002_indexes`、`003_sessions`、`004_collaboration_workflow`、`005_file_metadata`、`006_task_events`、`007_weekly_reports`、`008_report_notifications`。

## 备份与恢复

| 操作         | 命令                               | 行为                                                                 |
| ------------ | ---------------------------------- | -------------------------------------------------------------------- |
| 手动备份     | `npm run db:backup`                | 复制到 `data/backups/workbench-<时间戳>.sqlite.bak`，裁剪到最近 5 份 |
| 重置主人令牌 | `npm run owner:reset -- --confirm` | **先备份**，再撤销主人令牌与会话，生成新令牌（仅终端显示一次）       |
| 恢复         | 手动                               | 停止服务 → 把目标 `.bak` 覆盖为 `data/workbench.sqlite` → 启动服务   |

`pruneBackups` 只裁剪 `data/backups/` 下的 `*.sqlite.bak`，`data/uploads/` 与 `data/` 根目录下的 `.before-migration-*.bak` 都不受管理（`DEBT-08`）。

## 敏感数据

- 令牌与会话**只存 sha256 哈希**（`token_hash`、`session_hash`），明文仅在创建/重置时于终端显示一次。
- 无 `.env` 实际加载（`DEBT-02`），因此不要把任何密钥写进 `.env` 期待生效。
- 备份文件、`data/` 目录、上传文件都不应提交到公开仓库（见 `TODO-01` 的 `.gitignore`）。

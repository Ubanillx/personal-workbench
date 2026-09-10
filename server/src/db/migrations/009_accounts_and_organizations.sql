-- 009_accounts_and_organizations.sql
-- 账号密码 + 多组织改造的数据层。设计见 docs/harness/ACCOUNTS_AND_ORGS.md。
--
-- 本迁移只做结构与归属，**不写任何密码**：旧账号的 password_hash 先放 'locked$' 占位
-- （任何输入都校验失败，见 server/src/security/password.ts），由 `npm run user:init` 生成初始密码。
--
-- 迁移执行器（SqliteMigrationRunner）已在事务外 `PRAGMA foreign_keys = OFF`，
-- 因此这里的 7 次重建表都是安全的；不要在本文件里写 PRAGMA foreign_keys（事务内无效）。

-- ---------------------------------------------------------------- 1. 组织与申请

CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS organization_join_requests (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('join', 'leave', 'invite')),
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  message       TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  decided_at    TEXT,
  decided_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision_note TEXT NOT NULL DEFAULT ''
);

-- 「同时只能有一个待审批申请」（D-30）由部分唯一索引在数据库层强制
CREATE UNIQUE INDEX IF NOT EXISTS idx_join_requests_pending_user
  ON organization_join_requests(user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_join_requests_org_status
  ON organization_join_requests(org_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_join_requests_user
  ON organization_join_requests(user_id, created_at);

-- ---------------------------------------------------------------- 2. 初始组织（D-29）
--
-- 只在「已经存在主人账号」的库上建：全新库（测试用的空库）不该凭空多出一个组织，
-- 而且没有主人时 created_by 会是 NULL，违反 NOT NULL 约束 —— 那会让**每一次全新初始化都失败**。

INSERT INTO organizations (id, name, description, status, created_by, created_at, updated_at, archived_at)
SELECT
  'org-default',
  '默认组织',
  '迁移时自动创建：收纳改造前的全部账号与业务数据，可改名',
  'active',
  u.id,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  NULL
FROM users u
WHERE u.role = 'owner'
  AND NOT EXISTS (SELECT 1 FROM organizations WHERE id = 'org-default')
ORDER BY u.created_at, u.id
LIMIT 1;

-- ---------------------------------------------------------------- 3. 重建 users

CREATE TABLE users_new (
  id                   TEXT PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE,
  email                TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'member')),
  org_id               TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1)),
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  -- 「组织管理者必须有组织」「管理员不得隶属组织」是数据模型级的真不变量，让数据库兜住；
  -- 但**普通成员可以没有组织**：注册（D-20）产生的就是「member + org_id 为 NULL」的账号，
  -- 解散组织（D-33）、被移出组织、同意退出（D-32）也都会把人退回这个状态。
  -- 初版写成 `CHECK (role='admin' OR org_id IS NOT NULL)` 会让上面四条路径全部失败，已改。
  CHECK (role <> 'manager' OR org_id IS NOT NULL),
  CHECK (role <> 'admin' OR org_id IS NULL)
);

INSERT INTO users_new (id, username, email, name, role, org_id, password_hash, must_change_password, is_active, created_at, updated_at)
SELECT
  u.id,
  -- 用户名：主人 → admin；名字是纯 ASCII 合法字符且不与别人重名 → 小写名字；否则用 id 派生（必定合法且唯一）
  CASE
    WHEN u.role = 'owner' THEN 'admin'
    WHEN length(lower(u.name)) BETWEEN 3 AND 32
      AND lower(u.name) NOT GLOB '*[^a-z0-9_-]*'
      AND lower(u.name) <> 'admin'
      AND (SELECT COUNT(*) FROM users u2 WHERE lower(u2.name) = lower(u.name)) = 1
      THEN lower(u.name)
    ELSE 'member-' || substr(replace(u.id, '-', ''), 1, 6)
  END,
  -- 邮箱：用 RFC 2606 保留 TLD，明确表示「占位、不可达」；用户名唯一 ⇒ 邮箱唯一
  (CASE
    WHEN u.role = 'owner' THEN 'admin'
    WHEN length(lower(u.name)) BETWEEN 3 AND 32
      AND lower(u.name) NOT GLOB '*[^a-z0-9_-]*'
      AND lower(u.name) <> 'admin'
      AND (SELECT COUNT(*) FROM users u2 WHERE lower(u2.name) = lower(u.name)) = 1
      THEN lower(u.name)
    ELSE 'member-' || substr(replace(u.id, '-', ''), 1, 6)
  END) || '@local.invalid',
  u.name,
  CASE
    WHEN u.role = 'owner' THEN 'admin'
    -- 组织管理者：改造前创建时间最早的助理（D-29）
    WHEN u.id = (SELECT id FROM users WHERE role = 'assistant' ORDER BY created_at, id LIMIT 1) THEN 'manager'
    ELSE 'member'
  END,
  CASE WHEN u.role = 'owner' THEN NULL ELSE 'org-default' END,
  'locked$',
  1,
  u.is_active,
  u.created_at,
  u.updated_at
FROM users u;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ---------------------------------------------------------------- 4. 重建 task_comments（author_role 的 CHECK 锁死了旧角色）

CREATE TABLE task_comments_new (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT,
  author_role TEXT CHECK (author_role IS NULL OR author_role IN ('admin', 'manager', 'member')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

INSERT INTO task_comments_new (id, task_id, author_id, author_name, author_role, content, created_at)
SELECT
  id, task_id, author_id, author_name,
  CASE author_role
    WHEN 'owner' THEN 'admin'
    WHEN 'assistant' THEN 'member'
    WHEN 'viewer' THEN 'member'
    ELSE author_role
  END,
  content, created_at
FROM task_comments;

DROP TABLE task_comments;
ALTER TABLE task_comments_new RENAME TO task_comments;

CREATE INDEX IF NOT EXISTS idx_task_comments_task_id_created_at ON task_comments(task_id, created_at);

-- ---------------------------------------------------------------- 6. 重建 notifications（event_type 的 CHECK 要容纳组织事件）

CREATE TABLE notifications_new (
  id           TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  task_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  report_id    TEXT REFERENCES weekly_reports(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL CHECK (event_type IN (
    'task_assigned', 'task_reassigned', 'task_commented', 'task_progress',
    'task_submitted', 'task_approved', 'task_returned', 'task_overdue',
    'report_submitted', 'report_approved', 'report_returned',
    'org_invited', 'org_join_approved', 'org_join_rejected', 'org_removed'
  )),
  title        TEXT NOT NULL,
  message      TEXT NOT NULL,
  is_read      INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  created_at   TEXT NOT NULL,
  read_at      TEXT
);

INSERT INTO notifications_new (id, recipient_id, actor_id, task_id, report_id, event_type, title, message, is_read, created_at, read_at)
SELECT id, recipient_id, actor_id, task_id, report_id, event_type, title, message, is_read, created_at, read_at FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_read ON notifications(recipient_id, is_read, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_task ON notifications(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_report ON notifications(report_id);

-- ---------------------------------------------------------------- 5. 五张业务表加 org_id

-- tasks（结构取自 004 的 tasks_new + 006 的 overdue_notified_at）
CREATE TABLE tasks_new (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  priority             TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2')),
  status               TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'pending_review', 'completed')),
  progress             INTEGER NOT NULL CHECK (progress BETWEEN 0 AND 100),
  due_date             TEXT,
  owner_id             TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by           TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source               TEXT NOT NULL CHECK (source IN ('manual', 'wecom', 'api', 'assistant')),
  is_private           INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0, 1)),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  completed_at         TEXT,
  archived_at          TEXT,
  wecom_fingerprint    TEXT,
  overdue_notified_at  TEXT
);

INSERT INTO tasks_new (id, org_id, title, description, priority, status, progress, due_date, owner_id, created_by, source, is_private, created_at, updated_at, completed_at, archived_at, wecom_fingerprint, overdue_notified_at)
SELECT id, 'org-default', title, description, priority, status, progress, due_date, owner_id, created_by, source, is_private, created_at, updated_at, completed_at, archived_at, wecom_fingerprint, overdue_notified_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX IF NOT EXISTS idx_tasks_owner_id ON tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_archived_at ON tasks(archived_at);
CREATE INDEX IF NOT EXISTS idx_tasks_wecom_fingerprint ON tasks(wecom_fingerprint);
CREATE INDEX IF NOT EXISTS idx_tasks_overdue_notify ON tasks(status, due_date, overdue_notified_at);
CREATE INDEX IF NOT EXISTS idx_tasks_org_status_due ON tasks(org_id, status, due_date);

-- todos（改造前没有归属字段，是全局共享的）
CREATE TABLE todos_new (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  content      TEXT NOT NULL,
  todo_date    TEXT,
  is_completed INTEGER NOT NULL DEFAULT 0 CHECK (is_completed IN (0, 1)),
  completed_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

INSERT INTO todos_new (id, org_id, content, todo_date, is_completed, completed_at, created_at, updated_at)
SELECT id, 'org-default', content, todo_date, is_completed, completed_at, created_at, updated_at FROM todos;

DROP TABLE todos;
ALTER TABLE todos_new RENAME TO todos;

CREATE INDEX IF NOT EXISTS idx_todos_date_completed ON todos(todo_date, is_completed);
CREATE INDEX IF NOT EXISTS idx_todos_org_date ON todos(org_id, todo_date);

-- notes
CREATE TABLE notes_new (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  content    TEXT NOT NULL,
  is_pinned  INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO notes_new (id, org_id, content, is_pinned, created_at, updated_at)
SELECT id, 'org-default', content, is_pinned, created_at, updated_at FROM notes;

DROP TABLE notes;
ALTER TABLE notes_new RENAME TO notes;

CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at);
CREATE INDEX IF NOT EXISTS idx_notes_org_created ON notes(org_id, created_at);

-- important_files
CREATE TABLE important_files_new (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name         TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT '',
  last_used_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

INSERT INTO important_files_new (id, org_id, name, file_path, category, last_used_at, created_at, updated_at)
SELECT id, 'org-default', name, file_path, category, last_used_at, created_at, updated_at FROM important_files;

DROP TABLE important_files;
ALTER TABLE important_files_new RENAME TO important_files;

CREATE INDEX IF NOT EXISTS idx_important_files_category ON important_files(category);
CREATE INDEX IF NOT EXISTS idx_important_files_last_used ON important_files(last_used_at);
CREATE INDEX IF NOT EXISTS idx_important_files_org ON important_files(org_id, created_at);

-- weekly_reports
CREATE TABLE weekly_reports_new (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start    TEXT NOT NULL,
  period_end      TEXT NOT NULL,
  doc_type        TEXT NOT NULL CHECK (doc_type IN ('weekly_report', 'summary', 'other')),
  note            TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL CHECK (status IN ('submitted', 'approved', 'returned')),
  current_version INTEGER NOT NULL DEFAULT 1,
  uploaded_by     TEXT NOT NULL,
  review_note     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  submitted_at    TEXT NOT NULL,
  reviewed_at     TEXT,
  returned_at     TEXT
);

INSERT INTO weekly_reports_new (id, org_id, owner_id, period_start, period_end, doc_type, note, status, current_version, uploaded_by, review_note, created_at, updated_at, submitted_at, reviewed_at, returned_at)
SELECT id, 'org-default', owner_id, period_start, period_end, doc_type, note, status, current_version, uploaded_by, review_note, created_at, updated_at, submitted_at, reviewed_at, returned_at
FROM weekly_reports;

DROP TABLE weekly_reports;
ALTER TABLE weekly_reports_new RENAME TO weekly_reports;

CREATE INDEX IF NOT EXISTS idx_weekly_reports_owner ON weekly_reports(owner_id);
CREATE INDEX IF NOT EXISTS idx_weekly_reports_status ON weekly_reports(status);
CREATE INDEX IF NOT EXISTS idx_weekly_reports_org_status ON weekly_reports(org_id, status, created_at);

-- 013_task_moved_event.sql
-- 任务可以更换所属组织（管理员纠正建错组织的任务，见 docs/harness/ACCOUNTS_AND_ORGS.md §14.3），
-- 时间线上需要一种能说清这件事的事件类型。
--
-- `task_events.event_type` 的取值在 006 建表时就用 CHECK 写死了，只有重建表才能放开取值——
-- 与 009 的 7 次重建同一手法；迁移执行器已在事务外 `PRAGMA foreign_keys = OFF`，重建是安全的。
-- 不要在本文件里写 PRAGMA（事务内无效）。

CREATE TABLE task_events_new (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'task_created', 'task_reassigned', 'task_submitted', 'task_approved',
    'task_returned', 'task_archived', 'task_restored', 'task_moved'
  )),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO task_events_new (id, task_id, actor_id, actor_name, event_type, content, created_at)
SELECT id, task_id, actor_id, actor_name, event_type, content, created_at FROM task_events;

DROP TABLE task_events;
ALTER TABLE task_events_new RENAME TO task_events;

CREATE INDEX IF NOT EXISTS idx_task_events_task_created_at ON task_events(task_id, created_at);

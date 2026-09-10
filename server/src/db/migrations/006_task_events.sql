ALTER TABLE tasks ADD COLUMN overdue_notified_at TEXT;

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('task_created', 'task_reassigned', 'task_submitted', 'task_approved', 'task_returned', 'task_archived', 'task_restored')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_task_created_at ON task_events(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_overdue_notify ON tasks(status, due_date, overdue_notified_at);

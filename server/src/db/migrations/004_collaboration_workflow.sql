CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2')),
  status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'pending_review', 'completed')),
  progress INTEGER NOT NULL CHECK (progress BETWEEN 0 AND 100),
  due_date TEXT,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('manual', 'wecom', 'api', 'assistant')),
  is_private INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  archived_at TEXT,
  wecom_fingerprint TEXT
);

INSERT INTO tasks_new (id, title, description, priority, status, progress, due_date, owner_id, created_by, source, is_private, created_at, updated_at, completed_at, archived_at, wecom_fingerprint)
SELECT id, title, description, priority, status, progress, due_date, owner_id, created_by, source, is_private, created_at, updated_at, completed_at, NULL, NULL
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX IF NOT EXISTS idx_tasks_owner_id ON tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_archived_at ON tasks(archived_at);
CREATE INDEX IF NOT EXISTS idx_tasks_wecom_fingerprint ON tasks(wecom_fingerprint);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('task_assigned', 'task_reassigned', 'task_commented', 'task_progress', 'task_submitted', 'task_approved', 'task_returned', 'task_overdue')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_read ON notifications(recipient_id, is_read, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_task ON notifications(task_id, created_at);

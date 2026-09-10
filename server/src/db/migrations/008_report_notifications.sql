CREATE TABLE notifications_new (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  report_id TEXT REFERENCES weekly_reports(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('task_assigned', 'task_reassigned', 'task_commented', 'task_progress', 'task_submitted', 'task_approved', 'task_returned', 'task_overdue', 'report_submitted', 'report_approved', 'report_returned')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  created_at TEXT NOT NULL,
  read_at TEXT
);

INSERT INTO notifications_new (id, recipient_id, actor_id, task_id, report_id, event_type, title, message, is_read, created_at, read_at)
SELECT id, recipient_id, actor_id, task_id, NULL, event_type, title, message, is_read, created_at, read_at FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_read ON notifications(recipient_id, is_read, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_task ON notifications(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_report ON notifications(report_id);

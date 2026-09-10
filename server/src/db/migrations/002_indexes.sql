CREATE INDEX IF NOT EXISTS idx_access_tokens_user_id ON access_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_id ON tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_task_logs_task_id_created_at ON task_progress_logs(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_comments_task_id_created_at ON task_comments(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_todos_date_completed ON todos(todo_date, is_completed);
CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at);
CREATE INDEX IF NOT EXISTS idx_migration_runs_source ON migration_runs(source_sha256, status);

ALTER TABLE important_files ADD COLUMN category TEXT NOT NULL DEFAULT '';
ALTER TABLE important_files ADD COLUMN last_used_at TEXT;
CREATE INDEX IF NOT EXISTS idx_important_files_category ON important_files(category);
CREATE INDEX IF NOT EXISTS idx_important_files_last_used ON important_files(last_used_at);

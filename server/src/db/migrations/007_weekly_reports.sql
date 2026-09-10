CREATE TABLE IF NOT EXISTS weekly_reports (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('weekly_report', 'summary', 'other')),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('submitted', 'approved', 'returned')),
  current_version INTEGER NOT NULL DEFAULT 1,
  uploaded_by TEXT NOT NULL,
  review_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  reviewed_at TEXT,
  returned_at TEXT
);

CREATE TABLE IF NOT EXISTS report_files (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES weekly_reports(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  ext TEXT NOT NULL,
  mime_type TEXT,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  UNIQUE(report_id, version)
);

CREATE INDEX IF NOT EXISTS idx_weekly_reports_owner ON weekly_reports(owner_id);
CREATE INDEX IF NOT EXISTS idx_weekly_reports_status ON weekly_reports(status);
CREATE INDEX IF NOT EXISTS idx_report_files_report ON report_files(report_id);

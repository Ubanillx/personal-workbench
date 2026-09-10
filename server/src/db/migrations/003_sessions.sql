CREATE TABLE IF NOT EXISTS access_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_access_sessions_hash ON access_sessions(session_hash);
CREATE INDEX IF NOT EXISTS idx_access_sessions_user_id ON access_sessions(user_id);

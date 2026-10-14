CREATE TABLE task_dimensions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 40),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, name),
  UNIQUE(id, user_id)
);

CREATE TABLE task_dimension_links (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dimension_id TEXT NOT NULL,
  PRIMARY KEY(user_id, task_id, dimension_id),
  FOREIGN KEY(dimension_id, user_id) REFERENCES task_dimensions(id, user_id) ON DELETE CASCADE
);
CREATE INDEX idx_task_dimension_links_dimension ON task_dimension_links(user_id, dimension_id, task_id);

CREATE TABLE personal_task_handling (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  handled INTEGER NOT NULL CHECK(handled IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, task_id)
);

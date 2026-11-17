-- 用户自定义的订单节点规则（唛头/验货/订舱……）：
-- 每个账号一份规则集；没有自定义规则时使用代码里的默认两条。
CREATE TABLE IF NOT EXISTS order_step_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  anchor TEXT NOT NULL CHECK (anchor IN ('customer', 'factory', 'earliest')),
  lead_days INTEGER NOT NULL CHECK (lead_days BETWEEN 0 AND 365),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_order_step_rules_user ON order_step_rules(user_id);

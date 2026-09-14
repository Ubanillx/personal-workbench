-- 017_personal_records.sql
-- 「待办 / 随手记」从组织共享改为**本人数据**：加归属人 `owner_id`（D-54）。
--
-- 起因：权限调整确认「待办和随手记继续限制为本人数据」。改造前这两张表只有 `org_id`
-- （见 009 的注释「改造前没有归属字段，是全局共享的」），同组织的人互相看得到对方的待办与随手记——
-- 与「随手记」这个名字本身的语义相反。本次补上归属字段，读/写/删一律按人过滤。
--
-- **历史数据没有归属信息**，只能推断：把同一组织里**最早的启用组织管理者**认领为归属人，
-- 没有管理者时回落到**最早的管理员**。全程只写一次 `WHERE owner_id IS NULL`，
-- 重复执行不会改动任何已认领的行。
--
-- 刻意**不加外键** `REFERENCES users(id)`：SQLite 的 `ALTER TABLE ADD COLUMN` 加不了带外键的列，
-- 而为了一个可空的兼容列去重建两张表得不偿失。账号删除走 `ON DELETE SET NULL` 语义即可——
-- 归属人消失后这条记录不再属于任何人（谁都不再看到它），比级联删掉用户的历史更保守。
--
-- `owner_id` 允许为 NULL 只服务于上面这一种情况（老数据 + 没有可认领的账号）；
-- 新写入一律显式写 owner_id（`app/lib/records.server.ts` 的 `resolveRecordOrg` 同侧保证）。

ALTER TABLE todos ADD COLUMN owner_id TEXT;
ALTER TABLE notes ADD COLUMN owner_id TEXT;

CREATE INDEX IF NOT EXISTS idx_todos_owner ON todos(owner_id, todo_date);
CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes(owner_id, created_at);

-- 回填：每个组织一个归属人（最早的启用 manager；没有 manager 就用最早的启用 admin）
UPDATE todos
SET owner_id = (
  SELECT u.id
  FROM users u
  WHERE u.org_id = todos.org_id
    AND u.is_active = 1
    AND u.role IN ('manager', 'admin')
  ORDER BY CASE u.role WHEN 'manager' THEN 0 ELSE 1 END, u.created_at, u.id
  LIMIT 1
)
WHERE owner_id IS NULL;

UPDATE notes
SET owner_id = (
  SELECT u.id
  FROM users u
  WHERE u.org_id = notes.org_id
    AND u.is_active = 1
    AND u.role IN ('manager', 'admin')
  ORDER BY CASE u.role WHEN 'manager' THEN 0 ELSE 1 END, u.created_at, u.id
  LIMIT 1
)
WHERE owner_id IS NULL;

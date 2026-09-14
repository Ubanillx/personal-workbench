-- 018_file_visibility.sql
-- 「重要文件」区分**给组织看**与**给自己看**：加 `visibility` + `owner_id`（D-55）。
--
-- 起因：重要文件此前是「本组织全可见」一刀切，个人用的报价底稿、客户原话、自己的备忘
-- 一旦登记就进了全组织的列表。本次让新建时自己选，并允许事后改成另一种。
--
-- 语义（`app/lib/records.server.ts` 与 `app/lib/files.server.ts` 是唯一判据落点）：
-- - `visibility='org'`（给组织看）：组织内所有人可见、可改；删除仍只给组织管理者与全局管理员。
-- - `visibility='private'`（给自己看）：**创建人 + 本组织的全局管理员**可见；
--   可见即可改可删，且**归属人不可转让**（没有「改派」入口）。
-- - 组织隔离优先：private 也只在**本组织内**可见，跨组织一律 404（不变式 1 不受影响）。
--
-- 老数据全部是「组织内公开」的口径 ⇒ 回填 `visibility='org'`，行为零变化。
-- `owner_id` 对 org 行只作「谁登记的」记录用（org 行的可见性不看它）；对 private 行才是判权依据。
-- 回填规则与迁移 017 一致：本组织**最早的启用组织管理者**，没有就回落到最早的启用管理员。
--
-- `owner_id` 刻意不加外键：理由同 017（`ALTER TABLE ADD COLUMN` 加不了外键，
-- 归属人账号删除后这条文件变成「没有归属人」，不再属于任何人）。
--
-- 两列都可空/nullable 只服务于「老数据 + 当时没有可认领的账号」这一种情况：
-- 这种行按 `org` 处理（`visibility IS NULL` 一律当 org），不会因此凭空消失。

ALTER TABLE important_files ADD COLUMN visibility TEXT;
ALTER TABLE important_files ADD COLUMN owner_id TEXT;

UPDATE important_files
SET visibility = 'org'
WHERE visibility IS NULL;

UPDATE important_files
SET owner_id = (
  SELECT u.id
  FROM users u
  WHERE u.org_id = important_files.org_id
    AND u.is_active = 1
    AND u.role IN ('manager', 'admin')
  ORDER BY CASE u.role WHEN 'manager' THEN 0 ELSE 1 END, u.created_at, u.id
  LIMIT 1
)
WHERE owner_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_important_files_visibility ON important_files(org_id, visibility, created_at);
CREATE INDEX IF NOT EXISTS idx_important_files_owner ON important_files(owner_id, created_at);

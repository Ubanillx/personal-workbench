-- 016_report_upload_settings_per_org.sql
-- 周报/总结的**上传根目录改成按组织配置**，配置权下放给该组织的管理者（D-53）。
--
-- 背景：014/015 之后这张表是「全局单行」——管理员配一次，所有人的周报都写进同一个目录。
-- 实际用法是「不同组织把周报写在 NAS 上不同的目录里」（谁的数据归谁，翻起来也清楚），
-- 而这件事只有各组织自己最清楚：于是作用域从「全局」改成「组织」，
-- 配置权从「只有管理员」下放到「该组织的管理者」（管理员照旧可以配任意组织）。
--
-- 约定：
-- 1. 主键改为 `org_id`（→ `organizations`，`ON DELETE CASCADE`）：一个组织最多一行；
-- 2. `root` 仍旧是「相对 WebDAV 服务根的路径」，空串 = **用连接的浏览根目录**；
-- 3. **没有这一行 = 用连接的浏览根目录**（默认口径与 D-52 一致：没配也能交周报，不会 503）；
-- 4. **连接不变**（D-52）：周报始终用管理员在「WebDAV 连接」里保存的那份 NAS 账号写，
--    组织之间靠**目录**分开，而不是各配一套凭据；
-- 5. 老数据：原来那个全局目录（如果配过）**复制给每一个组织**，
--    于是升级后各组织的落点与升级前完全一致；不想共用的组织随后各配自己的即可。
--
-- 手法与 013/015 一致（重建表）；执行器已在事务外 `PRAGMA foreign_keys = OFF`，不要在本文件里写 PRAGMA。
CREATE TABLE report_upload_settings_new (
  org_id     TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  root       TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO report_upload_settings_new (org_id, root, updated_by, updated_at)
SELECT o.id, s.root, s.updated_by, s.updated_at
  FROM report_upload_settings s, organizations o
 WHERE s.root <> '';

DROP TABLE report_upload_settings;
ALTER TABLE report_upload_settings_new RENAME TO report_upload_settings;

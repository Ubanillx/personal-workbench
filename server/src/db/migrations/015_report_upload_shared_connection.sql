-- 015_report_upload_shared_connection.sql
-- 「周报上传」不再单独养一个连接，改成**共用管理员那份 WebDAV 连接**（D-52）。
--
-- 背景：D-46 给周报正文单开了一份「统一上传账号」（`username` / `password` / `timeout_ms` + 上传根目录），
-- 于是同一台 NAS 的凭据要在设置页里填两遍：一遍给「重要文件」，一遍给周报。
-- 实际上团队本来共用一台 NAS，管理员在「WebDAV 连接」卡里保存过的那份凭据已经够所有人交周报用了。
--
-- 改后：
-- 1. **连接**取 `webdav_settings` 里**管理员账号**那一份（多个管理员取最近保存的那份），
--    地址仍旧是部署级的 `WEBDAV_URL`（D-44 口径不变）；
-- 2. 这张表**只剩「上传根目录」**一项：`root` 存「相对 WebDAV 服务根的路径」，
--    空串 = **跟随共用连接的浏览根目录**，也就是所说的「默认是根目录」；
-- 3. 「没有这一行」不再等于「周报存储未配置」：只要有管理员保存过 WebDAV 连接就能交周报，
--    这一行只在管理员**另外挑过一个**上传目录时才存在；
-- 4. **老数据原样保留**：以前填过的 `/周报` 留在 `root` 里（不悄悄改回根目录），
--    想回到默认就在设置页点「恢复默认（跟随连接目录）」；
-- 5. `report_files` 依旧不动结构：正文路径写进原来的 `stored_name`（`webdav:<服务根相对路径>`）。
--
-- 手法与 013 / 009 一致（重建表，顺带把 `root` 的默认值从 `/周报` 改成空串）：
-- 迁移执行器已在事务外 `PRAGMA foreign_keys = OFF`，重建是安全的，不要在本文件里写 PRAGMA。
CREATE TABLE report_upload_settings_new (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  root       TEXT    NOT NULL DEFAULT '',
  updated_by TEXT    REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT    NOT NULL
);

INSERT INTO report_upload_settings_new (id, root, updated_by, updated_at)
SELECT id, root, updated_by, updated_at FROM report_upload_settings;

DROP TABLE report_upload_settings;
ALTER TABLE report_upload_settings_new RENAME TO report_upload_settings;

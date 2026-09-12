-- 011_webdav_settings.sql
-- 「重要文件」的 WebDAV 连接配置从**进程环境变量**改成**每账号一份、在设置页维护**（D-43）。
--
-- 背景：原来一次部署只能接一个 WebDAV（进程环境变量 WEBDAV_URL / USERNAME / PASSWORD），
-- 而不同的人可能用不同的地址与账号，改一次配置还得重启进程。现在每个管理员 /
-- 组织管理者可以在 `/settings?tab=webdav` 里填自己的配置，落库持久化、即时生效；
-- 环境变量方式已整体移除。
--
-- 约定：
-- 1. 主键就是账号（`user_id`），删账号自动清配置；一个账号最多一行；
-- 2. `password` 明文存储（WebDAV 走 Basic 认证需要原文）：
--    这是本机 / 局域网工具，不要暴露到公网；凭据也永远不会回传给页面；
-- 3. 账号没有对应行就是「未配置」（`url` 为空串同样按未配置处理）。
CREATE TABLE IF NOT EXISTS webdav_settings (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  url        TEXT NOT NULL DEFAULT '',
  username   TEXT NOT NULL DEFAULT '',
  password   TEXT NOT NULL DEFAULT '',
  root       TEXT NOT NULL DEFAULT '/',
  timeout_ms INTEGER NOT NULL DEFAULT 15000,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

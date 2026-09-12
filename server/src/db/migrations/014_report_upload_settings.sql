-- 014_report_upload_settings.sql
-- 周报/总结正文改存 NAS（D-46，见 docs/harness/REPORTS_WEBDAV.md）。
--
-- 背景：周报正文原本落在服务器本地 `data/uploads/reports/<reportId>/v<N>.<ext>`，
-- 只有装了本服务的机器能看到，而且不在任何备份范围里（DEBT-08：DB 有元数据、文件丢了就没了）。
-- 改造后正文**只写 WebDAV**，落点固定为
--
--   <上传根目录>/<登录用户名>/<period_start>_<period_end>/<原文件名>
--
-- 写入用的是**一个统一账号**：普通成员交周报不该先去配一遍 NAS 凭据，
-- 因此这份配置是全局单行、由管理员在 `/settings → WebDAV` 的「周报上传」区块维护。
--
-- 约定：
-- 1. **单行表**：`id` 固定为 1（CHECK 兜住），没有这一行就是「周报存储未配置」→ 上传/下载 503；
-- 2. **地址不在这里**：仍然来自环境变量 `WEBDAV_URL`（D-44 的口径：团队共用一台 NAS，地址部署级）；
-- 3. `password` 明文存储（WebDAV Basic 认证需要原文），只进 `Authorization` 头，
--    页面与 API 响应只读 `hasPassword` —— 与 `webdav_settings` 同一规矩；
-- 4. 这张表与按账号的 `webdav_settings` **互不影响**：后者继续服务「重要文件」的浏览/上传；
-- 5. `report_files` 不动结构：远端路径直接写进原来的 `stored_name` 列（带 `webdav:` 前缀），
--    因此不需要加列、也不需要回填（见 REPORTS_WEBDAV.md §3.4）。
CREATE TABLE IF NOT EXISTS report_upload_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  username   TEXT    NOT NULL DEFAULT '',
  password   TEXT    NOT NULL DEFAULT '',
  root       TEXT    NOT NULL DEFAULT '/周报',
  timeout_ms INTEGER NOT NULL DEFAULT 15000,
  updated_by TEXT    REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT    NOT NULL
);

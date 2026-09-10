-- 010_drop_access_tokens.sql
-- 令牌登录整体退役（D-22）：登录改为用户名 + 密码，会话仍走 access_sessions。
-- owner:reset 同步退役，改由 npm run user:passwd / user:init 承担。
--
-- api_tokens 是另一张早就没人读写的死表（DEBT-05），不在本次范围内。

DROP INDEX IF EXISTS idx_access_tokens_user_id;
DROP TABLE IF EXISTS access_tokens;

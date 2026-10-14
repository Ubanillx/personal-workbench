# 内网 HTTPS 登录来源校验

日期：2026-10-14。目标：`192.168.3.251`，合并前线上 release 为 `2a88249327de`。

- 线上 `GET /api/ping` 返回 `status=ok`、数据库 `ready`；systemd 的应用和 Nginx 均在运行。
- `POST /api/auth/login` 使用指定管理员凭据经 HTTPS 成功；相同凭据的页面 `POST /login.data` 不带 `Origin` 返回 202 和会话 Cookie。因此密码和数据库不是本次 400 的原因。
- `POST /login.data` 增加 `Origin: https://192.168.3.251` 后，原 release 返回 400 `Unexpected Server Error`。服务器日志指向 React Router 的 `handleSingleFetchRequest`，其 CSRF 校验比较 HTTPS Origin 与代理内 HTTP 请求 URL。
- 修复在 `react-router.config.ts` 中精确允许部署主机，保留其它来源 400。`test/api/auth.spec.ts` 增加带 HTTPS Origin、`X-Forwarded-Proto` 的页面 action 端到端测试，确认 202 重定向与 `Secure` Cookie，并拒绝两个非白名单来源。
- 服务器使用带 IP SAN 的自签名证书。经已记录的 SSH 主机密钥核对，HTTPS 证书指纹与服务器本机证书一致；不受信任的客户端仍需单独信任证书，应用修复不改变客户端信任设置。

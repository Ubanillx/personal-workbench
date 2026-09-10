/**
 * 响应信封与安全响应头：逐字节对齐旧 Fastify + helmet 实现的行为。
 * 契约快照（test/contract/golden）会校验 status / content-type / CSP 等头，
 * 因此这里不能"顺手优化"，改动必须同步重新 capture。
 */

/** 与 helmet 默认值一致，但去掉 upgrade-insecure-requests（局域网明文 HTTP 场景会白屏） */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "font-src 'self' https: data:",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' https: 'unsafe-inline'",
].join(";");

/** 刻意不设置 HSTS 与 COOP：纯 HTTP 服务下无意义且会产生浏览器告警 */
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
};

const JSON_HEADERS: Record<string, string> = { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" };

export function ok<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status, headers: JSON_HEADERS });
}

export function fail(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), { status, headers: JSON_HEADERS });
}

/** 给非 JSON 响应（例如文件下载）补上安全头 */
export function withSecurityHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  return response;
}

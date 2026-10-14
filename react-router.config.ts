import type { Config } from "@react-router/dev/config";

export default {
  /** 需要服务端资源路由（49 个 API 端点），因此开启 SSR */
  ssr: true,
  /** 内网 HTTPS 由 Nginx 终止，serve 的请求 URL 仍是 HTTP；只放行这一个公开入口的页面 action。 */
  allowedActionOrigins: ["192.168.3.251"],
} satisfies Config;

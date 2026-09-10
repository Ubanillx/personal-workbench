import type { Config } from "@react-router/dev/config";

export default {
  /** 需要服务端资源路由（48 个 API 端点），因此开启 SSR */
  ssr: true,
} satisfies Config;

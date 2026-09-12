import { getLanIPv4Addresses } from "../../server/src/network";
import { appConfig } from "./context.server";

/**
 * 访问信息组装逻辑，仅供 `/api/access-info` 使用。
 *
 * 权限：**仅全局管理员可见**（docs/harness/ACCOUNTS_AND_ORGS.md §7.2）——令牌登录已退役，
 * 这里的局域网地址只是「把服务地址告诉谁」的运维信息，因此门禁放在调用方
 * （`requireAdmin`，非 admin 一律 403 FORBIDDEN），本函数只负责组装返回体。
 * 设置页不再展示访问地址（见 `app/routes/settings.tsx`），前端只通过该端点读取。
 */
export function accessInfoPayload(): {
  port: number;
  host: string;
  localUrl: string;
  lanUrls: string[];
  warning: string;
} {
  const config = appConfig();
  return {
    port: config.port,
    host: config.host,
    localUrl: `http://127.0.0.1:${config.port}`,
    lanUrls: getLanIPv4Addresses().map((ip) => `http://${ip}:${config.port}`),
    warning: "仅将局域网地址发给本组织成员，不要发送 127.0.0.1 等本机地址",
  };
}

import { getLanIPv4Addresses } from "../../server/src/network";
import { appConfig } from "./context.server";

/** 访问信息共享逻辑：页面 loader 与 /api/access-info 资源路由共用 */
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
    warning: "仅将局域网地址发给同一网络内的助理，不要发送 127.0.0.1 或带令牌的链接",
  };
}

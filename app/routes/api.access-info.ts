import { getLanIPv4Addresses } from "../../server/src/network";
import { appConfig } from "../lib/context.server";
import { ok } from "../lib/http.server";
import { requireOwner } from "../lib/session.server";

/** GET /api/access-info —— 仅主人可见：端口、本机地址与局域网地址 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireOwner(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const config = appConfig();
  return ok({
    port: config.port,
    host: config.host,
    localUrl: `http://127.0.0.1:${config.port}`,
    lanUrls: getLanIPv4Addresses().map((ip) => `http://${ip}:${config.port}`),
    warning: "仅将局域网地址发给同一网络内的助理，不要发送 127.0.0.1 或带令牌的链接",
  });
}

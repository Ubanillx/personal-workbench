import { existsSync } from "node:fs";
import path from "node:path";
import { buildApp } from "./app";
import { loadConfig } from "./config/env";
import { getLanIPv4Addresses } from "./network";
import { assertSupportedNodeRuntime, runtimeLabel } from "./runtime";

function loadDotEnv(cwd: string): void {
  const envPath = path.join(cwd, ".env");
  if (!existsSync(envPath)) return;
  try {
    // Node >=20.12 built-in loader; does not override already-set env vars.
    process.loadEnvFile(envPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`警告：无法加载 ${envPath}：${message}`);
  }
}

async function main(): Promise<void> {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    assertSupportedNodeRuntime();
    loadDotEnv(process.cwd());
    const config = loadConfig();
    app = await buildApp({ config });
    const address = `http://${config.host}:${config.port}`;
    await app.listen({ host: config.host, port: config.port });
    console.log(`Personal Workbench Web 服务已启动: ${address}`);
    console.log(`运行环境: ${config.nodeEnv}`);
    console.log(`运行时: ${runtimeLabel()}`);
    if (config.host === "0.0.0.0") {
      const lanAddresses = getLanIPv4Addresses();
      console.log(`局域网访问地址: ${lanAddresses.length ? lanAddresses.map((ip) => `http://${ip}:${config.port}`).join(", ") : "未检测到局域网 IPv4 地址"}`);
      console.log("已显式开启局域网访问，请确认 Windows 防火墙仅允许本地子网");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知启动错误";
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    const hint = code === "EADDRINUSE" ? "端口已被其他进程占用。请关闭开发服务或旧正式服务后重试。" : "请检查 Node.js 版本、数据库、端口或监听地址。";
    console.error(`Web 服务启动失败：${message}。${hint}`);
    await app?.close();
    process.exitCode = 1;
    return;
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`收到 ${signal}，正在关闭 Web 服务`);
    await app?.close();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();

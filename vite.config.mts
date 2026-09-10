import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

/**
 * React Router 8 framework mode 的构建配置。
 * 用 .mts 后缀是有意的：否则 Vite 会以 CJS 方式加载本文件并每次打印
 * "ESM syntax in a file loaded as CommonJS" 告警（旧的 web/vite.config.mts 同理）。
 */
export default defineConfig({
  plugins: [reactRouter()],
});

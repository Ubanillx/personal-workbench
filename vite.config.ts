import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

/**
 * React Router 8 framework mode 的构建配置。
 * 旧的 SPA 仍由 web/vite.config.mts 构建（Phase 4 归档）。
 */
export default defineConfig({
  plugins: [reactRouter()],
});

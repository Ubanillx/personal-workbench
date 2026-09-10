# 归档说明：旧 Fastify + Vite SPA 实现

归档日期：2026-09-10

这里是 `personal-workbench` 在全栈迁移（Phase 4）之前的实现：**Fastify 后端 + 独立 Vite React SPA（`web/`）双进程**。
全栈迁移把它替换为 **React Router 8 framework mode 单进程**（源码在 `app/` 与 `server/src/` 的框架无关部分）。
本目录内容**没有永久删除**，但当前实现不依赖其中任何文件。

迁移过程与决策见 [`docs/harness/FULLSTACK_MIGRATION.md`](../../docs/harness/FULLSTACK_MIGRATION.md)。

## 归档内容

| 本目录路径 | 原位置 | 说明 |
| --- | --- | --- |
| `server/app.ts` | `server/src/app.ts` | Fastify 实例组装：CORS / Cookie / Helmet / Multipart / Static + SPA fallback |
| `server/index.ts` | `server/src/index.ts` | 旧服务入口（`node dist-server/server/src/index.js`） |
| `server/routes/workbench.ts` | `server/src/routes/` | 旧业务路由（任务 / 待办 / 随手记 / 收件箱 / 协作 / 文件 / 通知），约 44KB |
| `server/routes/report.ts` | `server/src/routes/` | 旧周报路由（上传 / 审核 / 下载 / 通知），约 17KB |
| `server/routes/health.ts` | `server/src/routes/` | 旧 `/api/health`、`/api/ping` |
| `web/` | `web/` | 旧 Vite React SPA（`index.html`、`src/App.tsx`、`src/main.tsx`、页面、`services/apiClient.ts`、样式、独立 tsconfig 与 vite 配置） |
| `shared/constants/index.ts` | `shared/constants/` | 旧前端常量（`APP_NAME`、`DEFAULT_API_PREFIX`、`DEFAULT_POLL_INTERVAL_MS`），已无引用 |
| `shared/types/api.ts` | `shared/types/` | 旧 `ApiResponse<T>` 包装类型，只被旧 `apiClient.ts` 使用 |
| `shared/types/auth.ts` | `shared/types/` | 旧登录请求/响应类型，已无引用 |

保留未动：`shared/types/domain.ts`（新实现继续使用，例如 `app/lib/db.server.ts`、`server/src/db/repositories/*`）。

## 同时删除的构建产物

| 路径 | 说明 |
| --- | --- |
| `dist-server/` | 旧后端 `tsc` 产物（`.gitignore` 内），由 `server/tsconfig.json` 的 `outDir` 生成；实现归档后不会再生成 |
| `web/dist/` | 旧前端 Vite 产物（`.gitignore` 内），只由旧 `@fastify/static` 托管 |

两者都是可重新生成的产物，因此直接删除、不归档。

## 连带移除的配置

- `package.json`：删除 `fastify`、`@fastify/cookie`、`@fastify/cors`、`@fastify/helmet`、`@fastify/multipart`、
  `@fastify/static`（共 6 个依赖）与 `concurrently`（旧 `npm run dev` 同时跑前后端用）；`npm install` 后减少 84 个包。
- `package.json` scripts：`dev:server`、`dev:web`、`build:web`、`build:server`、`typecheck:web` 已随实现删除。
- `server/tsconfig.json`：去掉 `rootDir: ".."` 与 `outDir: "../dist-server"`，改为 `noEmit: true`（该工程只做类型检查，
  不再产出 `dist-server/`）。
- `server/src/config/env.ts`：`AppConfig` 去掉 `webDistPath` 与 `WEB_DIST_PATH`（只有旧 `app.ts` 静态托管读它）。
- `.gitignore`、`.prettierignore`、`.oxlintrc.json`：去掉 `dist-server/`、`web/dist/`；oxlint 的浏览器环境 override
  从 `web/src/**` 改为 `app/**`。

## 命令对应关系

| 旧命令 | 现在 |
| --- | --- |
| `npm run dev:server` + `npm run dev:web`（两个终端） | `npm run dev`（单进程：SSR + 路由） |
| `npm run dev`（`concurrently` 同时跑上面两个） | `npm run dev`（React Router dev server，默认 5173） |
| `npm run build:web` + `npm run build:server` | `npm run build`（`react-router build`，客户端 + SSR 一起） |
| `npm start`（跑 `dist-server/.../index.js`） | `npm start`（`react-router-serve build/server/index.js`） |
| `npm run test:web`（旧前端测试） | `npm run test:ui`（SSR 冒烟：登录 → 外壳 → 8 个页面数据） |
| `npm run typecheck:web` | `npm run typecheck:app`（`app/` 现在的 tsconfig 在仓库根） |

## 恢复方式

如需临时回退，把本目录内容按上表原路径拷回（`server/app.ts` → `server/src/app.ts`、`web/` → 仓库根 `web/` 等），
并还原 `package.json` 的 `fastify`/`@fastify/*`/`concurrently` 依赖与 `dev:server`/`dev:web`/`build:*` 脚本、
`server/src/config/env.ts` 的 `webDistPath`、`server/src/routes/` 目录，再执行 `npm install`、`npm run build:server`。

回退前请注意：正式数据库格式未变（`data/workbench.sqlite`，migrations 001–008），两套实现读写同一份库，
因此回退不会丢数据；但回退期间通过新实现写入的数据（例如新增任务）旧实现同样能读到，反之亦然。

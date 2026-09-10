# Personal Workbench 运行时 Bug 清单

> 生成方式：实际运行项目（Node 22.22.2 + 生产构建 + Fastify 服务 + SQLite）并逐项复现。
> 未修改任何业务代码、配置文件或正式数据。本清单仅用于对齐修复方案。

## 复现环境与结论

- Node 运行时：`C:\Users\topmax\AppData\Local\nvm\v22.22.2\node.exe`（22.22.2，满足 `>=22.5.0`）。
- `typecheck`（server + web）：通过。现有测试套件 16/16 通过。
- 生产服务可正常启动，`/api/health` 返回 200，SQLite 状态 `ready`。
- API 权限/CRUD 流程（access → me → dashboard → createTodo）在 17600 测试库上全链路 200/201 通过。
- **核心问题不在 API，而在“局域网访问时前端资源被 CSP 拦截导致白屏”。**

---

## P0（阻断：导致“网页无法打开 / 白屏”）

### 1. helmet 默认 CSP 的 `upgrade-insecure-requests` 使局域网访问白屏

- **位置**：`server/src/app.ts` 第 24 行 `await app.register(helmet);`
- **现象**：
  - 主人用 `http://127.0.0.1:17500` 打开正常（Chrome 把回环地址当安全源，跳过升级）。
  - 助理用局域网地址 `http://192.168.2.176:17500` 打开时，页面 `#root` 为空，React 应用完全不出登录页 → 白屏。
- **根因**：helmet 默认 CSP 含 `upgrade-insecure-requests`。浏览器会把 `http://192.168.2.176/assets/*.js` 升级为 `https://192.168.2.176/assets/*.js`，而服务只监听 HTTP，资源加载失败，bundle 不执行。
- **实测证据**（headless Chrome）：
  - `http://127.0.0.1:17500/` → 渲染出“访问个人工作台”登录页。
  - `http://192.168.2.176:17500/` → `<div id="root"></div>`（空）。
  - 响应头确认含 `Content-Security-Policy: ... upgrade-insecure-requests`。
- **修复方向**（已对照安装的 `helmet@8.3.0` / `@fastify/helmet@13.1.1` 源码核对，字段名有效）：
  ```ts
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } }
  });
  ```
  helmet 的 `parseDirectives`（`useDefaults: true` 时合并默认指令）遇到 `null` 值会 `delete` 该指令（`index.mjs` 第 59 行），因此上面写法只移除 `upgrade-insecure-requests`，其余 CSP 指令保留。
  - 可选再加 `strictTransportSecurity: false` 与 `crossOriginOpenerPolicy: false`，消除对纯 HTTP 服务无意义/会触发浏览器告警的响应头。

---

## P1（高：文档/构建与运行不一致，易踩坑）

### 2. `.env` 文件完全不会生效（文档与实现不符）

- **位置**：`server/src/config/env.ts`；README「配置」一节。
- **现象**：README 要求“复制 `.env.example` 后按需设置”，但服务从不读取 `.env`，只读真实 `process.env`。用户在 `.env` 里改 `HOST/PORT/DATABASE_PATH` 均无效，容易因配置不生效而“打不开”。
- **证据**：全仓无 dotenv 加载，`loadConfig(env = process.env)` 只接收进程环境变量。
- **修复方向**（二选一）：启动时用 dotenv 加载 `.env`；或改 README，明确这些值必须作为真实环境变量/受管脚本参数传入。

### 3. `npm start` / `npm run start:lan` 不构建前端，可能服务过期或缺失的 dist

- **位置**：`package.json` 的 `start`、`start:lan` 脚本。
- **现象**：这两个“生产”命令直接运行 `dist-server/server/src/index.js`，没有 `build:web` 步骤。
  - 若 `web/dist` 不存在，`/` 会返回 404“页面不存在”；
  - 若源码已改但没重新 build，则服务旧前端。
- **对比**：`scripts/start-lan.ps1` 会先 build，是正确的入口。
- **修复方向**：让 `start`/`start:lan` 先执行 build，或启动时检测 `web/dist/index.html` 缺失/过期并给出明确提示。

### 4. `vite.config.ts` 的 `emptyOutDir: false` 导致 dist 累积过期资源

- **位置**：`web/vite.config.ts` 第 19 行 `emptyOutDir: false`。
- **现象**：`web/dist/assets` 现有 11 个 JS + 5 个 CSS，而 `index.html` 只引用其中 1+1；历次构建产物互相叠加。
- **修复方向**：恢复 Vite 默认 `emptyOutDir: true`。

### 5. Vite 配置以 ESM 语法被当 CommonJS 加载（未来版本将报错）

- **位置**：`web/vite.config.ts`。
- **现象**：构建告警 `ESM syntax in a file loaded as CommonJS`；Vite 8 的 native configLoader 即将成为默认，届时构建会失败。
- **修复方向**：改为 `vite.config.mts`，或为 `web` 增加 `"type": "module"`。

---

## P2（低：体验与环境）

### 6. `node`/`npm` 不在系统 PATH，README 命令在全新终端跑不起来

- **证据**：`node --version` 报“无法将 node 识别为 cmdlet”。
- **影响**：README 的 `npm run build && npm start` 在默认 PowerShell 中无法直接执行（需先 `nvm use 22.22.2` 并新开终端）。
- **修复方向**：文档明确 NVM 步骤，或统一推荐受管启动器 `powershell -ExecutionPolicy Bypass -File scripts/start-lan.ps1`。

### 7.（轻微）通知跳转不会在已打开的任务页自动选中任务

- **位置**：`web/src/pages/WorkbenchPages.tsx` 的 `TasksPage`，`useEffect(load, [archived])` 未把 `searchParams` 纳入依赖。
- **现象**：已停留在 `/tasks` 页时，点通知导航到 `/tasks?task=<id>`，因 `archived` 未变化，`load` 不重跑，对应任务不会自动打开（从其他页面跳转时才正常）。
- **修复方向**：把 `params`（或 `params.get("task")`）纳入 effect 依赖，或在点击通知处显式打开任务。

---

## 已确认“没有问题”的部分

- 服务端权限边界（owner/assistant/viewer）与 API 状态机：现有 16 条测试全绿，全链路实测通过。
- 生产 SPA 托管：`/`、`/tasks`、`/assets/*` 均 200，回环地址下 React 正常渲染。
- SQLite migrations：6 个迁移已应用，DB 结构完整。

---

## 待对齐的问题

1. 上述 P0/P1 是否全部纳入本次重构修复范围，还是只先修 P0（白屏）？
2. Bug #2（.env）你更希望走“加 dotenv 加载”还是“改文档说明”？
3. Bug #3 是否同意让 `start`/`start:lan` 内建 build（会稍微拖慢启动）？
4. 是否有其它你实际遇到的“打不开/无法交互”场景，我需要补充复现？

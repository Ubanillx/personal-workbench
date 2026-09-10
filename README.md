# 个人工作台 (Personal Workbench)

个人工作台是本地 Web 应用。所有数据默认保留在主人电脑，正式服务使用 Node.js 22+、Fastify、TypeScript 和 SQLite。

> 项目操作台（待办 / 计划 / 技术债 / 目录架构 / 数据模型 / 命令速查）在 [`docs/harness/`](docs/harness/README.md)。

## 当前状态

- 新 Web 工程使用 React 19 + Vite、**antd v6**、Node.js + Fastify、TypeScript 和 SQLite。
- Web 服务启动时会自动执行 SQLite migrations，并通过 HttpOnly Cookie 建立会话。
- 正式数据库为 `data/workbench.sqlite`；每次主人令牌重置会先在 `data/backups/` 创建备份。
- 日常使用正式地址 `http://127.0.0.1:17500`，不要使用 `5173` 开发预览地址。

## Node Runtime

正式服务要求 Node.js `>=22.5.0`，推荐使用 NVM 安装并启用固定版本：

```powershell
nvm install 22.22.2
nvm use 22.22.2
node --version
```

Node 20 会被正式服务明确拒绝，避免在没有 `node:sqlite` 支持时启动半可用服务。

> 注意：`nvm use 22.22.2` 只对当前终端生效。运行 `npm run build` / `npm start` / `npm run dev` 前，请确认 `node --version` 与 `npm --version` 能正常输出；如果提示“无法将 node 识别为 cmdlet”，说明 NVM 的 Node 链接未加入 PATH，请先 `nvm use 22.22.2` 并**新开一个 PowerShell 窗口**再执行。

所有 npm 脚本都通过 `npm_node_execpath` 调用当前 npm 使用的 Node，不会误用系统里其他版本的 Node。

## 启动方式

### Web 开发模式

先在一个终端启动 API：

```bash
npm run dev:server
```

再在另一个终端启动前端：

```bash
npm run dev:web
```

也可以同时启动：

```bash
npm run dev
```

- 前端开发地址：`http://127.0.0.1:5173`
- API 默认地址：`http://127.0.0.1:17500`
- 健康检查：`http://127.0.0.1:17500/api/health`

开发模式仅用于本机调试。不要在 `5173` 创建成员、分配正式任务或作为助理入口。

### Web 生产构建与启动

```bash
npm run build
npm start
```

构建后 Node 服务会托管 `web/dist`，默认访问地址为 `http://127.0.0.1:17500`。

需要让同一局域网内的助理访问时，使用受限局域网启动方式：

```bash
npm run build
npm run start:lan
```

服务启动日志会显示检测到的局域网地址，例如 `http://192.168.2.176:17500`。地址不会携带令牌。

启动后保持该正式服务终端运行。若提示端口被占用，先关闭 `npm run dev`、`dev:server`、`dev:web` 或旧的 `start:lan` 进程，再重新启动。

## 局域网访问

正式服务在 `start:lan` 时对局域网绑定：

`npm run start:lan` 等价于使用 `NODE_ENV=production`、`HOST=0.0.0.0` 和 `PORT=17500` 启动正式服务；开发服务 `5173` 仍只绑定本机。

首次开放端口时，请在“管理员 PowerShell”执行：

```powershell
New-NetFirewallRule -DisplayName "Personal Workbench TCP 17500 (LocalSubnet)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 17500 -RemoteAddress LocalSubnet -Profile Any
```

该规则仅允许 `LocalSubnet` 访问 TCP `17500`，不会开放到任意互联网地址，也不会开放 `5173`。如果当前终端不是管理员，需要手动以管理员身份执行该命令。

主人电脑也可以打开局域网地址，但主人日常应使用 `http://127.0.0.1:17500`。助理必须使用同一非访客局域网的设备打开动态局域网地址；不同 VLAN、访客 Wi-Fi、客户端隔离网络或互联网都无法访问。不要把 `127.0.0.1`、`0.0.0.0` 或带令牌的 URL 发给助理。

主人登录“协作管理”后可查看动态局域网地址并为成员生成一次性长期令牌。助理输入自己的令牌即可登录；停用成员会立即撤销其会话和令牌。

## 主人权限恢复

如果协作管理提示当前账户没有权限，说明浏览器登录的是助理或查看者。主人令牌不能从数据库还原，只能在主人电脑本地重置：

```bash
npm run owner:reset -- --confirm
```

该命令会先备份正式 SQLite 数据库，撤销所有旧主人令牌和主人会话，并仅在当前终端显示一次新令牌。保存新令牌后，在正式地址退出当前账户，再使用新令牌登录。助理和查看者令牌不会受影响。

## 配置

复制 `.env.example` 后按需设置：

```text
NODE_ENV=development
HOST=127.0.0.1
PORT=17500
DATABASE_PATH=data/workbench.sqlite
WEB_DIST_PATH=web/dist
SESSION_COOKIE_NAME=workbench_session
UPLOADS_DIR=data/uploads/reports
API_PROXY_TARGET=http://127.0.0.1:17500
```

`API_PROXY_TARGET` 只被 `npm run dev:web` 的 Vite 代理读取，其余变量由正式服务读取。

不要将真实 token、`.env`、数据库备份或隐私数据提交到代码仓库或写入日志。

## 数据与备份

- `data/workbench.sqlite`：正式服务的数据源。
- `data/backups/`：正式 SQLite 备份目录，执行 `npm run db:backup` 手动生成备份；主人令牌重置和数据库结构迁移前也会自动备份。
- `data/uploads/reports/`：周报上传文件目录。
- 旧的 JSON 数据源和 Electron 相关代码已移入 `_archive/legacy-electron/`，正式服务不再读取。

## 代码规范与验证命令

源码只写 TypeScript（`.ts`/`.tsx`/`.mts`，禁用 `.js`）；前端 UI 统一用 antd v6，规范细则见 [`docs/harness/CODE_STYLE.md`](docs/harness/CODE_STYLE.md)。仓库根 `AGENTS.md` 与 `.agents/skills/antd/` 是官方 Ant Design CLI skill，写 antd 代码前先用 `npx antd info/demo/doc` 查权威 API。

```bash
npm run lint          # oxlint，门禁 0 warning / 0 error
npx antd lint web/src # antd 官方检查：必须 No issues found
npm run typecheck     # server + web + tools
npm test              # 依次 test:api → test:web → test:db
npm run build         # 前端 + 后端产物
npm run format:check  # 确认没有 Prettier 格式漂移
```

`npm test` 依次执行 `test:api`、`test:web`、`test:db`；也可单独运行其中任意一个。

测试使用临时数据库，不会访问或修改正式数据。

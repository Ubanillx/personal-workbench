# 个人工作台 (Personal Workbench)

个人工作台是本地 Web 应用。所有数据默认保留在本机，正式服务使用 Node.js 22+、React Router 8（framework mode）、TypeScript 和 SQLite。

> 项目操作台（待办 / 计划 / 技术债 / 目录架构 / 数据模型 / 命令速查）在 [`docs/harness/`](docs/harness/README.md)。

## 当前状态

- 全栈由**单进程**提供：React Router 8 framework mode 同时负责 SSR 页面与 `/api/*` 资源路由，不再需要「后端 + 前端」两个进程。
- UI 使用 React 19 + **antd v6**；样式与主题见 `app/root.tsx`（`#185fa5` + `zh_CN`）。
- 服务启动时会自动执行 SQLite migrations，并通过 HttpOnly Cookie 建立会话。
- 正式数据库为 `data/workbench.sqlite`；应用新迁移前会自动在 `data/backups/` 生成快照。
- 日常使用正式地址 `http://127.0.0.1:17500`。开发模式默认在 `5173`，只绑定本机。
- 迁移前的 Fastify + Vite SPA 双进程实现在 [`_archive/legacy-fastify/`](_archive/legacy-fastify/ARCHIVE_NOTE.md)，当前实现不依赖它。

## Node Runtime

正式服务要求 Node.js `>=22.9.0`，推荐使用 NVM 安装并启用固定版本：

```powershell
nvm install 22.22.2
nvm use 22.22.2
node --version
```

Node 20 会被正式服务明确拒绝，避免在没有 `node:sqlite` 支持时启动半可用服务。

> 注意：`nvm use 22.22.2` 只对当前终端生效。运行 `npm run build` / `npm start` / `npm run dev` 前，请确认 `node --version` 与 `npm --version` 能正常输出；如果提示“无法将 node 识别为 cmdlet”，说明 NVM 的 Node 链接未加入 PATH，请先 `nvm use 22.22.2` 并**新开一个 PowerShell 窗口**再执行。

所有 npm 脚本都用 `node` 启动（从 PATH 解析，跨平台）：**PATH 里的 `node` 必须就是你要用的那个 Node** —— 本机先 `nvm use 22.22.2`；Jenkins 构建机由 `Jenkinsfile` 的「准备」阶段校验「PATH 的 `node`」与「`npm` 用的 `node`」是同一个，不一致直接失败。（原写法 `%npm_node_execpath%` 是 Windows cmd 专用语法，Linux 构建机上会 `not found`。）

## 启动方式

### 开发模式

```bash
npm run dev
```

`react-router dev` 一个命令同时提供页面与 API（Vite 开发服务器，默认 `http://127.0.0.1:5173`），改代码即时热更新，不需要再单独启动后端。

开发模式仅用于本机调试，不要把它当作正式入口。

### 生产构建与启动

```bash
npm start
```

`npm start` 等价于「构建 + 以生产模式启动」：先跑 `npm run build`（`react-router build`，同时产出客户端与 SSR 产物到 `build/`），再设置 `NODE_ENV=production`、`HOST=127.0.0.1`、`PORT=17500` 并运行 `npm run serve`（`react-router-serve build/server/index.js`）。

> `npm run build` 会先跑一步 `tools/build/prebuild.ts`：`react-router build` 的第一步是**清空** `build/`，只要该目录被残留的
> `npm run serve` / `npm start` 进程占用（Windows 上会 `EBUSY` / `EPERM`），构建就会在**编译之前**中止，报错与代码无关。
> 该脚本会在必要时结束占用进程并把目录清干净，因此不需要再人工先删 `build/`。

只重启、不重新构建时可以直接：

```bash
npm run serve
```

> 注意：`react-router-serve` 在**没有** `PORT` 时会默认监听 `3000`，并且当 `3000` 被占用时会**静默**换一个随机端口；在没有 `HOST` 时会绑定**所有网卡**。因此 `npm start` 固定了 `HOST` 与 `PORT`，请优先使用它，而不是直接调用 `react-router-serve`。

需要让同一局域网内的成员访问时，使用受限局域网启动方式：

```bash
npm run start:lan
```

它与 `npm start` 的唯一区别是 `HOST=0.0.0.0`。服务启动日志会显示检测到的局域网地址，例如 `http://192.168.2.176:17500`。

启动后保持该正式服务终端运行。若提示端口被占用（`EADDRINUSE`），先用 `Get-NetTCPConnection -LocalPort 17500 -State Listen` 找到占用进程并关闭，再重新启动。

## 首次安装（全新数据库）

数据库为空时（刚 clone、`data/workbench.sqlite` 还不存在），服务在迁移之后会自动自举一次：

- 建默认管理员 `admin`（`password_hash` 是 `locked$` 占位值，任何密码都登不进去）；
- 建默认组织「默认组织」，`created_by` 指向这个管理员。

管理员的初始密码有两种给法（D-51）：

**A. 环境变量（部署推荐）**：在 `.env` 里写 `WORKBENCH_ADMIN_PASSWORD=<至少 8 位>` 再启动服务。自举时读一次，**只在 `admin` 还没有密码时生效**；之后改这个值不会覆盖已设密码。

**B. 本机 CLI**：不给环境变量时，首次启动后在本机生成随机初始密码（只在终端打印一次）：

```bash
npm run user:init -- --confirm
```

不管走哪条路，都用 `admin` 在 `http://127.0.0.1:17500/login` 登录；B 的随机密码**首次登录强制改密**，
A 的密码被当作长期密码（要强制改密就用 `npm run user:passwd -- admin`）。之后就能创建组织、
把注册进来的账号拉进组织。自举是幂等的：已有管理员与组织的库（例如正式库）不会被改动，
初始组织只在「一个组织都没有」时创建。规则见 [`docs/harness/ACCOUNTS_AND_ORGS.md`](docs/harness/ACCOUNTS_AND_ORGS.md) §16。

## 局域网访问

正式服务在 `start:lan` 时对局域网绑定：

`npm run start:lan` 等价于使用 `NODE_ENV=production`、`HOST=0.0.0.0` 和 `PORT=17500` 启动正式服务；开发服务 `5173` 仍只绑定本机。

首次开放端口时，请在“管理员 PowerShell”执行：

```powershell
New-NetFirewallRule -DisplayName "Personal Workbench TCP 17500 (LocalSubnet)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 17500 -RemoteAddress LocalSubnet -Profile Any
```

该规则仅允许 `LocalSubnet` 访问 TCP `17500`，不会开放到任意互联网地址，也不会开放 `5173`。如果当前终端不是管理员，需要手动以管理员身份执行该命令。

管理员电脑日常应使用 `http://127.0.0.1:17500`；成员必须使用同一非访客局域网的设备打开动态局域网地址——不同 VLAN、访客 Wi-Fi、客户端隔离网络或互联网都无法访问。不要把 `127.0.0.1`、`0.0.0.0` 直接发给成员。

成员首次使用需要先注册账号（`/register`，用户名 + 邮箱 + 密码）。注册后账号**尚无组织**，只能访问 `/join`：从组织列表提交加入申请，等待管理员或该组织管理者审批，或由管理者直接拉入。停用成员会立即撤销其全部会话。

## 账号密码重置

登录改为**用户名 + 密码**，没有任何网页端重置他人密码的入口。忘记密码只能在数据所在的机器上执行本机 CLI：

```bash
npm run user:list                      # 列出用户名 / 邮箱 / 角色 / 组织 / 是否待改密
npm run user:passwd -- <用户名>         # 交互式输入新密码；加 --generate 打印随机密码
```

管理员误把自己降级（页面禁止，但 CLI 可恢复）或忘记密码时都靠这条命令恢复。

## 配置

复制 `.env.example` 为 `.env` 后按需设置：

```text
NODE_ENV=development
HOST=127.0.0.1
PORT=17500
DATABASE_PATH=data/workbench.sqlite
SESSION_COOKIE_NAME=workbench_session
UPLOADS_DIR=data/uploads/reports
WEBDAV_URL=http://192.168.0.242:5005
WORKBENCH_ADMIN_PASSWORD=
```

`WORKBENCH_ADMIN_PASSWORD` 是唯一一个「秘密」变量：只在自举时用来给管理员 `admin` 设初始密码，
留空就退回 `npm run user:init` 的随机密码流程（见上面的「首次启动」一节）。

`.env` 会被**自动加载**（`npm run serve` / `dev` 与各 CLI 都会读，见 `docs/harness/TECH_DEBT.md` 的 DEBT-02）：

- **已经存在的进程环境变量优先于 `.env`**，所以 `$env:PORT=18000; npm run serve` 这种临时覆盖仍然有效；
- 没有 `.env` 也能正常启动（该文件被 gitignore）；
- `HOST` / `PORT` 由 `npm run serve` 的适配器读取（所以 `serve` 脚本里带了 `--env-file-if-exists=.env`），其余变量由 `server/src/config/env.ts` 读取。

不要将真实 token、`.env`、数据库备份或隐私数据提交到代码仓库或写入日志。

## WebDAV（可选，用于「重要文件」与「周报正文」）

WebDAV 在这个项目里服务**两件互不影响**的事，配置刻意分成两份：

| 用途                        | 谁用                                  | 配置在哪                                                                      |
| --------------------------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| **「重要文件」浏览 / 上传** | 每个账号自己（各人用自己的 NAS 账号） | `/settings` →「WebDAV」Tab 上半部分（按账号存库，保存即时生效）               |
| **周报/总结正文的存储**     | 全员共用一个统一账号（D-46）          | `/settings` →「WebDAV」Tab 的「周报上传」卡片（**只有管理员能改**，全局一份） |

两份配置共用同一个**部署级地址**：`.env` 里的 `WEBDAV_URL`（改完要**重启服务**）。

### 重要文件（按账号）

| 部分                                    | 在哪配                                       | 生效方式         |
| --------------------------------------- | -------------------------------------------- | ---------------- |
| **地址**（`http://192.168.0.242:5005`） | `.env` 的 `WEBDAV_URL`（部署级、全员共用）   | 改完**重启服务** |
| **用户名 / 密码 / 浏览根目录 / 超时**   | `/settings` →「WebDAV」Tab（按账号存数据库） | 保存**即时生效** |

设置页里都能「测试连接」；地址那一栏是只读展示的。**浏览根目录两种写法都接受**，保存时自动归一：

- Linux / WebDAV 原生：`/volume1/work`
- Windows 共享（UNC）：`\\192.168.0.242\work\报价` → `/报价`（自动去掉主机名与共享名）
- Windows 盘符：`Z:\报价` → `/报价`

未在本账号保存过配置就是**不接入**，行为与以前一致（只看已有路径索引）。保存过之后，「重要文件」页会多出：

- **添加 / 编辑时「选择文件」**：点「选择文件」按目录挑（面包屑 + 本目录内筛选），选中的文件自动填好路径，
  名称空着时自动用文件名，保存才落库；编辑远端条目时直接定位到它所在目录，当前指向的文件标「当前」；
- **下载**：远端条目带「下载」，浏览器 → 本服务 → NAS **流式代理**（凭据不出服务器），文件名与远端一致；
  本机路径的条目没有下载入口；
- **浏览 WebDAV**：弹窗里按目录浏览（名称 / 大小 / 修改时间），选中文件直接登记进重要文件索引；
- **上传**：上传到当前浏览目录（可勾选「同时登记到索引」，同名会覆盖远端文件）；
- **文件情况**：列表新增一列，远端条目显示 `可访问 / 远端已不存在 / 未检查` + 大小 + 修改时间。

没配 WebDAV 时「选择文件」按钮置灰，先去「设置 → WebDAV」保存一次账号。

### 周报 / 总结正文（统一账号，只存 NAS）

周报正文**只写 NAS，本机不留副本**（见 [`docs/harness/REPORTS_WEBDAV.md`](docs/harness/REPORTS_WEBDAV.md)）：

- 归属人恒为**登录账号本人**：上传表单里不再有「归属人」，代传已取消；管理员不提交周报，只负责审批；
- 落点：`<上传根目录>/<登录用户名>/<起止日期>/<原文件名>`，默认上传根目录 `/周报`，
  例如 `/周报/zhangsan/2026-09-01_2026-09-07/第八周周报.docx`；
- 退回后重传加 `_v2` / `_v3` 后缀；同人同期同名再交一份自动加 `_2`；**远端已有文件绝不被覆盖**；
- 下载走**服务端流式代理**（浏览器 → 应用 → NAS），登录与组织隔离照旧生效，NAS 凭据不出服务器。

管理员第一次启用：`/settings → WebDAV → 周报上传`，填统一账号（对该目录有写权限的那个）、上传根目录（可点「选择目录」挑）→ 保存。
没配之前，成员提交周报会拿到「周报存储未配置：请联系管理员…」。

历史正文（此前落在 `data/uploads/reports/` 的那些）用一次性脚本搬到 NAS：

```bash
npm run reports:migrate-webdav -- --dry-run   # 先看计划
npm run reports:migrate-webdav                # 上传 + 回写索引（本地文件保留）
npm run reports:migrate-webdav -- --purge     # 收尾：删掉本地正文与空目录
```

脚本幂等，可以反复跑；有失败会逐条列出并以非 0 退出码结束。

三点注意：

1. 地址里**不要内嵌账号密码**（校验会拦下），用户名与密码分开填；认证只支持 Basic，明文 `http://` 会把密码裸奔在局域网里，能用 `https` 就用 `https`。
2. 「浏览根目录」决定能浏览的范围，建议设成一个专用子目录；远端删除刻意不提供，删文件请用 NAS 自己的界面。
3. **配了地址不会自动对所有人开放「重要文件」的远端通道**：每个人都要在设置页里保存一次自己的账号（NAS 允许匿名访问就留空保存）——
   这样没在用 WebDAV 的人不会被远端探测拖慢，也不会看到「远端不可达」的告警。**周报上传不受这条影响**：它用统一账号，成员不用配任何东西。

完整说明（结构、边界、取舍、排障）见 [`docs/harness/WEBDAV.md`](docs/harness/WEBDAV.md)。

> NAS 层的可见性：周报统一账号写入的是一个共享目录，能打开该共享的人可以看到所有人的周报。
> 应用里的组织隔离（跨组织 404）仍然生效，但它管不到 NAS 界面——要收紧只能靠 NAS 自己的共享权限。

## 数据与备份

- `data/workbench.sqlite`：正式服务的数据源。
- `data/backups/`：正式 SQLite 备份目录，执行 `npm run db:backup` 手动生成备份；数据库结构迁移前也会自动备份。
- `data/uploads/reports/`：**老式**周报正文目录——D-46 起新正文只写 NAS，这里只剩下还没被
  `npm run reports:migrate-webdav` 搬走的文件；搬完（`--purge`）就可以不再关心它。
- WebDAV 上的文件**不复制到本机**：「重要文件」只存 `webdav:<相对路径>` 形式的路径索引，
  周报也只在 NAS 上保留正文。
- 旧的 JSON 数据源和 Electron 相关代码已移入 `_archive/legacy-electron/`；迁移前的 Fastify + Vite SPA 实现已移入 `_archive/legacy-fastify/`。当前实现不读取、不依赖这两处。

## 部署（Jenkins CI/CD）

正式环境是「**Jenkins 构建 → SSH → Linux 目标机 systemd**」：

- 触发：GitHub push 到 `main` → webhook → Jenkins；
- 构建：装依赖 → lint / format / typecheck / antd lint → 构建 → 测试 → 打包成
  `dist/personal-workbench-<sha>-<build>.tar.gz`（**内含生产依赖**，目标机不需要联网装包）；
- 发布：`scp` 上传 → `ssh` 调用目标机的 `deploy.sh deploy`：解包到
  `releases/<时间戳>-<sha>/` → 原子切换 `current` 软链接 → 重启 systemd → 探 `/api/ping`
  （要求 `status=ok` **且** `database.status=ready`），不通过就自动切回上一个 release。

数据与配置都在 `shared/` 下（`shared/data/`、`shared/.env`），**不随 release 替换**；每次部署前会先停服再备份数据库，保证快照一致。回滚只回代码，**不回数据库结构**，这条边界必须清楚。

```bash
# 日常入口（目标机上）
sudo /opt/personal-workbench/bin/deploy.sh status | rollback | logs
```

完整步骤（目标机准备、Jenkins 凭据与 webhook、首次接入、排障、安全清单）见
[`deploy/README-DEPLOY.md`](deploy/README-DEPLOY.md)。

## 代码规范与验证命令

源码只写 TypeScript（`.ts`/`.tsx`/`.mts`，禁用 `.js`）；UI 统一用 antd v6，规范细则见 [`docs/harness/CODE_STYLE.md`](docs/harness/CODE_STYLE.md)。仓库根 `AGENTS.md` 与 `.agents/skills/antd/` 是官方 Ant Design CLI skill，写 antd 代码前先用 `npx antd info/demo/doc` 查权威 API。

```bash
npm run lint          # oxlint，门禁 0 warning / 0 error
npx antd lint app     # antd 官方检查：必须 No issues found
npm run typecheck     # server + tools + app + test 四个工程
npm run build         # 客户端 + SSR 产物（build/）
npm test              # 依次 test:db → test:webdav → test:api → test:auth → test:ui
npm run format:check  # 确认没有 Prettier 格式漂移
```

`npm test` 的五个环节：

| 脚本          | 内容                                                                                         | 当前基线       |
| ------------- | -------------------------------------------------------------------------------------------- | -------------- |
| `test:db`     | SQLite 备份 / JSON 迁移 / 迁移前备份 / 账号密码 / 自举 / **周报远端存储与搬迁 CLI**          | 25 项          |
| `test:webdav` | WebDAV 客户端（本地假服务器）：PROPFIND 解析 / 路径越界 / 上传补建目录 / 条件上传 / 流式下载 | 13 项          |
| `test:api`    | 318 条 HTTP 契约用例，逐条对比 `test/contract/golden/contract.golden.json`                   | 318 条全部一致 |
| `test:auth`   | 端到端：注册 → 登录 → 强制改密门禁 → 改密 → 业务端点恢复                                     | 2 项           |
| `test:ui`     | SSR 冒烟：登录 → 外壳 → 各页面是否渲染出真实数据 + 组织隔离/角色回弹                         | 90 项检查      |

除 `test:db` / `test:webdav` 外都需要先 `npm run build`（它们通过 `npm run serve` 拉起真实服务）。测试使用临时数据库与临时上传目录，不会访问或修改正式数据；周报上传/下载类用例跑在**本地假 WebDAV**（`tools/webdav/fake-server.ts`）上，不依赖真实 NAS。

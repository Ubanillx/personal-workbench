# 部署与 CI/CD（Jenkins 构建 → SSH → Linux + systemd）

本文是 `personal-workbench` 的**上线手册**：目标机上怎么摆、Jenkins 上怎么配、出事怎么回滚。

## 1. 整体形状

```text
GitHub push (main)
      │  webhook
      ▼
Jenkins（构建机，需要 Node >= 22.9）
      │  1) npm ci → lint / format:check / typecheck / antd lint
      │  2) npm run build（客户端 + SSR 产物 → build/）
      │  3) 测试：数据层 / WebDAV / HTTP 契约 / 鉴权 / SSR 冒烟
      │  4) 打包 dist/personal-workbench-<sha>-<build>.tar.gz（含生产依赖）
      │  5) scp 上传 + ssh 执行 sudo deploy.sh deploy
      ▼
目标服务器（Linux + systemd）
      /opt/personal-workbench
      ├── releases/20260911-142530-a1b2c3d4/   ← 每次部署生成一个新目录
      ├── current -> releases/20260911-142530-…  ← 原子切换的软链接（systemd 跑的就是它）
      ├── shared/.env                            ← 配置：人工维护，部署流程不碰它
      ├── shared/data/                           ← SQLite + 上传文件：绝不放进 release
      ├── shared/backups/                        ← 每次部署前的一致性快照
      ├── share/deploy-templates/                ← systemd 单元 / .env / sudoers 模板
      ├── bin/deploy.sh                          ← 目标机唯一入口（init/deploy/rollback/status/logs）
      └── incoming/                              ← 上传的产物，部署成功后自清理
```

**职责划分（刻意的）**：

| 事情                                     | 谁做           | 在哪                                   |
| ---------------------------------------- | -------------- | -------------------------------------- |
| 装依赖、编译、跑测试、打 tar 包          | Jenkins        | `Jenkinsfile`                          |
| 传产物、发起部署请求                     | Jenkins        | `deploy/jenkins-remote.sh`             |
| 解包、切软链接、备份、健康检查、自动回滚 | 目标机         | `deploy/remote-deploy.sh`              |
| 常驻进程、崩溃重启、开机自启             | systemd        | `deploy/personal-workbench.service.in` |
| 端口 / 数据库路径 / WebDAV 地址          | 人工（一次性） | 目标机 `shared/.env`                   |

目标机**不需要联网装包、不需要 devDependencies、不需要 TypeScript 工具链**：release 里已经带好了 `build/` 与生产 `node_modules/`。

---

## 2. 一次性准备

### 2.1 目标服务器

| 要求     | 说明                                                                                    |
| -------- | --------------------------------------------------------------------------------------- |
| 操作系统 | Linux + systemd（CentOS 7+/Ubuntu 18.04+ 均可）                                         |
| Node.js  | **>= 22.9.0**，且必须**系统级**可用（`/usr/bin/node` 或类似路径）                       |
| 必备命令 | `systemctl`、`tar`、`useradd`、`visudo`、`sha256sum`；`curl` 可选（没有就用 node 探活） |
| 磁盘     | 每个 release 约 130–200 MB（含生产依赖），默认保留 5 个 → 预留 2 GB 以上                |

> **Node 用 nvm 装在某个用户下会导致部署失败**：systemd 与 sudo 环境里找不到那个 `node`。
> 用发行版仓库或 NodeSource 做系统级安装；实在要用 nvm，就用 `--node-bin` 指绝对路径（但 systemd 单元里也会写死这个路径）。

### 2.2 Jenkins 构建机

| 要求    | 说明                                                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 插件    | GitHub（webhook 触发）、Credentials Binding、Pipeline（含 `sshUserPrivateKey`）                                                                       |
| Node.js | >= 22.9.0，且必须在 **PATH** 里（npm 脚本统一用 `node` 启动，不写绝对路径）；「准备」阶段会校验版本，并校验 PATH 的 `node` 与 `npm` 用的是同一个 Node |
| 命令    | `git`、`ssh`、`scp`、`tar`、`sha256sum`（OpenSSH >= 7.6，用到 `accept-new`）                                                                          |
| 凭据    | 一条 **SSH Username with private key**，ID 默认 `workbench-deploy-ssh`                                                                                |

私钥对应的公钥要装到目标机的部署账号上。**私钥不要设密码短语**：`jenkins-remote.sh` 用 `BatchMode=yes`，无法交互输入密码。确实需要密码短语时，把 `deploy/jenkins-remote.sh` 的 ssh 调用换成 Jenkins 的 `sshagent` 步骤。

### 2.3 目标机上的账号与免密 sudo

需要两个账号，职责分开：

- **`workbench`**：跑服务的系统账号，不能登录、不写代码目录，只能写 `shared/`；
- **`deploy`**：Jenkins SSH 登录用的账号，只被授权免密执行一条命令。

```bash
# 在目标机上以 root 执行（Jenkins 用的公钥装给 deploy）
useradd -m -s /bin/bash deploy
install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
# 把 Jenkins 凭据里那把私钥对应的公钥追加进 authorized_keys
```

`deploy.sh init` 会自动写好 `/etc/sudoers.d/personal-workbench`（内容只有一行命令授权，见 `deploy/sudoers.personal-workbench.in`）。
**首次 init 必须由管理员手工执行一次**——那时 sudoers 还不存在，Jenkins 没有权限创建它。

---

## 3. 首次接入（按顺序做一遍）

### 第 1 步：把部署脚本送到目标机并初始化

在开发机（或任意能 ssh 的机器）上，于仓库根目录执行：

```bash
scp -r deploy deploy@<目标机>:/tmp/pw-deploy
ssh deploy@<目标机> 'sudo bash /tmp/pw-deploy/remote-deploy.sh init --templates-dir /tmp/pw-deploy'
```

`init` 做的事（幂等，可以重复跑）：

1. 创建系统账号 `workbench`；
2. 建目录 `releases/ shared/data/ shared/backups/ bin/ incoming/ share/deploy-templates/`；
3. 渲染 `.env` 到 `shared/.env`（**只在文件不存在时生成**，之后再跑不会覆盖）；
4. 安装 systemd 单元 `personal-workbench.service` 并 `enable`；
5. 安装 sudoers 片段（只授权 `<ROOT>/bin/deploy.sh` 一条命令）；
6. 把脚本自身安装到 `<ROOT>/bin/deploy.sh`。

### 第 2 步：确认配置

```bash
ssh deploy@<目标机> 'sudo vi /opt/personal-workbench/shared/.env'
```

至少要确认 `PORT`、`HOST`（`0.0.0.0` = 局域网可直连；前面挂 nginx 就改 `127.0.0.1`）、`WEBDAV_URL`。

### 第 3 步：Jenkins 建任务

- 类型：**Pipeline**，Definition 选 **Pipeline script from SCM**，SCM 指向本仓库，脚本路径 `Jenkinsfile`；
- 分支：`main`（多分支任务更好，`Jenkinsfile` 里已经用 `BRANCH_NAME == 'main'` 做部署门禁）；
- 参数不用手填：`DEPLOY_HOST` 留空时，流水线会回落到仓库里写死的默认目标机（`Jenkinsfile` 的 `env.DEPLOY_TARGET_HOST`，当前 `192.168.3.251`）；
  要发布到别的机器才需要显式填 `DEPLOY_HOST`；只想出包不发布请把 `ACTION` 选成 `build-only`；
- 勾选 **GitHub hook trigger for GITScm polling**（`Jenkinsfile` 里的 `triggers { githubPush() }` 会声明它，缺 GitHub 插件时删掉那行、改为在任务里手勾）。

### 第 4 步：GitHub 配 webhook

仓库 → Settings → Webhooks → Add webhook：

- Payload URL：`http://<jenkins 地址>/github-webhook/`（结尾的斜杠不能少）
- Content type：`application/json`
- 事件：**Just the push event**

### 第 5 步：跑第一次部署

在 Jenkins 上点「Build with Parameters」，`ACTION=deploy`。成功后：

```bash
ssh deploy@<目标机> 'sudo /opt/personal-workbench/bin/deploy.sh status'
```

### 第 6 步：给管理员生成初始密码

全新数据库第一次启动后，默认管理员 `admin` 的密码是锁定占位值，任何密码都登不进。需要在数据所在的机器上生成一次：

```bash
ssh deploy@<目标机> 'sudo systemctl stop personal-workbench'
ssh deploy@<目标机> 'cd /opt/personal-workbench/current && sudo -u workbench ./node_modules/.bin/tsx server/src/cli/init-passwords.ts --confirm'
ssh deploy@<目标机> 'sudo systemctl start personal-workbench'
```

密码只在终端打印一次，用它登录 `admin`，首次登录会强制改密。

> 为什么停服再做：这一步要独占写数据库，避免和服务进程抢 SQLite 写锁。

---

## 4. 日常流程

- **正常发布**：向 `main` push → webhook → Jenkins 自动跑完 → 目标机切换并重启。
  只有 `main` 分支会部署；其他分支（多分支任务）只构建、只跑测试。
  目标机取 `DEPLOY_HOST`，留空就用 `Jenkinsfile` 里 `env.DEPLOY_TARGET_HOST` 的默认值（所以 hook 触发的构建也能直接发布）。
- **只想出包不发布**：`ACTION=build-only`，产物在 Jenkins 构建页的 Artifacts 里。
- **出事了要回滚**：`ACTION=rollback`（见 §5）。
- **要不要跑测试**：`ACTION=deploy` 时**一律跳过测试**（发布要快，只跑 lint / format / typecheck / antd lint / build）。
  想跑完整测试（数据层 / WebDAV / 契约 / 鉴权 / SSR 冒烟）就用 `ACTION=build-only` 并勾上 `RUN_TESTS`（默认已改为不勾），或者本地 `npm test`。

产物 `dist/personal-workbench-<sha>-<build>.tar.gz` 里装的是：

```text
package.json  package-lock.json  tsconfig.json   RELEASE.txt（版本信息，status 会打印）
build/      客户端 + SSR 产物
node_modules/  只有生产依赖（含 tsx，运维 CLI 需要）
server/     CLI 与迁移源码（user:init / user:passwd / user:list / db:backup 都用 tsx 直接跑 TS）
shared/     共享类型
```

> `tsx` 之所以在 `dependencies` 而不是 `devDependencies`：目标机上的运维命令（改密码、备份、生成初始密码）
> 全靠它跑 TS 源码。Jenkins 的打包阶段会检查 `node_modules/.bin/tsx` 是否存在，缺了就让构建失败。

---

## 5. 数据、迁移与回滚的真实边界

**数据位置**：`shared/data/workbench.sqlite` 与 `shared/data/uploads/reports/`。它们在 release 之外，所以部署、回滚、清理旧 release 都不会碰到数据。回滚 = 换代码，数据原地不动。

**每次部署前的一致性备份**：`deploy` 会先 `systemctl stop`（保证 SQLite 快照干净），再把数据库连同 `-wal` / `-shm` 复制到 `shared/backups/`，默认保留最近 20 份。

**回滚会做/不会做的事**：

| 会做                                   | 不会做                                  |
| -------------------------------------- | --------------------------------------- |
| 把 `current` 切回上一个 release 并重启 | **不会回滚数据库结构**                  |
| 健康检查不通过时自动回滚（部署阶段）   | 不会自动恢复 `shared/backups/` 里的快照 |

这一点必须清楚：应用启动时会自动执行迁移。如果新版本已经把库结构改掉了，再回滚到旧代码，旧代码面对新库可能直接报错。所以：

- **自动回滚是止血，不是终点**。它保证「至少还是上一版在跑」，之后要人工判断；
- 判断顺序：先看 `journalctl` 里的真实报错 → 能前滚修复就前滚（推荐）→ 真要退库，才从 `shared/backups/` 恢复快照，**并接受这段时间的数据丢失**。

---

## 6. 运维命令速查

目标机上（Jenkins 里也走同一套）：

```bash
sudo /opt/personal-workbench/bin/deploy.sh status          # 当前版本 / 服务状态 / 健康检查 / 历史 release
sudo /opt/personal-workbench/bin/deploy.sh logs --lines 200 # journalctl
sudo /opt/personal-workbench/bin/deploy.sh rollback         # 回滚到上一个 release
sudo /opt/personal-workbench/bin/deploy.sh rollback --to 20260910-093000-a1b2c3d4
sudo /opt/personal-workbench/bin/deploy.sh prune --keep 3   # 只留 3 个 release
sudo /opt/personal-workbench/bin/deploy.sh deploy --archive /path/to/xxx.tar.gz --sha256 <hex> --sha <sha>
```

服务本身：

```bash
systemctl status personal-workbench
systemctl restart personal-workbench
journalctl -u personal-workbench -f
```

配置改动（`shared/.env`）**必须重启服务才生效**。

---

## 7. 排障

| 现象                                              | 原因与处理                                                                                                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `目标机上还没有 …/bin/deploy.sh`                  | 没做 §3 第 1 步的一次性 init。按提示执行即可。                                                                                                                                                  |
| `sudo: no tty present` / `a password is required` | sudoers 片段没装或账号不对；确认 `/etc/sudoers.d/personal-workbench` 存在且部署账号在授权行里。                                                                                                 |
| init 报 `sudoers 模板校验失败`                    | Ubuntu 25.10+ 默认的 sudo 是 **sudo-rs**，不认识模板里的 `Defaults:… !requiretty`（`unknown setting: 'requiretty'`）。init 会自动改用去掉该行的版本；两条都不通过时才会打印渲染结果让人工检查。 |
| 部署脚本报 `Node 版本过低`                        | 目标机的 `node` 太旧，或 systemd/sudo 环境里根本没找到 node（nvm 装的）。换系统级安装或 `--node-bin`。                                                                                          |
| 健康检查超时，已自动回滚                          | 看回滚前打印的 `journalctl` 片段。常见：`.env` 里 `PORT` 与防火墙/占用冲突、`DATABASE_PATH` 目录不可写、迁移失败。                                                                              |
| `EADDRINUSE`                                      | 端口被别的进程占了：`ss -lntp \| grep 17500`。注意服务是 `User=workbench`，需要相应权限才能看到占用者。                                                                                         |
| SSH 报 `Host key verification failed`             | 目标机换过主机密钥（重装/换机）。删掉 Jenkins 构建机 `~/.ssh/known_hosts` 里对应条目后重跑。                                                                                                    |
| `npm ci` 报 package.json 与 lockfile 不同步       | 改了 `package.json` 的依赖分类或版本却没更新 lockfile。本地跑 `npm install --package-lock-only` 后提交 `package-lock.json`。                                                                    |
| 构建在 `rm build/` 一步失败                       | Windows 上才会遇到：`tools/build/prebuild.ts` 会先清理占用进程。Linux 构建机不会（Jenkins 上构建/测试/打包是同一次构建产物）。                                                                  |
| 成员访问不到                                      | `HOST` 必须是 `0.0.0.0`，且防火墙放行 `PORT`；`127.0.0.1` 只在本机可访问。                                                                                                                      |

**遇到部署失败先看这三处**：

1. Jenkins 控制台里 `deploy` 阶段的输出（远端脚本的日志原样透传）；
2. `sudo deploy.sh status`（当前指向哪个 release、服务是否是 `failed`）；
3. `journalctl -u personal-workbench -n 100 --no-pager`。

---

## 8. 安全清单

- [ ] 部署私钥只放在 Jenkins 凭据里，不落仓库、不写进脚本；
- [ ] `shared/.env` 权限 `0640 root:workbench`——服务账号只读，不给写权限；
- [ ] sudoers 只授权 `<ROOT>/bin/deploy.sh` 一个绝对路径，**不要** `NOPASSWD: ALL`；
- [ ] 目标机防火墙只放行可信网段（`HOST=0.0.0.0` 时尤其重要）；只在内网用就别暴露到公网；
- [ ] WebDAV 能用 `https` 就用 `https`（Basic 认证在明文 http 下等于明文传密码），且地址里不要内嵌账号密码；
- [ ] `shared/backups/` 里的数据库快照含真实业务数据，别提交、别随手拷到不安全的地方。

---

## 9. 可选：前面挂 nginx

目标是让外部只看到一个端口、方便以后加 TLS。此时 `.env` 里把 `HOST` 改成 `127.0.0.1`：

```nginx
server {
  listen 80;
  server_name workbench.example.internal;

  client_max_body_size 100m;   # 周报上传

  location / {
    proxy_pass http://127.0.0.1:17500;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;   # 通知流（/api/notifications/stream）需要
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;                 # 长连接别被 60s 默认值掐断
    proxy_buffering off;                      # SSE 不被缓冲
  }
}
```

注意：应用自身是 http，`Secure` Cookie 之类的判断依赖 `X-Forwarded-Proto`；如果将来上 https，请连同反向代理配置一起调整并在测试环境验证登录链路。

---

## 10. 本地/无 Jenkins 时的等价操作

没有 Jenkins 也能完成同样的发布（产物来源换成自己构建）：

```bash
npm ci
npm run build
# 按 Jenkinsfile「打包」阶段的做法组装 .release/ 并打 tar（或直接用 Jenkins 下下来的 tar 包）
bash deploy/jenkins-remote.sh deploy   # 需要 SSH_USER / SSH_KEY_FILE / TARGET_HOST 等环境变量
```

`jenkins-remote.sh` 只负责「上传 + 调用远端脚本」，所以它在本地和 CI 里的行为完全一致。

# 账号密码 + 多组织改造设计（已确认）

状态：**已实施完成（2026-09-11）**。本文是这次改造的唯一权威口径；实施中如有偏离，先改本文再改代码。

## 1. 背景与目标

现状是「令牌登录 + 三角色（主人/助理/查看者）+ 单组织」，`users.role` 还有只允许旧三个值的 CHECK 约束。
本次改造要做三件事，**互相独立可分阶段交付**：

1. **认证**：令牌 → 用户名 + 邮箱 + 密码（可自助注册）。
2. **角色**：主人/助理/查看者 → **管理员 / 组织管理者 / 普通用户**。
3. **多组织**：新增组织实体，任务、待办、随手记、重要文件、周报按组织隔离。

非目标（本次不做）：邮箱验证与邮件找回密码（本机没有邮件服务）、多组织成员身份（一人只属一个组织）、
组织内的细分权限位（如「只读成员」）、把 `api_tokens` 死表一起清理（属 `DEBT-05`，另行处理）。

## 2. 决策记录

| ID   | 决策                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-18 | 引入**多组织**：新增 `organizations` 表，业务数据按组织隔离                                                                                                                                                                                                                                                                                                                                                                  |
| D-19 | 三个角色：`admin` 管理员、`manager` 组织管理者、`member` 普通用户；**取消**只读的 `viewer`                                                                                                                                                                                                                                                                                                                                   |
| D-20 | **开放注册**，注册后即为普通用户、可立即登录，但**尚无组织**                                                                                                                                                                                                                                                                                                                                                                 |
| D-21 | 登录标识为**用户名 + 邮箱 + 密码**（用户名校验登录，邮箱用于唯一性与记录，本期不发信）                                                                                                                                                                                                                                                                                                                                       |
| D-22 | **旧令牌全部作废**；迁移时给 5 个旧账号分配用户名与初始密码，由本机 CLI 打印一次                                                                                                                                                                                                                                                                                                                                             |
| D-23 | 忘记密码只能**本机 CLI 重置**（`npm run user:passwd`），不提供网页端重置                                                                                                                                                                                                                                                                                                                                                     |
| D-24 | 注册后**无组织**：能看到组织列表 → 提交入组申请 → 该组织的组织管理者审批通过后加入                                                                                                                                                                                                                                                                                                                                           |
| D-25 | **一人只属于一个组织**（`users.org_id` 单值）                                                                                                                                                                                                                                                                                                                                                                                |
| D-26 | **管理员是全局角色**，跨所有组织；不隶属任何组织（`org_id` 为 `NULL`）                                                                                                                                                                                                                                                                                                                                                       |
| D-27 | 组织管理者权限：管理本组织成员、管理与指派本组织全部任务、审批本组织周报、访问本组织验收视图与文件库、改组织信息（改名/解散）                                                                                                                                                                                                                                                                                                |
| D-28 | 管理员默认看到**全部组织的合并视图 + 组织筛选器**                                                                                                                                                                                                                                                                                                                                                                            |
| D-29 | 迁移时建立**初始组织**，5 个旧账号与全部现有数据归入该组织；`owner` → 全局管理员，按 `created_at` 最早的助理 → 该组织管理者                                                                                                                                                                                                                                                                                                  |
| D-30 | 一个人**同时只能有一个待审批申请**                                                                                                                                                                                                                                                                                                                                                                                           |
| D-31 | 组织管理者可以**直接把一个尚无组织的账号拉进本组织**（无需对方申请），被拉的人收到站内通知                                                                                                                                                                                                                                                                                                                                   |
| D-32 | **退出组织需要管理者批准**（提交退出申请 → 本组织管理者审批）                                                                                                                                                                                                                                                                                                                                                                |
| D-33 | **解散 = 归档**：组织标记为 `archived`，成员全部退回「未加入」状态，数据保留但不可访问，全局管理员可恢复                                                                                                                                                                                                                                                                                                                     |
| D-34 | 未加入组织的账号登录后**只能**访问「组织列表 + 我的申请」页，其余页面一律重定向回来                                                                                                                                                                                                                                                                                                                                          |
| D-35 | 组织边界用 **404**（跨组织按 id 访问一律「未找到该资源」，不泄露存在性）；**同一组织内无可见权仍返回 403**（保留旧契约形状，不扩大改动面）                                                                                                                                                                                                                                                                                   |
| D-36 | 私密任务的负责人必须是**创建者本人**（只有 admin/manager 能建私密任务；member 传 `isPrivate` 会降级为普通任务）——**已由 D-54 取消**：负责人可以是本组织其他人，「发布人 / 负责人」是两个独立的可见方，见 §23.1                                                                                                                                                                                                               |
| D-37 | 任务**指派范围 = 任务所属组织的成员**；全局管理员例外（admin 不隶属组织，旧模型允许 admin 当负责人）                                                                                                                                                                                                                                                                                                                         |
| D-38 | 任务载荷（`toTaskView`）增加 `orgId` / `orgName`，供管理员在合并视图里看出每行属于哪个组织（D-28）                                                                                                                                                                                                                                                                                                                           |
| D-39 | **数据库自举**：应用启动（迁移之后）保证「有管理员 + 有默认组织」。全新空库自动建 `admin` 与 `org-default`「默认组织」（`created_by` = 该管理员）；已有管理员只补组织；幂等。管理员密码默认 `locked$` 占位（需 `npm run user:init`），给了 `WORKBENCH_ADMIN_PASSWORD` 则直接用它（D-51）                                                                                                                                     |
| D-40 | **概览页只读化**：`/` 只展示数据——移除新增待办的 action 与快捷表单；展板补齐逾期/临期任务、今日待办、任务状态分布、最近随手记、最近使用文件、未读通知。`GET /api/dashboard` 载荷保持逐字段不变（契约 golden 不重录）                                                                                                                                                                                                         |
| D-41 | **「重要文件」可选接入 WebDAV**（`WEBDAV_URL` 配了才启用）：可浏览远端目录、选文件登记索引（`file_path` 记 `webdav:<相对路径>`，不加列不迁移）、上传文件、列表显示远端大小/修改时间/是否还在。远端删除刻意不做；细节见 [`WEBDAV.md`](WEBDAV.md)                                                                                                                                                                              |
| D-42 | **三个「管理」页面合并为 `/settings`**：原 `/organization`、`/admin` 变成 Tab，`/collaboration` 整页退役；Tab 按角色显示，旧 URL 直接 404（§19）                                                                                                                                                                                                                                                                             |
| D-43 | **WebDAV 配置改为按账号 + 网页配置**：新表 `webdav_settings`（迁移 011），`/settings?tab=webdav` 维护；不再读环境变量；浏览/上传/探测都用当前账号的配置（§20；**地址部分已由 D-44 收回环境变量**）                                                                                                                                                                                                                           |
| D-44 | **WebDAV 配置拆成「地址部署级 + 凭据按账号」**：地址回到环境变量 `WEBDAV_URL`（团队共用一台 NAS），用户名/密码/浏览根/超时仍按账号落库；迁移 012 删掉 `webdav_settings.url`；「浏览根目录」同时接受 Linux 与 Windows 写法；顺带修复 `.env` 不生效（DEBT-02）（§21）                                                                                                                                                          |
| D-47 | **CRUD 字段与列表字段强制对齐**：列表显示的每一列都要在新建/编辑抽屉里有对应字段或明确入口；同一个字段在列表、筛选器、表单里只用一个说法；任务**可以换所属组织**（只有 admin，迁移 013 加 `task_moved` 事件），负责人与所属组织在编辑抽屉里直接可改（§22）                                                                                                                                                                   |
| D-54 | **权限规则调整（2026-09-14）**：① 私密任务可见方 = **发布人 / 负责人 / 全局管理员**（组织管理者不因角色获得他人的私密任务；负责人不再必须是创建者，D-36 那条限制取消）；② 普通成员可看**本组织全部非私密任务**；③ 待办与随手记改为**本人数据**（迁移 017 加 `owner_id`，管理员也只看自己的）；④ 重要文件查看/新增/编辑对组织内所有人开放、**删除只给管理者**；⑤ 周报改为**组织内全可见**（只有重传与审批分角色）。逐条见 §23 |

## 3. 数据模型

### 3.1 新增表

```sql
CREATE TABLE organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE organization_join_requests (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('join', 'leave', 'invite')),
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  message       TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  decided_at    TEXT,
  decided_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision_note TEXT NOT NULL DEFAULT ''
);

-- 「同时只能有一个待审批申请」由部分唯一索引强制（join 与 leave 各自唯一）
CREATE UNIQUE INDEX idx_join_requests_pending_user
  ON organization_join_requests(user_id) WHERE status = 'pending';
CREATE INDEX idx_join_requests_org_status ON organization_join_requests(org_id, status, created_at);
```

`kind` 的用法：`join` = 申请人主动申请加入；`leave` = 成员申请退出；`invite` = 组织管理者直接拉人入组
（直接写入 `status='approved'`，`decided_by` 记为操作者），这样「谁在什么时候把谁拉进来/批出去」有完整台账。

### 3.2 重建 `users`（SQLite 改不了 CHECK，必须建新表搬数据）

新结构：

```sql
CREATE TABLE users_new (
  id                   TEXT PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE,
  email                TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'member')),
  org_id               TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1)),
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  -- 只有这两条真不变量交给数据库兜住；普通成员允许没有组织
  CHECK (role <> 'manager' OR org_id IS NOT NULL),
  CHECK (role <> 'admin' OR org_id IS NULL)
);
```

> **约束为什么是弱化形式而不是「非管理员必须有组织」**：注册（D-20）产生的正是「`member` 且 `org_id` 为 NULL」的账号
> （D-24：注册后无组织，申请通过才入组）；解散组织（D-33）、被移出组织、同意退出（D-32）也都会把人退回这个状态。
> 初版写成 `CHECK (role = 'admin' OR org_id IS NOT NULL)`，会让**上面四条路径全部失败**（注册直接 500）——
> 这是实现时被 `npm run contract:fixture` 撞出来的真实缺陷。
> 最终的写法两头都要：`manager` 必须有组织、`admin` 不得隶属组织交由数据库保证，`member` 两种形态都合法。

迁移时的确定性回填（`password_hash` 用一个**永不匹配**的占位值，等 CLI 设真实密码）：

| 旧账号                    | 新 username                   | 新 email                   | 新 role   | org_id      |
| ------------------------- | ----------------------------- | -------------------------- | --------- | ----------- |
| `role='owner'`            | `admin`                       | `admin@local.invalid`      | `admin`   | `NULL`      |
| 最早创建的 `assistant`    | `member-<id 去横线取前 6 位>` | `<username>@local.invalid` | `manager` | 初始组织 id |
| 其余 `assistant`/`viewer` | 同上                          | 同上                       | `member`  | 初始组织 id |

- `@local.invalid` 用 RFC 2606 保留 TLD，明确表示「占位、不可达」。
- `password_hash` 占位值格式为 `locked$`，登录校验遇到该前缀**直接判定失败**，避免任何密码碰巧通过。
- 全部旧账号 `must_change_password = 1`，首次登录强制改密。
- 初始组织 id 固定为 `org-default`，名称「默认组织」（之后可改），`created_by` 为迁移后的管理员 id。

### 3.3 重建 `task_comments`（`author_role` 的 CHECK 也锁死了旧角色）

```sql
CREATE TABLE task_comments_new (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT,
  author_role TEXT CHECK (author_role IS NULL OR author_role IN ('admin', 'manager', 'member')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
```

历史行的 `author_role` 映射：`owner`→`admin`、`assistant`/`viewer`→`member`（历史事实按原样保留，不据新的组织角色改写）。

### 3.4 业务表加 `org_id`

| 表                                                     | 改动                                                                                               | 隔离方式                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `tasks`                                                | 重建，加 `org_id TEXT NOT NULL REFERENCES organizations(id)`                                       | 直接过滤 + 索引 `(org_id, status, due_date)` |
| `todos`                                                | 重建，加 `org_id`（**当前没有归属字段**，是全局共享的）；017 再加 `owner_id`（**本人数据**，D-54） | 直接过滤（`owner_id = 本人`）                |
| `notes`                                                | 重建，加 `org_id`（同上）；017 再加 `owner_id`（同上）                                             | 直接过滤（`owner_id = 本人`）                |
| `important_files`                                      | 重建，加 `org_id`（同上）                                                                          | 直接过滤（**组织公共数据**，不按人过滤）     |
| `weekly_reports`                                       | 重建，加 `org_id`                                                                                  | 直接过滤                                     |
| `task_progress_logs` / `task_comments` / `task_events` | 不加列                                                                                             | 经 `task_id` → `tasks.org_id` + 任务可见性   |
| `report_files`                                         | 不加列                                                                                             | 经 `report_id` → `weekly_reports.org_id`     |
| `notifications`                                        | 不加列                                                                                             | 经 `recipient_id` → `users.org_id`           |
| `access_sessions`                                      | 不变                                                                                               | 经 `user_id`                                 |

`data/uploads/reports/<reportId>/` 目录结构不变——`reportId` 已隐含组织，不需要再分一层目录。

### 3.5 删除 `access_tokens`

令牌登录整体退役，表一并 `DROP`。`server/src/security/owner-token.ts` 与 `npm run owner:reset` 同时退役，
由 `server/src/cli/set-password.ts` 取代（见 §5.4）。

## 4. 角色与权限矩阵

| 能力                                   | `admin` 管理员          | `manager` 组织管理者                     | `member` 普通用户            |
| -------------------------------------- | ----------------------- | ---------------------------------------- | ---------------------------- |
| 查看组织列表                           | 全部（含已归档）        | 全部（含已归档，可看不可管）             | 全部 active（用于申请）      |
| 创建组织                               | ✅                      | ❌                                       | ❌                           |
| 改组织名/描述                          | ✅ 全部                 | ✅ 仅本组织                              | ❌                           |
| 解散（归档）/ 恢复组织                 | ✅                      | ✅ 仅本组织解散（归档）；恢复仅 admin    | ❌                           |
| 审批入组申请                           | ✅ 全部                 | ✅ 仅本组织                              | ❌                           |
| 直接拉无组织账号入组                   | ✅ 全部                 | ✅ 仅本组织                              | ❌                           |
| 审批退出申请                           | ✅ 全部                 | ✅ 仅本组织                              | ❌                           |
| 启用/停用成员、改成员角色              | ✅ 全部                 | ✅ 仅本组织，**不能**动 admin            | ❌                           |
| 把成员移出组织（退回未加入）           | ✅                      | ✅ 仅本组织                              | ❌                           |
| 任务：查看                             | ✅ 全部组织（带筛选器） | ✅ 本组织全部                            | 本组织全部非私密任务（D-54） |
| 任务：创建并指派负责人                 | ✅ 任意组织任意人       | ✅ 本组织任意人                          | 只能建给自己的               |
| 任务：改元信息/审批/退回/归档/删除     | ✅                      | ✅ 本组织（**看不见的私密任务除外**）    | ❌                           |
| 私密任务（`is_private=1`）             | ✅ 全部                 | 发布人或负责人才可见（D-54）             | 发布人或负责人才可见         |
| 待办 / 随手记                          | 仅自己的（D-54）        | 仅自己的（D-54）                         | 仅自己的（D-54）             |
| 周报：查看                             | ✅ 全部                 | ✅ 本组织全部                            | ✅ 本组织全部（D-54）        |
| 周报：提交                             | ✅                      | ✅ 本组织                                | 只能提交自己的               |
| 周报：审批/退回                        | ✅                      | ✅ 本组织                                | ❌                           |
| 周报：重传（退回后）                   | ✅                      | ✅ 本组织                                | 仅自己的（D-54）             |
| 周报：上传目录（`/settings → WebDAV`） | ✅ 任意组织（可切换）   | ✅ **仅本组织**（提交的 `orgId` 被忽略） | ❌（进不了设置页）           |
| 重要文件：查看 / 新增 / 编辑 / 下载    | ✅ 全部（带筛选器）     | ✅ 本组织                                | ✅ 本组织（D-54）            |
| 重要文件：删除                         | ✅ 全部                 | ✅ 本组织                                | ❌ `403`（D-54）             |
| 组织管理页、成员管理页                 | ✅ 全部（带筛选器）     | ✅ 本组织                                | ❌                           |
| 企微导入（在「任务进展」页内）         | ✅                      | ✅ 本组织                                | ✅ 限自己                    |
| 备份、CLI 级操作、改任何人的密码       | 只能在本机用 CLI        | ❌                                       | ❌                           |

**必须成立的不变式（要有测试盯着）**

1. 任何按 id 访问的跨组织请求返回 **404**（不返回 403，避免泄露资源是否存在）。
2. 组织管理者不能把自己的角色改掉，也不能把别人提升为 `admin`。
3. 组织里**最后一个 `manager`** 不能被停用、不能退出、不能降级，除非先指定另一个 `manager`——否则组织会变成无主。
4. `admin` 不能把自己降级（否则系统再无人能管理组织），只能由本机 CLI 恢复。
5. 归档组织下的数据：成员登录后处于「未加入」状态（因为成员已被退回），任何指向该组织数据的请求 404；管理员仍可查看。
6. 停用（`is_active=0`）账号立即失去会话（沿用现有 `sessionUser` 里的 `u.is_active=1` 条件）。
7. **私密任务「读得到」与「改得动」是同一件事**（D-54）：发布人 / 负责人 / 全局管理员以外的人，
   既在列表与详情里看不到它，也不能通过任何写接口（改元信息、进度、验收、归档、评论）碰到它。
   写侧与读侧共用同一个 `canView`，不允许出现「列表看不见、接口改得动」。
8. **待办与随手记只属于归属人**（D-54）：连全局管理员都只能看自己的；跨组织 404，
   同组织但不是本人 403。

## 5. 认证

### 5.1 注册

`POST /api/auth/register`，字段 `username`、`email`、`password`、`name`。
用户名 `^[a-zA-Z0-9_-]{3,32}$` 且唯一；邮箱格式校验且唯一；密码 ≥ 8 位（不做组成要求，本机自用）。
成功后直接建立会话（D-20），但因为没有组织，前端会把用户送到 `/join`（D-34）。

### 5.2 登录

`POST /api/auth/login`（`username` + `password`）→ 校验 scrypt → 建立会话 → 写 `workbench_session` Cookie。
沿用现有会话机制（`access_sessions` 只存 `sha256`、30 天、HttpOnly + SameSite=Lax），多设备并存。
登录失败统一返回 401 `UNAUTHENTICATED`「用户名或密码不正确」（不区分账号不存在与密码错，避免枚举）。
`must_change_password=1` 时，除改密与登出外的请求一律 403 `PASSWORD_CHANGE_REQUIRED`，前端重定向 `/password`。

### 5.3 密码哈希

Node 内置 `crypto.scrypt`（`N=16384, r=8, p=1, keylen=64`，16 字节随机盐），存储格式：

```text
scrypt$16384$8$1$<salt base64>$<hash base64>
```

校验用 `timingSafeEqual`。参数写进哈希串，将来调参不影响老密码。**不引入任何第三方依赖**。
`locked$` 前缀表示「未设置密码」，任何输入都判定失败（见 §3.2）。

改密接口 `POST /api/auth/password`：需要旧密码 + 新密码；成功后撤销该用户**其他**会话，保留当前会话。

### 5.4 管理员初始密码与密码重置

**管理员（就一个 `admin`）的初始密码走部署环境变量**（D-51）：

```text
WORKBENCH_ADMIN_PASSWORD=<至少 8 位>
```

- 自举（应用启动、迁移之后）读一次：只在 `admin` 的 `password_hash` 还是 `locked$` 时生效；
- 已有真密码的账号**永不覆盖** —— 这是开荒通道，不是重置通道；
- 值非法（少于 8 位/超过 200 位）只告警并忽略，管理员保持无密码状态；
- 不给这个变量 = 保持原行为：`locked$` 占位 + `user:init` 生成随机初始密码 + 首次登录强制改密；
- env 给的密码按**长期密码**处理（不强制首登改密）；要强制就用下一条的 `user:passwd`（默认强制）。

本机 CLI（不需要停服；`user:init` 那一步要独占写库，建议先停服）：

```bash
npm run user:list                      # 列出账号：用户名、邮箱、角色、组织、是否待改密
npm run user:passwd -- <用户名>         # 交互式输入新密码，或 --generate 打印一个随机密码
npm run user:init   -- --confirm       # 迁移后一次性初始化：给未设密码的账号生成初始密码并打印
```

- `user:init` 只处理 `password_hash` 为 `locked$` 的账号（幂等，重复执行不会覆盖已设密码）。
- 输出只在终端显示一次，不写日志、不落库明文。
- 与旧 `owner:reset` 一样：CLI 直接操作 `data/workbench.sqlite`，不需要服务停止（迁移类写操作走 `BEGIN IMMEDIATE` + `busy_timeout`）。

## 6. 组织流转

```text
注册 ──► 无组织 ──申请加入──► 待审批 ──管理者通过──► 组织成员（member）
                     │                  └──拒绝──► 可以再申请别的组织
                     └──管理者直接拉入──► 组织成员（member，记一条 invite 台账）
组织成员 ──申请退出──► 待审批 ──管理者通过──► 无组织（可再次申请）
组织（manager/admin）──解散──► archived：成员退回无组织，数据保留不可访问
```

规则细节：

- **同时只能有一个待审批申请**（D-30）：部分唯一索引兜底；已有一个 pending 时再提交返回 400 `REQUEST_EXISTS`。
  用户可撤回自己的申请（`DELETE /api/join-requests/:id`，仅限 `pending` 且本人）。
- 申请被拒后可以立刻重新申请（不设冷却），但会留下拒绝记录。
- **拉人入组**（D-31）：只能拉「`org_id IS NULL` 且 `role='member'` 且启用中」的账号；被拉的人收到 `org_invited` 通知。
  这个设计里「入组不需要本人同意、退出却需要批准」是**有意的不对称**（你明确选了这两条）；如果以后想改，只需把 invite 也改成待确认状态。
- **最后一个 manager 保护**：退出申请、停用、降级这三条路径都要检查「本组织是否还有其他可用 manager」，否则拒绝并提示先指定继任者。
- **解散**（D-33）：`status='archived'`、`archived_at` 记时间；该组织所有成员 `org_id=NULL`（`manager` 降为 `member`），
  所有 `pending` 申请置为 `cancelled`。数据保留。全局管理员可 `restore`（成员不会自动回来，需要重新申请或拉人）。
- 归档组织不允许新申请、拉人、创建任务；列表里标记为「已解散」。

## 7. 接口清单

### 7.1 新增（18）

| 方法   | 路径                             | 谁能用                     |
| ------ | -------------------------------- | -------------------------- |
| POST   | `/api/auth/register`             | 匿名                       |
| POST   | `/api/auth/login`                | 匿名                       |
| POST   | `/api/auth/password`             | 已登录                     |
| GET    | `/api/organizations`             | 已登录（按角色过滤内容）   |
| POST   | `/api/organizations`             | admin                      |
| PATCH  | `/api/organizations/:id`         | admin / 本组织 manager     |
| POST   | `/api/organizations/:id/archive` | admin / 本组织 manager     |
| POST   | `/api/organizations/:id/restore` | admin                      |
| GET    | `/api/organizations/:id/members` | admin / 本组织 manager     |
| POST   | `/api/organizations/:id/invite`  | admin / 本组织 manager     |
| PATCH  | `/api/members/:id`               | admin / 本组织 manager     |
| DELETE | `/api/members/:id`               | admin / 本组织 manager     |
| GET    | `/api/join-requests`             | 已登录（按角色给不同范围） |
| POST   | `/api/join-requests`             | 无组织用户                 |
| DELETE | `/api/join-requests/:id`         | 申请人本人（撤回）         |
| POST   | `/api/join-requests/:id/approve` | admin / 本组织 manager     |
| POST   | `/api/join-requests/:id/reject`  | admin / 本组织 manager     |
| POST   | `/api/leave-requests`            | 有组织成员                 |

### 7.2 删除（4）

`POST /api/auth/access`（令牌登录）、`POST /api/users/:id/token`（重签令牌）、`POST /api/users`（建号即发令牌）、
`GET /api/users`（改为 `GET /api/members`，语义与权限范围都变了）。`GET /api/access-info` 保留但仅 admin 可见。

### 7.3 改造（其余全部业务端点）

路径不变，行为变化是：所有查询按调用者的组织范围过滤；跨组织按 id 访问返回 404；
`GET /api/auth/me` 增加 `username`、`email`、`orgId`、`orgName`、`mustChangePassword` 字段。

端点总数从 48 变为 **65**（`app/routes/api.*.ts` 共 52 个文件，清单见 [`ARCHITECTURE.md`](ARCHITECTURE.md) 的「API 清单」）。

## 8. 页面

| 路由          | 变化                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/login`      | 新增（替代 `/access`）；`/access` 保留 302 到 `/login`，老书签不失效                                                     |
| `/register`   | 新增                                                                                                                     |
| `/password`   | 新增：强制改密页（`must_change_password=1` 时所有页面重定向到这里）                                                      |
| `/join`       | 未入组用户唯一能访问的页面：全屏入组（无侧栏），组织列表 + 申请加入 + 我的申请；已入组账号从账号菜单进入则仍在工作台壳内 |
| `/settings`   | 设置页：组织/成员/账号的统一入口，按角色显示 Tab（见 §19；合并前是 `/organization`、`/admin`、`/collaboration` 三页）    |
| 现有 8 个页面 | 全部接入组织上下文；admin 增加组织筛选器（D-28）                                                                         |
| 外壳导航      | 增加当前组织/组织切换器、用户名与角色显示；`/access` 链接改 `/login`                                                     |

## 9. 迁移与回滚

**迁移文件**：`009_accounts_and_organizations.sql`（新表 + 重建 `users`/`task_comments` + 5 张业务表加 `org_id` + 回填），
`010_drop_access_tokens.sql`（退役令牌表）。沿用 `004`/`008` 已验证的「建 `_new` → `INSERT…SELECT` → `DROP` → `RENAME`」模式。

### 9.1 暂存目录（A–D 阶段用过，现已启用）

B/C 开发期间这两个文件曾放在 `server/src/db/migrations-pending/`，**不会**被服务自动应用——因为
`009` 给 5 张业务表加的是 `NOT NULL org_id`，而旧代码插入这些表时不带 `org_id`，迁移一生效应用立刻写不进数据。

代码（B/C）落地后，它们已经 `git mv` 进 `server/src/db/migrations/` 并在分支上生效；
`migrations-pending/` 目录现在只剩一份 README 说明这段历史。

### 9.2 演练工具 `npm run db:rehearse`

```bash
npm run db:rehearse                 # 默认源：data/workbench.sqlite
npm run db:rehearse -- --keep       # 保留副本目录，便于继续手工验证
npm run db:rehearse -- --source <路径>
```

它做四件事：用 `node:sqlite` 的 `backup()` 取一致快照（服务不用停）→ 把 `migrations/` 与
`migrations-pending/` 合成一个临时目录交给**真实的 `SqliteMigrationRunner`** 执行（顺带验证 runner 的
「FK OFF + 单事务」行为）→ 逐表核对行数、账号映射、组织归属、约束是否真的生效 → 打印报告，任一项失败即 exit 1。

### 9.3 正式迁移流程（E 阶段，正式库只在最后一步动）

1. `npm run db:rehearse` 全绿（迁移前的库：**44 项 0 失败**，见 §12）。
   注意工具会检测源库是否**已经迁移过**：若 `009` 已应用，则 6 条「迁移后初始态」断言（全部账号 `locked$`、全部待改密、占位邮箱、非管理员在初始组织、组织管理者取最早助理）不再成立，工具会打印警告并**跳过**它们（输出「共 38 项，失败 0 项，跳过 6 项」），不会误报红灯。
2. 在保留下来的副本上跑 `npm run user:init -- --confirm`，用契约/冒烟工具打真实 HTTP 确认初始密码能登录。
3. 副本上跑四件套 + 契约全量回放。
4. 上述全绿后，才让正式服务加载新版本（`client.ts` 会在应用迁移前自动备份到 `data/backups/`，另有一份手工副本）。

**回滚**：迁移前的自动备份 + 手工副本都可直接替换回 `data/workbench.sqlite`；
旧实现（令牌登录）已归档在 `_archive/legacy-fastify/`，但**回滚到旧实现意味着放弃组织数据模型**，只适合刚迁移完就发现问题的情况。

### 9.4 落地顺序：B 与 C 必须一起上（重要）

B（用户名密码登录）和 C（组织隔离）**不能分两次落地**，原因是双向耦合：

- B 要读 `users.username` / `users.password_hash`，这两列只有 `009` 生效后才存在；
- `009` 给 5 张业务表加的是 `NOT NULL org_id`，只有 C 把所有插入改成带 `org_id` 之后，应用才写得进数据。

所以「009/010 启用 + B 的认证 + C 的隔离」是**同一次落地**。为了让 `main` 在此期间保持绿色：

1. 在分支 `feat/accounts-orgs` 上开发 B+C，`main` 不动、运行中的服务不动；
2. 分支内先让 `npm run db:rehearse` 与四件套全绿，再按新行为 `contract:capture` 重录认证域；
3. 全部绿了再把 009/010 `git mv` 进 `migrations/` 并合并回 `main`；
4. 合并后**不要立刻重启正式服务**，先按 §9.3 在副本上跑完 `user:init` 与契约回放，再重启。

> 注意：运行中的 `npm run serve` 进程已经把模块加载进内存，重新 `npm run build` 不会影响它；
> 但只要**重启**服务，它就会应用 `migrations/` 里的一切。迁移未验证完之前不要重启。

## 10. 分阶段实施计划

每个阶段独立验收（四件套 + `format:check` + `npx antd lint app` 全绿），上一阶段不绿不进下一阶段。

| 阶段         | 内容                                                                                                  | 验收                                                                                 | 状态          |
| ------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------- |
| **A 数据层** | 009/010 迁移、`organizations`/`join_requests`/成员与账号 repository、`password` 工具、`user:init` CLI | 副本上迁移后行数逐表核对一致；`user:list`/`user:passwd` 可用；`test:db` 全绿         | ✅ 2026-09-10 |
| **B 认证**   | register/login/password 端点、scrypt、会话、`must_change_password` 门禁；退役令牌登录与 `owner:reset` | 注册→登录→改密→登录全链路 HTTP 通过；旧令牌一律 401；`test:auth` 端到端通过          | ✅ 2026-09-10 |
| **C 隔离**   | 所有业务查询加组织过滤、组织/成员/申请端点、§4 的 6 条不变式                                          | 新增跨组织隔离测试（构造 2 个组织，逐端点验证 404）；契约按新行为重录                | ✅ 2026-09-10 |
| **D 界面**   | `/login`、`/register`、`/password`、`/join` + 设置页（D-42 合并）+ 8 个页面接入组织上下文与筛选器     | `test:ui` 79/79 全绿并渲染出真实数据；`antd lint app` 无问题；**未做浏览器人工走查** | ✅ 2026-09-10 |
| **E 收尾**   | 契约全量重录、夹具改造（3 组织）、文档回写、正式库迁移与演练                                          | **311 条**契约全部一致；正式库已迁移至 `010` 并核对；README/harness 六份文档回写     | ✅ 2026-09-11 |

**对现有资产的影响**：`tools/contract/fixture.ts` 要改成「两个组织 + 三角色 + 无组织用户」；
对现有资产的实际影响：`tools/contract/fixture.ts` 已改成「3 个组织（含 1 个已解散）+ 8 个账号（含无组织与待改密）」，
用例从 139 条扩到 **311 条**（`org.` 82、`members.` 6、认证域重写为 28、`webdav.` 6，其余域补上组织上下文）；
`test/api/owner-reset.test.ts` 已换成 `test/api/auth.spec.ts`（注册→登录→强制改密门禁→改密）。

## 12. Phase A 实施记录（2026-09-10）

### 交付物

| 文件                                                                 | 内容                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `server/src/security/password.ts`                                    | scrypt 哈希/校验（参数写进哈希串、`timingSafeEqual`、`locked$` 占位、参数上下界防护） |
| `server/src/security/account.ts`                                     | 账号运维：`listAccounts` / `setAccountPassword` / `initMissingPasswords`（幂等）      |
| `server/src/cli/{support,list-users,set-password,init-passwords}.ts` | `user:list`、`user:passwd`、`user:init` 三个命令                                      |
| `server/src/db/migrations-pending/009…sql`、`010…sql`                | 见 §3：2 张新表 + 7 张表重建 + 初始组织与归属回填                                     |
| `tools/db/rehearse-migration.ts`（`npm run db:rehearse`）            | 副本演练 + 42 项核对                                                                  |
| `test/db/password.test.ts`                                           | 6 条密码单元测试（含「格式/参数异常一律失败」与「改过参数的哈希仍可校验」）           |

### 在正式库副本上的演练结果（当时 42 项 0 失败；加入两条新约束探针后为 44 项）

- 14 张保留表行数**逐表一致**（tasks 7、todos 8、notes 1、weekly_reports 4、users 5、task_comments 2、…）。
- 账号映射：`owner` → `admin`（全局管理员，`org_id` NULL）；创建最早的助理 `SELENE` → `selene` / `manager`；
  `LEAH`/`MINTY`/`YANIS` → `member`。用户名取「小写名字」（纯 ASCII 合法时），否则回退 `member-<id 前 6 位>`。
- 全部业务数据挂到 `org-default`；`access_tokens` 已删除；`PRAGMA foreign_key_check` 干净。
- 约束真的生效（都用探针插入验证过）：旧角色 `owner` 被 CHECK 拒、业务表缺 `org_id` 被 NOT NULL 拒、
  同一用户第二个 `pending` 申请被部分唯一索引拒；反过来「`member` + `org_id=NULL`」（注册路径）**必须被允许**。

### 密码链路验证

- `test:db` 13/13（Phase A 当时；后续加入迁移/备份/自举用例后为 **20/20**，见 §14 复验证据）。
- `user:init` 为 5 个账号生成初始密码后，用**独立实现的标准 scrypt**复算 `password_hash` 全部匹配（5/5），
  证明写入的不是自洽的假格式；`user:passwd` 设置的密码同样通过独立校验。
- `user:init` 幂等：第二次执行报告「所有账号都已设置过密码，无需初始化」；不带 `--confirm` 拒绝执行（exit 1）。
- 不存在的账号报错并 exit 1；密码短于 8 位被拒。

### 踩到的坑（已记入文档，避免重复）

1. **`--password-stdin` 会被 npm 吃掉**：Windows 上 `npm run user:passwd -- x --password-stdin` 会打印
   `npm warn Unknown cli config "--password-stdin"` 并把该参数丢弃（管道调用时 PowerShell 的 npm shim 还会进一步打乱参数）。
   解法：密码输入改为「环境变量 `WORKBENCH_PASSWORD` → stdin 非 TTY 就自动读一行 → TTY 交互式隐藏输入」三级回退，
   不再依赖该标志。
2. **`--keep` 的副本目录位置**：演练副本在系统临时目录，`--keep` 会打印路径；验证完记得手工清理。
3. **生产库可以边跑边拷**：服务持有连接时 PowerShell 的 `Get-FileHash` 会被共享锁挡住，但 `node:sqlite` 的
   `backup()` 与 `fs.copyFileSync` 都能正常取到快照（`backup()` 是**异步**的，必须 `await`，否则得到 0 字节文件）。

## 13. 风险

| 风险                                             | 对策                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 隔离漏一条查询 = 跨组织数据泄露                  | 隔离不做「逐条记得加 WHERE」，而是**收敛到少数几个查询构造函数**（组织上下文从会话注入）；C 阶段用 2 个组织的夹具逐端点验证 |
| 7 张表重建时数据错位/丢失                        | 严格照 `004`/`008` 的既有模式；副本上先演练并逐表比行数、比抽样内容                                                         |
| 注册开放后被局域网内任意人注册                   | 与你的选择一致；风险由「注册后无组织、必须审批」挡住数据访问；若之后想收紧，加邀请码是单点改动                              |
| 「入组不需同意、退出需批准」的不对称             | 已记录为有意设计（§6）；invite 会发通知，被拉的人至少知道                                                                   |
| 契约 golden 大面积重录会掩盖真实回归             | 重录前后对**未受影响的域**（任务、周报、待办）保留逐条比对；只有认证域与新增组织域是重新录制的基线                          |
| `must_change_password` 门禁写漏 = 弱密码长期存在 | 门禁放在 `requireAuth` 内部（而非逐页判断），并加契约用例证明未改密时业务端点 403                                           |

## 14. B/C/D 实施记录（2026-09-10，分支 `feat/accounts-orgs`）

### 交付物

| 层     | 内容                                                                                                                                                                                                                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 认证   | `app/lib/session.server.ts` 重写（scrypt 登录/注册/改密、会话、`must_change_password` 门禁写在 `requireAuth` 内部、`requireAdmin`/`requireManager`/`assertOrgAccess`/`assertOrgManage`/`notFound`/`orgFilter`）；4 个认证端点 + `/login`、`/register`、`/password`、`/join` 页面；`/access` → 302 `/login` |
| 组织   | `app/lib/organization.server.ts`（组织 CRUD/归档恢复、成员管理、入组/退组/被拉入的完整台账、最后一名 manager 保护）；`app/routes.orgs.ts` + 13 个端点；`/organization`、`/admin` 页面；`/collaboration` 改为只读协作概览（三页已于 2026-09-11 合并为 `/settings`，见 §19）                                 |
| 隔离   | 任务域（`visibilityClauses`）、记录域（`recordClauses`）、周报域（`reportVisibilityClauses`）、概览/成员/文件库全部按组织过滤；所有 `INSERT` 显式写 `org_id`；跨组织一律 404                                                                                                                               |
| 数据层 | `009`/`010` 已启用（17 张表）；`json-migration.ts` 重写为新结构；删除 `owner-token.ts`、4 个死 repository、`api.users*` 3 个路由                                                                                                                                                                           |
| 工具   | 夹具改为 3 组织 / 8 账号；契约 305 条并重录 golden（后增至 311 条，见 §18）；`contract:capture` 默认改用 `serve`；`smoke:ui` 覆盖新认证 + `/join` + `/settings`（按角色与 Tab）+ 越权回弹；`npm test` 增加 `pretest` 自动 build                                                                            |
| CLI    | `user:list` / `user:passwd` / `user:init`；`owner:reset` 随令牌一起退役                                                                                                                                                                                                                                    |

### 有意的行为变更（契约 golden 已按新行为重录）

1. **登录方式**：`POST /api/auth/access`（令牌）删除，改为 `POST /api/auth/login`（用户名 + 密码）；注册 201 且直接建会话。
2. **强制改密**：`must_change_password=1` 时除「看自己 / 改密 / 登出」外一律 403 `PASSWORD_CHANGE_REQUIRED`（契约有用例盯着）。
3. **跨组织一律 404**，文案统一为「未找到该资源」——包括任务、评论、时间线、待办、随手记、文件、周报、下载、成员列表。
4. **同组织内无可见权仍是 403**（保留旧契约形状，D-35）。
5. **不存在的记录**：`PATCH/DELETE /api/todos|notes/:id`、`DELETE /api/files/:id`、`POST /api/files/:id/use` 由「不存在也回 200」改为与跨组织一致的 404——不这样做，两者可区分，等于泄露资源是否存在。
6. **待办/随手记**从「主人专属」变为「登录即可、按组织隔离」；文件库与验收视图维持 manager+admin。
7. **管理员写记录必须指定组织**（`orgId` 或 `?org=`），否则 400「管理员必须指定记录所属组织」；非管理员带 orgId 一律忽略。
8. **通知收件人修正**：任务/周报通知里写死的伪 id `"owner"`（生产库里根本不存在这个用户，等于没人收到）改为「负责人 + 本组织 manager」。
9. **角色文案**：403 统一为「只有管理员或组织管理者可以执行此操作」「只有管理员可以访问此功能」；页面里的「主人/助理/查看者」全部替换。
10. **任务载荷新增 `orgId`/`orgName`**（D-38），供管理员合并视图区分组织。

### 复验证据

| 检查                                        | 结果                                                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                  | **全绿**：db 20/20 · 契约 311/311 全部一致 · auth 2/2 · ui 79/79                                                                                                                |
| 组织/隔离 HTTP 探针（主线临时脚本，60+ 项） | **75/75**：可见范围、创建权限、成员越权 404/403、入组申请→审批→重复申请、撤回、退组审批、最后一名 manager 三条路径、拉人入组、角色变更、跨组织成员操作、改名越权、归档/恢复语义 |
| `npm run db:rehearse`（迁移前副本）         | **44/44**：逐表行数一致、账号映射、组织归属、外键完整性、四条约束探针（含 `manager` 必须有组织 / `admin` 不得隶属组织）；对已迁移的正式库则 **38/38 + 跳过 6 项**初始态断言     |
| 全新空库 `001–010`                          | 迁移通过，17 张表、0 组织、`access_tokens` 已删、外键干净                                                                                                                       |
| 各域自验（工作流临时脚本）                  | 任务 64+21 项、记录 28+23 项、周报 73+12 项、概览/访问信息 全部通过                                                                                                             |
| 静态门禁                                    | lint 0/0（143 文件）· typecheck 四工程 0 · `antd lint app` 105 文件无问题 · `format:check` 无漂移 · build 通过                                                                  |

### 已知未覆盖 / 后续

- **没有做过浏览器人工走查**（本环境无浏览器自动化）：`Select value=""`、`DatePicker` 中文 locale、组织页交互手感都只经过 SSR 冒烟与静态门禁（`DEBT-16`）。
- 不变式 6（停用账号立即失去会话）没有契约用例：停用会撤销该账号全部会话，而 runner 按角色缓存会话，会让后续用例全线 401；需要单开账号覆盖。
- `runCases` 只替换 **path** 里的 `{{变量}}`，body 与 multipart 字段不替换（用例已用 `IDS` 字面量规避）。
- golden 里会录制登录/改密用例的**明文密码**（与旧 `TOKENS` 同级别暴露面，本机自用可接受）。
- D-28 的组织筛选器目前只在任务页与记录页（`/todos`、`/notes`、`/files`）的写入口落地，`/reports` 尚未加（载荷不带 orgId）；概览页自 D-40 起为只读展板，已不再有写入口。

## 15. 代码约定（B/C 阶段所有改动必须遵守）

B/C 是多文件并行的改造，以下约定是并行工作的接缝，**不要各自发明**。

### 14.1 组织上下文的唯一来源

`app/lib/session.server.ts` 导出的这几个函数是所有权限判断的入口，业务代码**不要**自己写 `role ===` 比较：

| 函数                                           | 语义                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `requireAuth(request, cookieName)`             | 登录即可；**内部已包含强制改密门禁**（未改密返回 403 `PASSWORD_CHANGE_REQUIRED`） |
| `requireAuth(..., { skipPasswordGate: true })` | 只给「看自己 / 改密 / 登出」三个端点用                                            |
| `requireAdmin(request, cookieName)`            | 仅全局管理员                                                                      |
| `requireManager(request, cookieName)`          | 管理员或组织管理者（是否管得着某个组织再用 `assertOrgManage` 判断）               |
| `orgScope(user)`                               | 管理员返回 `null`（= 所有组织），其他人返回自己的 `orgId`                         |
| `assertOrgAccess(user, resourceOrgId)`         | 返回 `null` 表示放行，否则返回**404 响应**，直接 `return` 给客户端                |
| `assertOrgManage(user, orgId)`                 | 同上，但用于「管理」语义（改组织、审批、管成员）                                  |
| `notFound()`                                   | 统一的 404 响应（跨组织一律用它，**不要用 403**）                                 |

### 14.2 查询与写入

- **读**：凡是有 `org_id` 的表（`tasks`/`todos`/`notes`/`important_files`/`weekly_reports`），SQL 必须带组织条件。
  **不要**照旧模板写 `const scope = orgScope(user); where = scope ? "AND org_id=?" : ""` ——
  `orgScope()` 对「管理员」和「未入组的普通用户」**都返回 null**，那样写会把未入组的人当成管理员，直接跨组织泄露。
  用带兜底的 `orgFilter()`（`app/lib/session.server.ts`）：
  ```ts
  import { orgFilter } from "./session.server";
  const scope = orgFilter(user, "t.org_id"); // admin → ""；已入组 → "t.org_id=?"；未入组 → "1=0"
  const sql = `SELECT ... FROM tasks t WHERE 1=1 ${scope.clause ? `AND ${scope.clause}` : ""}`;
  rows(db(), sql, ...scope.params);
  ```
  三个域（任务 / 记录 / 周报）当前各自内联了等价的 `1=0` 兜底，语义一致；新代码请直接用 `orgFilter()`。
- **写**：`INSERT` 必须显式写 `org_id`（迁移里是 `NOT NULL`），取值是**资源所属组织**：
  普通用户/管理者写自己的 `user.orgId`；管理员写请求里指定的组织或资源已有的组织。
- **间接表**（`task_comments`/`task_progress_logs`/`task_events`/`report_files`/`notifications`）不加 `org_id`，
  必须**经父级**（`task_id`/`report_id`/`recipient_id`）关联校验，不能只按 id 取。
- 按 id 取单条资源时，先取出它的 `org_id`，再用 `assertOrgAccess` 判定，不通过就 `return notFound()`。

### 14.3 角色语义在业务里的映射

| 改造前                               | 改造后                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `user.role === "owner"`              | `user.role === "admin"`（全局）                                                       |
| owner 能看全部任务                   | admin 看全部组织；manager 与 member 都看**本组织**（D-54）                            |
| owner 才能改任务元信息 / 审批 / 退回 | admin 或**本组织 manager**（且必须看得见这条任务）                                    |
| 助理看自己的、查看者看助理负责的任务 | member 看本组织全部非私密任务 + 自己发布/负责的私密任务（D-54）                       |
| 私密任务只有 owner 可见              | 发布人 / 负责人 / admin 可见，**其它人（含 manager）既读不到也改不动**（D-54，§23.1） |

### 14.4 不要改动的东西

- 响应信封 `{ok:true,data}` 与 `{ok:false,error:{code,message}}`（`app/lib/http.server.ts`）；
- CSP / `content-type` 等安全头；
- 已有端点的**路径**与**成功状态码**，除非本文 §7 明确要求改；
- 任何 `.js` 文件（仓库只允许 TypeScript）。

### 14.5 并行改动的文件归属

同一时间只允许一个工作流改同一个文件。公共文件（`app/routes.ts`、`app/root.tsx`、
`app/lib/{db,session,organization}.server.ts`、`tools/contract/runner.ts`）由主线统一维护，工作流不要改。

## 16. 数据库自举（D-39，2026-09-11）

### 起因

`009` 的初始组织只在「已存在主人账号」的库上创建，所以**全新空库迁移完是 0 账号 0 组织**：
没有任何人能创建组织（`POST /api/organizations` 仅 admin 可用），也没有组织可供申请加入
—— `register` 出来的账号只能停在 `/join` 且列表是空的，系统开箱即坏。

### 规则（`server/src/db/bootstrap.ts`）

| 库的状态                      | 自举行为                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------- |
| 有管理员 + 有组织             | 完全不动（生产库、契约夹具库都是这一档）                                        |
| 有管理员 + 一个组织都没有     | 建 `org-default`「默认组织」，`created_by` = 该管理员                           |
| 既没有管理员也没有组织        | 建默认管理员 `admin`（`locked$` 占位密码、`org_id` 为 NULL、随机 id）+ 默认组织 |
| 用户名 `admin` 被普通账号占用 | 什么都不做（开放注册下确实可能被抢注，不顶替、不提权）                          |

- **只在应用运行时执行**（`app/lib/context.server.ts` 的 `appDatabase()`，迁移之后、首个请求前），
  刻意不写进 `client.ts` 与迁移文件：夹具/契约工具都是「新建空库 → 自己插种子数据」，
  在那里自举会插进 `username='admin'` 的账号，与 `tools/contract/fixture.ts` 的夹具管理员撞唯一键。
- 幂等：管理员与组织各自独立判存在性，重复执行不重复插入、不改动已有数据。
- **管理员初始密码（D-51）**：启动环境里给了 `WORKBENCH_ADMIN_PASSWORD` 就直接用它建号；
  没给则写 `locked$`（任何输入都登录失败），必须在本机跑 `npm run user:init -- --confirm` 拿初始密码后首次登录改密。
  两条路都只作用于「还没有密码」的管理员，已有真密码**永不覆盖**；env 值非法（少于 8 位）只告警、不静默降级。
  管理员仍无密码时启动日志会打印提示。
- 默认组织名固定为「默认组织」（`organizations.name` 有 UNIQUE，因此只在「一个组织都没有」时创建）。

### 验收

`test/db/bootstrap.test.ts`（已在 `npm run test:db` 里）覆盖四条：全新空库建号建组织、重复执行幂等且零写入、
已有管理员时只补组织、夹具式库不动 + `admin` 被占用时不顶替。
`test/db/bootstrap-admin-env.test.ts`（同在 `test:db` 里）覆盖 D-51 的五条：新库直接用 env 密码、老库补设一次后
改 env 不覆盖、env 值非法时保持 `locked$`、没给 env 时保持原行为、已有真密码的管理员不被碰。

## 17. 概览页只读化（D-40，2026-09-11）

### 改动

| 类别 | 内容                                                                                                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 移除 | 概览页的新增待办 action 与快捷表单（含 `Form`/`Input`/`Select` 等写入依赖）、只为该表单存在的 `dashboardTodoOrgs()`、`layout.css` 的 `.quick-add` / `.quick-add-item`                                                                                           |
| 保留 | 与 `GET /api/dashboard` 共用的 `dashboardData()`——响应载荷逐字段不变，契约 golden 不需要重录（当时 305 条；D-41 后为 311 条）                                                                                                                                   |
| 新增 | `dashboardBoard(user, base)` 只读展板：统计卡 ×6（未完成 / 逾期 / 待验收 / 今日待办 / 随手记 / 未读通知）、任务状态分布 + 完成率、需要关注的任务（已逾期 + 7 天内到期）、最近任务、待办清单（未完成按日期升序）、最近随手记、最近使用文件（仅 admin / manager） |

### 改这个页面时必须守住的约束

1. **`dashboardData()` 的返回值就是 `GET /api/dashboard` 的响应体**，字段不能增删改，否则契约 golden 失配；
   页面需要的额外数据一律放到 `dashboardBoard()` 里。
2. `dashboardBoard(user, base)` 必须复用 `dashboardData()` 已经取到的任务 / 待办 / 随手记（`base` 参数），
   不要重复查库；它自己新加的两处查询也必须自带边界——未读通知按收件人，重要文件走 `files.server.listFiles()`
   且只给管理员 / 组织管理者取（§4）。
3. 写入入口统一在 `/todos`、`/notes`、`/tasks`、`/files` 各自的列表页；概览页不再承担创建职责，
   `POST /` 不再是 action（浏览器表单提交会被拒）。
4. `tools/contract/smoke-ui.ts` 已同步：概览页的检查从「新增待办」换成「`POST /` 被拒绝」+「展板文案存在」。
   首页标记串仍保留「每日概览 / 未完成任务 / 待办清单」。

## 18. WebDAV 接入（D-41，2026-09-11）

「重要文件」多了一条**可选**的 WebDAV 通道：浏览远端目录、选文件登记索引、上传文件、显示远端文件情况。
它是独立功能，规则、边界、取舍、排障全部写在 **[`WEBDAV.md`](WEBDAV.md)**，这里只记与本改造相关的三点：

1. **没有加表、没有加列、没有新迁移**：远端条目沿用 `important_files.file_path`，值形如 `webdav:<相对路径>`；
   组织隔离仍由 `important_files.org_id` 负责（§14.2）。
2. **权限复用文件库口径**（§4）：`/api/webdav` 用 `requireManager`，普通成员 403；未配置 WebDAV 时 503。
3. **契约 golden 已重录**：`cases.ts` 新增 `webdav.*` 6 条（401 / 403 / 503），总用例 305 → **311**；
   `tools/contract/fixture.ts` 不配 WebDAV，避免用例依赖外部环境。

## 19. 设置页合并（D-42，2026-09-11）

三个「管理」页面合并为单页 `/settings`：它们本来就是同一份数据（组织 / 成员 / 账号 / 申请）在三种角色视角下的呈现，
而 `/collaboration` 的只读副本与另两页完全重叠（它的门禁同样是 admin/manager，另两页本来就能写），因此整页退役。

| 合并前                    | 合并后                       | 说明                                                                          |
| ------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `/organization` 组织管理  | Tab「组织与成员」            | 组织信息 + 成员管理 + 待审批 + 最近处理；admin 在页内切换组织（`?org=`）      |
| `/admin` 全局管理         | Tab「组织总览」+「账号总览」 | 组织 CRUD 与账号列表；`?scope=` 决定账号筛选范围（全部 / 未加入 / 某组织）    |
| `/collaboration` 协作管理 | 整页退役（不并入设置页）     | 只读副本与上面两个 Tab 完全重复；「访问地址」继续只在 `/api/access-info` 提供 |

约束与取舍：

1. **Tab 按角色显示**：`members` 对所有 admin/manager 可见，`orgs` / `accounts` 仅 admin；
   manager 手动传 `?tab=orgs` 会在 loader 里回落到 `members`。
2. **每种操作只有一个入口**：解散组织在 admin 走「组织总览」表格、在 manager 走「组织与成员」的危险操作卡；
   「拉入组织」只在「组织与成员」提供（账号总览的未加入账号给引导按钮），不再有第二份表单。
3. **合并后的 action 门禁是 `requireManagerOrRedirect`**（manager 也要能用），因此 `create`（建组织）与
   `restore`（恢复组织）必须在 action 内部额外校验 `role === "admin"`——这是合并最容易漏的一条。
4. **旧 URL 直接删除、不做重定向**：`/admin`、`/organization`、`/collaboration` 现在 404，`smoke:ui` 有用例盯着。
5. **业务规则仍然只有一份**：`app/lib/organization.server.ts` 未改动，`app/routes.orgs.ts` 的 13 个 API 端点与契约 golden 不受影响。

文件：`app/routes/settings.tsx`（壳 + 合并 loader/action）、`app/components/settings/`（`constants`、`types`、
`org-members-tab`、`org-overview-tab`、`accounts-tab`）；导航 `app/root.tsx` 的三个入口合成一个「设置」。

验收：`npm run smoke:ui` 覆盖 admin 的三个 Tab、manager 的越权回落、普通成员回弹首页，以及三条旧路径 404。

## 20. WebDAV 配置改为按账号 + 网页配置（D-43，2026-09-11）

D-41 把 WebDAV 配置放在进程环境变量（`WEBDAV_URL` 等），一次部署只能接一个远端、改配置要重启。
本节把它改成**每账号一份、只在设置页维护、落库持久化**，环境变量方式整体移除：

| 项       | 内容                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| 数据     | 新表 `webdav_settings`（迁移 `011`，主键 `user_id`，级联删除；`password` 明文，Basic 认证需要原文）                    |
| 配置入口 | `/settings?tab=webdav`（管理员与组织管理者都能开；`admin` 全部 Tab，`manager` 只能开 `members` / `webdav`）            |
| 生效范围 | 浏览 / 上传 / 状态探测都用**当前登录账号**的配置；账号没保存过就是未配置（不再读环境变量）                             |
| 服务端   | `app/lib/webdav-settings.server.ts`（读写 + 校验 + 生效解析 + 不含密码的视图）、`webdav.server.ts` 改为按账号取客户端  |
| 契约     | `webdav.*` 6 条用例不变（夹具不配 WebDAV）；`WEBDAV_DISABLED` 的提示文案改成「请到设置里配置」，golden 对应 3 条已同步 |

已知取舍：`important_files` 里的 `webdav:` 索引只存相对路径，换账号解析可能指向不同远端；
要彻底解决需把「配置来源」也写进索引（见 [`WEBDAV.md`](WEBDAV.md) §5）。

## 21. WebDAV 地址改回环境变量、凭据留在账号（D-44，2026-09-11）

D-43 的前提是「不同的人可能用不同的 NAS 与账号」，于是把**地址也**做成按账号保存。
实际使用中团队**共用同一台 NAS**（`http://192.168.0.242:5005`），地址每人填一遍是纯粹的重复劳动。
本节把配置**拆成两半**，而不是简单回退 D-43：

| 项       | 内容                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 地址     | 部署级，来自环境变量 `WEBDAV_URL`；设置页只读展示；改地址要重启服务                                                                                                                                |
| 凭据     | 用户名 / 密码 / 浏览根目录 / 超时仍按账号存 `webdav_settings`，在 `/settings?tab=webdav` 维护，保存即时生效                                                                                        |
| 数据     | 迁移 `012`：删掉不再读取的 `webdav_settings.url`（留一个「看起来还能配地址」的死列更容易误导人）                                                                                                   |
| 接入条件 | **两个都要满足**：`WEBDAV_URL` 配好 **且** 本账号保存过一次。这样配了地址不会自动对所有人开放，也不会给没在用的人加远端探测                                                                        |
| 访问路径 | 「浏览根目录」同时接受 Linux 与 Windows 写法，保存时归一：`\volume1\work` → `/volume1/work`、`\\192.168.0.242\work\报价` → `/报价`（去掉主机名与共享名）、`Z:\报价` → `/报价`；`.` / `..` 直接拒绝 |
| 顺带修的 | `DEBT-02` / `TODO-02`：`.env` 现在会被自动加载（`loadDotEnv` + `serve`/`dev` 的 `--env-file-if-exists`），运行时下限随之从 22.5.0 提到 22.9.0                                                      |

顺带解决的旧问题：D-43 记的「换账号后 `webdav:` 索引可能指向另一个远端」不再成立——
地址对全员是同一个，差异只剩各人 NAS 账号的权限范围。

不在环境变量里的部分：`WEBDAV_URL` 只描述**地址**，凭据永远不进环境变量、也不进日志
（理由见 [`WEBDAV.md`](WEBDAV.md) §2 与 §5）。

## 22. CRUD 字段与列表字段对齐，任务可换所属组织（D-47，2026-09-11）

起因是一次用户报障：「任务进展里 CRUD 的字段跟显示的字段对不上」。

先把事实钉死：**显示的数值与库里的值没有错位**——用真实库的副本 + 无头 Chrome 逐条核对
（列表单元格、详情抽屉、新建/编辑抽屉回填值 vs `tasks` 行的每个字段），并实测了
新建 → 改字段 → 改派 → 归档 → 恢复 → 删除整条链路，写进去什么列表就显示什么。
对不上的是**字段集合**：列表有 7 列，编辑抽屉只有 5 个字段。逐条整改如下。

| 页面                       | 问题                                                                        | 处理                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/tasks`                   | 列表有「负责人」「所属组织」，编辑抽屉里没有 → 改不了（组织全站无修改入口） | 编辑抽屉补齐两项：负责人复用既有改派语义（写 `task_reassigned` 事件 + 通知双方）；所属组织见下                               |
| `/tasks`                   | 列表有「状态」「进度」，CRUD 里没有对应字段                                 | 编辑抽屉加「状态与进度」面板（与详情抽屉**同一个组件**）：当前值只读 + 只列出当前允许的流转按钮                              |
| `/tasks`                   | 「更新时间范围」筛选的是 `updated_at`，而列表只有「截止日期」列             | 列表补「最近更新」列（`defaultSortOrder: descend`，与 loader 的 `ORDER BY updated_at DESC` 一致），筛选字段可见了            |
| `/tasks`                   | 列表列头叫「组织」、表单叫「所属组织」                                      | 列头统一为「所属组织」                                                                                                       |
| `/todos`                   | 同一字段：列表写「待处理」，筛选器与编辑表单写「未完成」                    | 列表统一为「未完成」（沿用 D-46 的用词约定：同一个字段只有一套说法）                                                         |
| `/todos` `/notes` `/files` | 新建表单有「所属组织」（管理员必填），列表没有组织列                        | 三页都补「所属组织」列（仅管理员渲染；名字由页面用 `organizations` 查表得到，**不动 API 载荷**，契约 golden 不需要为此重录） |
| `/tasks`                   | 无组织的**成员**被显示成「xxx（管理员）」                                   | `memberLabel` 改判 `role === "admin"`——注册未入组、被移出组织、组织解散都会产生「member + 无组织」的账号                     |

`/tasks` 新建任务的默认组织同时改成跟随页面上的组织筛选器 `?org=`（与 `/todos`、`/notes` 一致）：
以前在「贝塔组」筛选下新建，任务会落到第一个组织，建完就从当前列表里消失。

### 22.1 状态与进度为什么不是可自由填写的表单字段

它们是**动作驱动**的状态机，不是元信息：`PATCH /api/tasks/:id` 明确拒绝 `progress` / `status`
（`FIELD_FORBIDDEN`，契约用例 `tasks.patch.managerA.reject-progress` 冻结点），
进度只能由负责人本人走 `POST /api/tasks/:id/progress`，状态只能由 `submit-review` /
`approve` / `return` 推导。所以「对齐」的做法是把**当前值只读展示 + 把当前允许的流转平铺成按钮**，
而不是新开一个能直接改状态的接口——那会绕开 §14.3 的验收规则。

### 22.2 换所属组织（迁移 013）

| 项       | 内容                                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 谁能改   | **只有 admin**。组织管理者只在本组织内有管理权，不能把任务搬到别的组织（`403`）                                                                                                                       |
| 目标组织 | 必须存在且 `status='active'`；已解散的组织不能再接收任务（`400`）。**保持原组织不动时不做这个校验**，否则解散组织里的存量任务连改名都保存不了                                                         |
| 负责人   | 按**目标组织**校验（`validateOwner(..., { orgId })`）：换组织后负责人必须属于新组织，否则负责人看不到自己的任务（`400`）。同一次提交里换组织 + 改派给新组织的人是允许的                               |
| 时间线   | 新增事件类型 `task_moved`（迁移 013 重建 `task_events` 放开 CHECK），前端标签「调整组织」，文案「所属组织从 X 改为 Y」                                                                                |
| 通知     | 负责人 + **新组织**的组织管理者（`orgManagerIds` 读的是更新后的 `org_id`）。`notifications.event_type` 的 CHECK 里没有 `task_moved`（009），复用 `task_reassigned` 作为路由键，用户看到的是标题与正文 |
| 接口     | `PATCH /api/tasks/:id` 带 `orgId` 即换组织；不带则完全保持原行为（golden 里既有 311 条用例逐条回放一致）                                                                                              |

### 22.3 测试缺口（这次报障暴露的）

`test:ui`（SSR 冒烟）只断言页面里出现某些**字符串标记**，`test:api`（契约回放）只覆盖接口——
两者都不会发现「列表有这一列、表单里没有这个字段」这种**字段集合**问题。这次补的护栏是：

- 冒烟标记加「最近更新」「所属组织」，页面骨架被拆掉时会红（`/tasks`、`/todos`、`/notes`、`/files`）；
- 契约新增 6 条用例覆盖换组织的四种边界（见 §22.2）；
- 字段集合本身仍靠**人工核对**：改 CRUD 页面时必须拿列表列头与表单字段逐个对齐（见 [`CODE_STYLE.md`](CODE_STYLE.md) §10.7 第 10 条）。

## 23. 权限规则调整：私密任务、本人数据、重要文件（D-54，2026-09-14）

起因是一次权限规则的重新确认，落地为五条相互独立的改动。**每一条都改变了已有行为**，
所以下面写清「改前 → 改后」与各自的判据落点，避免下一个人从旧矩阵里读出过期结论。

### 23.1 私密任务：可见方 = 发布人 / 负责人 / 全局管理员

| 项         | 改前（D-36）                                                   | 改后（D-54）                                                                                               |
| ---------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 可见方     | admin 全部；manager 只见**自己创建的**；member 不可见          | **发布人（`created_by`）+ 负责人（`owner_id`）+ 全局管理员**；组织管理者**不因角色**获得他人私密任务的权限 |
| 负责人     | 必须是**创建者本人**（`is_private` ⇒ `owner_id = created_by`） | 可以是本组织的**其他人**——「发布人」与「负责人」这时才真的分得开                                           |
| 谁能建私密 | admin / manager                                                | 不变（member 传 `isPrivate` 仍降级为普通任务）                                                             |
| 判据落点   | `visibilityClauses` + `canView`                                | 同两处，条件统一成 `t.is_private=0 OR t.created_by=? OR t.owner_id=?`                                      |
| 通知收件人 | 私密任务只通知负责人                                           | 负责人 + 发布人（其他人看不到这条任务，标题发过去就是泄露）                                                |

**写操作也必须过可见性这道门**（本次修掉的真实裂缝）：改造前 `task-service.server.ts` 的
`updateTask` / `reportProgress` / `approveTask` / `archiveTask` … 只判 `canManageTasks`，
于是组织管理者虽然**看不见**别人的私密任务（列表与详情都过滤掉了），却仍能直接
`PATCH /api/tasks/:id` 改它。现在所有写操作与间接表（评论、时间线、进度）统一走 `viewable()`，
语义与 `canView` 完全一致：**列表里看不见的，接口里也改不动**。
契约用例 `tasks.patch.managerA.private.others-reassign`、`tasks.patch.memberA2.private-task` 钉住这一点。

此外，私密任务的**私密开关与负责人**只由「发布人或管理员」改得动（`403`）：
这两项是可见性规则本身的输入，放任本组织管理者改，等于让他把别人的私密任务改成公开、
或把负责人换成自己（凭空获得可见权）；标题 / 说明 / 优先级 / 截止日期不受此限。

### 23.2 普通成员看得到本组织的非私密任务

| 项       | 改前                                            | 改后                                                           |
| -------- | ----------------------------------------------- | -------------------------------------------------------------- |
| 任务可见 | member **只看自己负责的**                       | member 看**本组织全部非私密任务**，外加自己发布/负责的私密任务 |
| 写权限   | 不变（member 仍不能改元信息、审批、归档、删除） | 不变                                                           |

页面同步收敛：任务列表的「编辑 / 改派」按钮**对普通成员整块不渲染**（改前是渲染出来再置灰），
操作列宽度也跟着收；否则成员一进列表就是一屏点不动的灰按钮。

### 23.3 待办 / 随手记：组织级共享 → 本人数据（迁移 017）

改前这两张表**只有 `org_id`**（009 的注释原文：「改造前没有归属字段，是全局共享的」），
同组织的人互相看得到对方的待办与随手记——与「随手记」这个名字本身的语义相反。

- 迁移 `017_personal_records.sql`：`todos` / `notes` 各加 `owner_id`，并把**历史行**认领给
  同一组织里**最早的启用组织管理者**（没有 manager 就回落到最早的启用管理员）。
  刻意**不加外键**：`ALTER TABLE ADD COLUMN` 加不了，为一个可空列重建两张表不值得；
  归属人账号消失后记录不再属于任何人（谁都不再看到），比级联删用户的历史更保守。
- 读：`personalClauses(user)` 产出 `owner_id = 本人`，**管理员也不例外**（`/todos`、`/notes`、
  概览页展板、`GET /api/todos|notes` 全部一致）。
- 单条：`assertRecordAccess` —— 跨组织 / 归属字段为空 → **404**；同组织但不是本人 → **403**
  「只能访问本人的记录」。两种状态码的语义差沿用 §14.3 的口径，不合并成一个。
- 写：`owner_id` 恒为当前账号，请求体里的 `ownerId` 一律忽略（没有「替别人记」这回事）。

### 23.4 重要文件：组织公共数据（查看 / 新增 / 编辑全开放，删除只管管理者）

| 能力                                | admin                   | manager       | member                       |
| ----------------------------------- | ----------------------- | ------------- | ---------------------------- |
| 查看                                | ✅ 全部组织（带筛选器） | ✅ 本组织     | ✅ 本组织                    |
| 新增                                | ✅ 任意组织（须指定）   | ✅ 本组织     | ✅ 本组织                    |
| 编辑                                | ✅                      | ✅ 本组织     | ✅ 本组织                    |
| **删除**                            | ✅ 全部组织             | ✅ **本组织** | ❌ `403`                     |
| 下载 / 标记最近使用                 | ✅                      | ✅            | ✅                           |
| WebDAV 浏览 / 上传（`/api/webdav`） | ✅                      | ✅            | ✅（凭据按账号，未配置 503） |

- 判据只有一份：`files.server.ts` 的 `canDeleteFile(user)`，页面用它决定是否渲染
  「删除索引 / 批量删除 / 勾选框」，域服务用同一个函数把门。
- **本次补上的缺口**：`PATCH /api/files/:id` 此前**根本不存在**（只定义了 `DELETE`，改一条索引
  只能走页面 action，接口一律 405）。现在补上，普通成员也能改。
- 跨组织仍是 **404**，普通成员删本组织文件是 **403** —— 前者不泄露存在性，后者对方本来就知道它存在。
- 不新增任何删除日志或操作审计（明确确认过）。

### 23.5 周报：组织内全可见，只有「改」分角色

`reportVisibilityClauses` 删掉 `member ⇒ owner_id = 本人` 那一条：同一组织的成员互相看得到
彼此交的周报（含正文下载）。**编辑入口不变**：重传仍限「本人或本组织管理者」
（`reuploadTarget`），审批仍走 `requireManager`。页面上 `canResubmit` 早已是
`(canReview || isOwnerOfReport)`，本次只动读侧，不碰写侧。

### 23.6 一次差点漏掉的读反

复选框类字段在两条提交路径上的类型不同：页面 action 经 `readPayload` 时
**JSON 给 `boolean`、表单编码给 `string`**，而 `Boolean("false") === true`。
`isPrivate` 因此新增了统一解释器 `flag()`（`true`/`1`/`"1"`/`"true"`/`"on"` 为真），
`createTask` / `updateTask` 都改用它——否则「取消私密」这种操作会被读成「设为私密」。

### 23.7 验收证据

| 检查             | 结果                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`       | 全绿：db 31 · 契约 **355/355 全部一致**（golden 已重录）· auth 2 · ui **122/122**                                                     |
| 迁移演练         | `node --import tsx tools/db/rehearse-personal-records.ts` 在**正式库副本**上 8/8：行数不变、8 条待办 + 1 条随手记全部认领到组织管理者 |
| 静态门禁         | lint 0/0（159 文件）· typecheck 四工程 0 · `format:check` 无漂移                                                                      |
| 本机探针（临时） | 私密任务三视角、文件删除、本人数据的 403/404 逐条对账；「组织管理者能否看到别人的私密任务」等边界都在活服务上复核过                   |

### 23.8 没做的（明确的取舍）

- **待办 / 随手记的页面仍保留管理员的组织筛选器**：管理员只看得到自己的待办，所以他切组织
  是在看「自己在那个组织下的记录」，不是在看别人的。这样一个页面可以有两种组织语义，靠
  `resolveRecordOrg` 的「组织只决定写在哪」解释清楚；真要彻底去掉筛选器，得连新建表单的
  「所属组织」字段一起删——那是另一轮改动。
- **`app/components/table-layout.ts` 不属于本次改动**（工作区里已存在的未跟踪文件，仓库中无引用）。

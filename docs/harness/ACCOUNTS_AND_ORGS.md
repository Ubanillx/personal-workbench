# 账号密码 + 多组织改造设计（已确认）

状态：**设计已确认（2026-09-10），待实施**。本文是这次改造的唯一权威口径；实施中如有偏离，先改本文再改代码。

## 1. 背景与目标

现状是「令牌登录 + 三角色（主人/助理/查看者）+ 单组织」，`users.role` 还有只允许旧三个值的 CHECK 约束。
本次改造要做三件事，**互相独立可分阶段交付**：

1. **认证**：令牌 → 用户名 + 邮箱 + 密码（可自助注册）。
2. **角色**：主人/助理/查看者 → **管理员 / 组织管理者 / 普通用户**。
3. **多组织**：新增组织实体，任务、待办、随手记、重要文件、周报按组织隔离。

非目标（本次不做）：邮箱验证与邮件找回密码（本机没有邮件服务）、多组织成员身份（一人只属一个组织）、
组织内的细分权限位（如「只读成员」）、把 `api_tokens` 死表一起清理（属 `DEBT-05`，另行处理）。

## 2. 决策记录

| ID   | 决策                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| D-18 | 引入**多组织**：新增 `organizations` 表，业务数据按组织隔离                                                                                |
| D-19 | 三个角色：`admin` 管理员、`manager` 组织管理者、`member` 普通用户；**取消**只读的 `viewer`                                                 |
| D-20 | **开放注册**，注册后即为普通用户、可立即登录，但**尚无组织**                                                                               |
| D-21 | 登录标识为**用户名 + 邮箱 + 密码**（用户名校验登录，邮箱用于唯一性与记录，本期不发信）                                                     |
| D-22 | **旧令牌全部作废**；迁移时给 5 个旧账号分配用户名与初始密码，由本机 CLI 打印一次                                                           |
| D-23 | 忘记密码只能**本机 CLI 重置**（`npm run user:passwd`），不提供网页端重置                                                                   |
| D-24 | 注册后**无组织**：能看到组织列表 → 提交入组申请 → 该组织的组织管理者审批通过后加入                                                         |
| D-25 | **一人只属于一个组织**（`users.org_id` 单值）                                                                                              |
| D-26 | **管理员是全局角色**，跨所有组织；不隶属任何组织（`org_id` 为 `NULL`）                                                                     |
| D-27 | 组织管理者权限：管理本组织成员、管理与指派本组织全部任务、审批本组织周报、访问本组织验收视图与文件库、改组织信息（改名/解散）              |
| D-28 | 管理员默认看到**全部组织的合并视图 + 组织筛选器**                                                                                          |
| D-29 | 迁移时建立**初始组织**，5 个旧账号与全部现有数据归入该组织；`owner` → 全局管理员，按 `created_at` 最早的助理 → 该组织管理者                |
| D-30 | 一个人**同时只能有一个待审批申请**                                                                                                         |
| D-31 | 组织管理者可以**直接把一个尚无组织的账号拉进本组织**（无需对方申请），被拉的人收到站内通知                                                 |
| D-32 | **退出组织需要管理者批准**（提交退出申请 → 本组织管理者审批）                                                                              |
| D-33 | **解散 = 归档**：组织标记为 `archived`，成员全部退回「未加入」状态，数据保留但不可访问，全局管理员可恢复                                   |
| D-34 | 未加入组织的账号登录后**只能**访问「组织列表 + 我的申请」页，其余页面一律重定向回来                                                        |
| D-35 | 组织边界用 **404**（跨组织按 id 访问一律「未找到该资源」，不泄露存在性）；**同一组织内无可见权仍返回 403**（保留旧契约形状，不扩大改动面） |
| D-36 | 私密任务的负责人必须是**创建者本人**（只有 admin/manager 能建私密任务；member 传 `isPrivate` 会降级为普通任务）                            |
| D-37 | 任务**指派范围 = 任务所属组织的成员**；全局管理员例外（admin 不隶属组织，旧模型允许 admin 当负责人）                                       |
| D-38 | 任务载荷（`toTaskView`）增加 `orgId` / `orgName`，供管理员在合并视图里看出每行属于哪个组织（D-28）                                         |

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

| 表                                                     | 改动                                                         | 隔离方式                                     |
| ------------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------- |
| `tasks`                                                | 重建，加 `org_id TEXT NOT NULL REFERENCES organizations(id)` | 直接过滤 + 索引 `(org_id, status, due_date)` |
| `todos`                                                | 重建，加 `org_id`（**当前没有归属字段**，是全局共享的）      | 直接过滤                                     |
| `notes`                                                | 重建，加 `org_id`（同上）                                    | 直接过滤                                     |
| `important_files`                                      | 重建，加 `org_id`（同上）                                    | 直接过滤                                     |
| `weekly_reports`                                       | 重建，加 `org_id`                                            | 直接过滤                                     |
| `task_progress_logs` / `task_comments` / `task_events` | 不加列                                                       | 经 `task_id` → `tasks.org_id`                |
| `report_files`                                         | 不加列                                                       | 经 `report_id` → `weekly_reports.org_id`     |
| `notifications`                                        | 不加列                                                       | 经 `recipient_id` → `users.org_id`           |
| `access_sessions`                                      | 不变                                                         | 经 `user_id`                                 |

`data/uploads/reports/<reportId>/` 目录结构不变——`reportId` 已隐含组织，不需要再分一层目录。

### 3.5 删除 `access_tokens`

令牌登录整体退役，表一并 `DROP`。`server/src/security/owner-token.ts` 与 `npm run owner:reset` 同时退役，
由 `server/src/cli/set-password.ts` 取代（见 §5.4）。

## 4. 角色与权限矩阵

| 能力                               | `admin` 管理员          | `manager` 组织管理者                  | `member` 普通用户       |
| ---------------------------------- | ----------------------- | ------------------------------------- | ----------------------- |
| 查看组织列表                       | 全部（含已归档）        | 全部（含已归档，可看不可管）          | 全部 active（用于申请） |
| 创建组织                           | ✅                      | ❌                                    | ❌                      |
| 改组织名/描述                      | ✅ 全部                 | ✅ 仅本组织                           | ❌                      |
| 解散（归档）/ 恢复组织             | ✅                      | ✅ 仅本组织解散（归档）；恢复仅 admin | ❌                      |
| 审批入组申请                       | ✅ 全部                 | ✅ 仅本组织                           | ❌                      |
| 直接拉无组织账号入组               | ✅ 全部                 | ✅ 仅本组织                           | ❌                      |
| 审批退出申请                       | ✅ 全部                 | ✅ 仅本组织                           | ❌                      |
| 启用/停用成员、改成员角色          | ✅ 全部                 | ✅ 仅本组织，**不能**动 admin         | ❌                      |
| 把成员移出组织（退回未加入）       | ✅                      | ✅ 仅本组织                           | ❌                      |
| 任务：查看                         | ✅ 全部组织（带筛选器） | ✅ 本组织全部                         | 仅自己负责的            |
| 任务：创建并指派负责人             | ✅ 任意组织任意人       | ✅ 本组织任意人                       | 只能建给自己的          |
| 任务：改元信息/审批/退回/归档/删除 | ✅                      | ✅ 本组织                             | ❌                      |
| 私密任务（`is_private=1`）         | ✅ 全部                 | **仅自己创建的**                      | ❌                      |
| 周报：提交                         | ✅                      | ✅ 本组织                             | 只能提交自己的          |
| 周报：审批/退回                    | ✅                      | ✅ 本组织                             | ❌                      |
| 验收视图、文件库、成员管理页       | ✅ 全部（带筛选器）     | ✅ 本组织                             | ❌                      |
| 企微收件箱导入                     | ✅                      | ✅ 本组织                             | ✅ 限自己               |
| 备份、CLI 级操作、改任何人的密码   | 只能在本机用 CLI        | ❌                                    | ❌                      |

**必须成立的不变式（要有测试盯着）**

1. 任何按 id 访问的跨组织请求返回 **404**（不返回 403，避免泄露资源是否存在）。
2. 组织管理者不能把自己的角色改掉，也不能把别人提升为 `admin`。
3. 组织里**最后一个 `manager`** 不能被停用、不能退出、不能降级，除非先指定另一个 `manager`——否则组织会变成无主。
4. `admin` 不能把自己降级（否则系统再无人能管理组织），只能由本机 CLI 恢复。
5. 归档组织下的数据：成员登录后处于「未加入」状态（因为成员已被退回），任何指向该组织数据的请求 404；管理员仍可查看。
6. 停用（`is_active=0`）账号立即失去会话（沿用现有 `sessionUser` 里的 `u.is_active=1` 条件）。

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

### 5.4 密码重置（本机 CLI）

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

端点总数从 48 变为 **约 62**。

## 8. 页面

| 路由            | 变化                                                                          |
| --------------- | ----------------------------------------------------------------------------- |
| `/login`        | 新增（替代 `/access`）；`/access` 保留 302 到 `/login`，老书签不失效          |
| `/register`     | 新增                                                                          |
| `/password`     | 新增：强制改密页（`must_change_password=1` 时所有页面重定向到这里）           |
| `/join`         | 新增：组织列表 + 我的申请（提交/撤回）+ 申请状态；未入组用户唯一能访问的页面  |
| `/organization` | 新增：本组织管理——成员列表、待审批申请、拉人入组、改名、解散（manager/admin） |
| `/admin`        | 新增：全局管理——组织总览、创建组织、归档/恢复、账号总览（admin）              |
| 现有 8 个页面   | 全部接入组织上下文；admin 增加组织筛选器（D-28）                              |
| 外壳导航        | 增加当前组织/组织切换器、用户名与角色显示；`/access` 链接改 `/login`          |

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

1. `npm run db:rehearse` 全绿（当前：**44 项 0 失败**，见 §12）。
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

| 阶段         | 内容                                                                                                    | 验收                                                                                     | 状态                   |
| ------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------- |
| **A 数据层** | 009/010 迁移、`organizations`/`join_requests`/成员与账号 repository、`password` 工具、`user:init` CLI   | 副本上迁移后行数逐表核对一致；`user:list`/`user:passwd` 可用；`test:db` 全绿             | ✅ 2026-09-10          |
| **B 认证**   | register/login/password 端点、scrypt、会话、`must_change_password` 门禁；退役令牌登录与 `owner:reset`   | 注册→登录→改密→登录全链路 HTTP 通过；旧令牌一律 401；`test:auth` 端到端通过              | 分支开发中             |
| **C 隔离**   | 所有业务查询加组织过滤、组织/成员/申请端点、§4 的 6 条不变式                                            | 新增跨组织隔离测试（构造 2 个组织，逐端点验证 404）；契约按新行为重录                    | 分支开发中             |
| **D 界面**   | `/login`、`/register`、`/password`、`/join`、`/organization`、`/admin` + 8 个页面接入组织上下文与筛选器 | `smoke:ui` 全绿并渲染出真实数据；`antd lint app` 无问题；人工过一遍关键路径              | 分支开发中             |
| **E 收尾**   | 契约全量重录、夹具改造（2 个组织）、文档回写、正式库迁移与演练                                          | **305 条**契约全部一致（✅ 已重录）；正式库迁移前后行数核对；README/harness 六份文档回写 | 进行中（差正式库迁移） |

**对现有资产的影响**：`tools/contract/fixture.ts` 要改成「两个组织 + 三角色 + 无组织用户」；
对现有资产的实际影响：`tools/contract/fixture.ts` 已改成「3 个组织（含 1 个已解散）+ 8 个账号（含无组织与待改密）」，
用例从 139 条扩到 **305 条**（新增 `org.` 88 条、`members.` 6 条、认证域重写为 28 条，其余域补上组织上下文）；
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

- `test:db` 13/13（原 7 + 密码 6）。
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
| 组织   | `app/lib/organization.server.ts`（组织 CRUD/归档恢复、成员管理、入组/退组/被拉入的完整台账、最后一名 manager 保护）；`app/routes.orgs.ts` + 13 个端点；`/organization`、`/admin` 页面；`/collaboration` 改为只读协作概览                                                                                   |
| 隔离   | 任务域（`visibilityClauses`）、记录域（`recordClauses`）、周报域（`reportVisibilityClauses`）、概览/成员/文件库全部按组织过滤；所有 `INSERT` 显式写 `org_id`；跨组织一律 404                                                                                                                               |
| 数据层 | `009`/`010` 已启用（17 张表）；`json-migration.ts` 重写为新结构；删除 `owner-token.ts`、4 个死 repository、`api.users*` 3 个路由                                                                                                                                                                           |
| 工具   | 夹具改为 3 组织 / 8 账号；契约 305 条并重录 golden；`contract:capture` 默认改用 `serve`；`smoke:ui` 覆盖新认证 + `/join` + `/organization` + `/admin` + 越权回弹；`npm test` 增加 `pretest` 自动 build                                                                                                     |
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
| `npm test`                                  | **全绿**：db 16/16 · 契约 305/305 全部一致 · auth 2/2 · ui 72/72                                                                                                                |
| 组织/隔离 HTTP 探针（主线临时脚本，60+ 项） | **75/75**：可见范围、创建权限、成员越权 404/403、入组申请→审批→重复申请、撤回、退组审批、最后一名 manager 三条路径、拉人入组、角色变更、跨组织成员操作、改名越权、归档/恢复语义 |
| `npm run db:rehearse`（正式库副本）         | **44/44**：逐表行数一致、账号映射、组织归属、外键完整性、四条约束探针（含 `manager` 必须有组织 / `admin` 不得隶属组织）                                                         |
| 全新空库 `001–010`                          | 迁移通过，17 张表、0 组织、`access_tokens` 已删、外键干净                                                                                                                       |
| 各域自验（工作流临时脚本）                  | 任务 64+21 项、记录 28+23 项、周报 73+12 项、概览/访问信息 全部通过                                                                                                             |
| 静态门禁                                    | lint 0/0 · typecheck 四工程 0 · `antd lint app` 91 文件无问题 · `format:check` 无漂移 · build 通过                                                                              |

### 已知未覆盖 / 后续

- **没有做过浏览器人工走查**（本环境无浏览器自动化）：`Select value=""`、`DatePicker` 中文 locale、组织页交互手感都只经过 SSR 冒烟与静态门禁（`DEBT-16`）。
- 不变式 6（停用账号立即失去会话）没有契约用例：停用会撤销该账号全部会话，而 runner 按角色缓存会话，会让后续用例全线 401；需要单开账号覆盖。
- `runCases` 只替换 **path** 里的 `{{变量}}`，body 与 multipart 字段不替换（用例已用 `IDS` 字面量规避）。
- golden 里会录制登录/改密用例的**明文密码**（与旧 `TOKENS` 同级别暴露面，本机自用可接受）。
- D-28 的组织筛选器目前只在任务页与记录页/概览页的写入口落地，`/reports` 尚未加（载荷不带 orgId）。

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

| 改造前                               | 改造后                                                            |
| ------------------------------------ | ----------------------------------------------------------------- |
| `user.role === "owner"`              | `user.role === "admin"`（全局）                                   |
| owner 能看全部任务                   | admin 看全部组织；manager 看**本组织**全部；member 只看自己负责的 |
| owner 才能改任务元信息 / 审批 / 退回 | admin 或**本组织 manager**                                        |
| 助理看自己的、查看者看助理负责的任务 | member 只看 `owner_id = 自己` 的任务                              |
| 私密任务只有 owner 可见              | admin 全可见；manager 只见**自己创建的**私密任务；member 不可见   |

### 14.4 不要改动的东西

- 响应信封 `{ok:true,data}` 与 `{ok:false,error:{code,message}}`（`app/lib/http.server.ts`）；
- CSP / `content-type` 等安全头；
- 已有端点的**路径**与**成功状态码**，除非本文 §7 明确要求改；
- 任何 `.js` 文件（仓库只允许 TypeScript）。

### 14.5 并行改动的文件归属

同一时间只允许一个工作流改同一个文件。公共文件（`app/routes.ts`、`app/root.tsx`、
`app/lib/{db,session,organization}.server.ts`、`tools/contract/runner.ts`）由主线统一维护，工作流不要改。

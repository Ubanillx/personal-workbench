# 代码规范（TypeScript / oxlint / Prettier）

## 1. 语言约束：只允许 TypeScript

| 项       | 规定                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 源码后缀 | 只允许 `.ts`、`.tsx`、`.mts`；**禁止新增 `.js` / `.jsx` / `.cjs`**                                                           |
| 例外     | 构建产物（`build/`、`.react-router/`）与归档（`_archive/`）不参与检查，`node_modules` 同理                                   |
| 强制手段 | 四个 tsconfig 均 `allowJs` 未开启；lint 覆盖 `app/`、`server/`、`tools/`、`test/`、`shared/`（`npm run lint` 实测 106 文件） |
| 现状     | 2026-09-10 核查：源码中已无任何 `.js` 文件（`_archive/` 内为已归档的旧实现）                                                 |

## 2. 类型严格度

四个 tsconfig 都开启了 `strict`、`noImplicitAny`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。此外：

- `server/tsconfig.json`：`target: ES2022` + `lib: ["ES2023"]`（需要 `Array#toSorted`）、`noEmit: true`、`module: NodeNext`。
- `tsconfig.json`（根，覆盖 `app/`）：`jsx: react-jsx`、bundler 解析，与 Vite/RR8 构建对齐。
- `tools/tsconfig.json`、`test/tsconfig.test.json`：NodeNext + `types: ["node"]`。
- 类型检查由 `npm run typecheck` 承担（四个工程串行，本机 TypeScript 7.0.2 原生编译器，见第 6 节）。

> `server/` 是 `module: NodeNext`：**相对导入不要写 `.js` 扩展名**，否则与现行配置不符；反过来，若将来给 `package.json`
> 加 `"type": "module"`，13 处导入会立刻报 `TS2835` 要求补 `.js`（这也是 D-16 不加该字段的原因）。

**不要**为了过编译而放宽以上开关；确有需要时先改本节并说明原因。

## 3. Lint：oxlint

配置文件 `.oxlintrc.json`，命令：

| 命令               | 用途                                     |
| ------------------ | ---------------------------------------- |
| `npm run lint`     | 检查（门禁要求 **0 warning / 0 error**） |
| `npm run lint:fix` | 自动修复可修复项                         |

### 开启的规则

| 规则                        | 级别  | 说明                       |
| --------------------------- | ----- | -------------------------- |
| `correctness` 类别（全部）  | error | 明确的错误用法，门禁阻断   |
| `no-shadow`                 | warn  | 禁止遮蔽外层同名标识符     |
| `react/rules-of-hooks`      | warn  | Hook 必须顶层调用          |
| `unicorn/no-array-sort`     | warn  | 用非变异的 `toSorted()`    |
| `unicorn/no-useless-spread` | warn  | 去掉多余展开               |
| `oxc/no-map-spread`         | warn  | `map` 内展开对象的性能问题 |

### 刻意关闭的规则及原因

| 规则                             | 原因                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `no-console`                     | 服务端 CLI 与启动日志需要 `console`                                                                |
| `typescript/no-explicit-any`     | SQL row → API view 的构造边界（`toTaskView`、`findXxx`）刻意用 `any`，逐字段转换由集成测试兜底     |
| `react/set-state-in-effect`      | 现有页面统一用「effect 内加载数据 → setState」模式；改为外部状态库属于功能改造，已登记为 `DEBT-12` |
| `react-hooks/exhaustive-deps`    | 同上：补依赖会改变请求时机（例如搜索框每次输入都重新拉取），需与功能一起改，已登记为 `DEBT-12`     |
| `promise/no-callback-in-promise` | 误报：把名为 `next` 的普通变量当成回调（`DashboardPage.tsx`）                                      |

## 4. 格式：Prettier

配置文件 `.prettierrc.json`：`printWidth: 140`、双引号、分号、`trailingComma: "all"`、`endOfLine: "lf"`、`tabWidth: 2`。
忽略清单见 `.prettierignore`（构建产物、`_archive/`、`data/`、`package-lock.json`）。

| 命令                   | 用途                       |
| ---------------------- | -------------------------- |
| `npm run format`       | 全量格式化                 |
| `npm run format:check` | 只检查是否有漂移（门禁项） |

## 5. 抑制注释规范

需要抑制时必须同时满足三条：

1. **紧贴目标行的上一行**——Prettier 折行后，原先「上一行」可能已经不是目标行，抑制会静默失效。这正是 `report.ts` 曾经的踩坑点（后改为把正则提为模块常量 `CONTROL_CHARS`，让注释与字面量重新相邻）。
2. **写明原因**，原因放在抑制注释的上一行（不要跟在规则名后面，避免解析歧义）。
3. **不许用文件级 disable**；只允许 `next-line` 级抑制。当前全项目抑制点共 2 处，均带原因注释。

示例：

```ts
// 文件名来自外部上传，必须剔除控制字符与路径分隔符，因此这里刻意匹配控制字符
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f/\\]/gu;
```

## 6. 为什么不用 ESLint / knip / ts-prune（实测结论）

本机 TypeScript 是 **7.0.2 原生 Go 编译器**：`typescript` 包的 `exports` 只有 `lib/version.cjs` 与 `typescript/unstable/*`，经典编译器 API（`createSourceFile`、`createProgram`、`sys` 等）**已不存在**。由此：

| 工具                                                  | 结论                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `typescript-eslint`（含 `@typescript-eslint/parser`） | peer 要求 `typescript >=4.8.4 <6.1.0`，且依赖经典 API → **不可用**（除非把 TypeScript 降回 6.x） |
| `knip`、`ts-prune`（死代码检测）                      | 依赖经典 API → **不可用**；死代码目前靠 grep + 人工核对（见 `DEBT-05`）                          |
| `oxlint`                                              | 自带 TS/TSX 解析器，不依赖 TypeScript 包 → **可用**，43 文件 60ms                                |
| `prettier`                                            | 实测可解析 TS/TSX → **可用**                                                                     |

## 7. 命名约定

- React Hook 前缀 `use*` 只用于组件/Hook；**API 客户端函数不得用 `use*` 前缀**（曾把 `/files/:id/use` 的封装命名为 `useFile`，被 `react/rules-of-hooks` 判为 Hook 误用，已改名 `markFileUsed`）。
- 文件名：组件与页面用 `PascalCase.tsx`，其余用 `kebab-case.ts`（如 `migration-runner.ts`）。
- 数据库字段用 `snake_case`，API/TS 字段用 `camelCase`，SQL 里用 `AS` 显式别名转换。

## 8. 交付前门禁（四件套）

```bash
npm run lint          # 0 warning / 0 error
npm run typecheck     # server + tools + app + test
npm test              # 423/423
npm run build         # 前端 + 后端产物
```

格式化漂移用 `npm run format:check` 单独确认。提交信息用中文，格式 `type(scope): 摘要`（`type` 取值：feat / fix / refactor / style / chore / docs / test）。

## 9. 新增规则的流程

1. 在 `.oxlintrc.json` 里加规则并选好级别（默认从 `warn` 起步）。
2. 跑 `npm run lint` 看存量命中数。
3. 能当次修完就修；修不完则**不要开规则**，而是在 `TECH_DEBT.md` 登记（写明命中数、涉及文件、暂缓原因），修复后再开。
4. 同步更新本文第 3 节的规则表。

## 10. UI 组件规范（antd v6）

UI 统一使用 **antd v6**（`antd@6.6.3` + `@ant-design/icons@6.3.4`），品牌色沿用旧版手写样式的 `#185fa5`，在 `app/root.tsx` 的 `ConfigProvider` 里集中配置（`locale=zh_CN` + `theme.token.colorPrimary`），反馈组件一律走 `AntdApp.useApp()`。

### 10.1 先查再写（强制）

`.agents/skills/antd/SKILL.md` 与仓库根 `AGENTS.md` 要求：**写 antd 代码前先用官方 CLI 查 API，不许凭记忆写**。antd v6 与 v5 差异很大，凭记忆写必然踩废弃 API。

| 命令                            | 用途                                       |
| ------------------------------- | ------------------------------------------ |
| `npx antd info <组件>`          | 查 props、类型、默认值、引入版本           |
| `npx antd demo <组件> <示例名>` | 取可直接改用的官方示例源码                 |
| `npx antd doc <组件>`           | 完整 markdown 文档                         |
| `npx antd lint app`             | **提交前必跑**：废弃用法 / a11y / 性能     |
| `npx antd doctor`               | 诊断项目级配置（版本冲突、重复安装、主题） |
| `npx antd usage app`            | 统计组件使用情况                           |
| `npx antd migrate 5 6`          | 版本迁移清单                               |

### 10.2 v6 与 v5 的关键差异（已核实清单）

| 组件         | v5 写法                        | v6 正确写法                                                                            |
| ------------ | ------------------------------ | -------------------------------------------------------------------------------------- |
| Button       | `type="primary"`               | `color="primary" variant="solid"`；`size` 是 `small/medium/large`（**没有 `middle`**） |
| List         | `<List dataSource renderItem>` | **`List` 已废弃** → `<Listy items rowKey itemRender>`                                  |
| Space        | `direction` / `split`          | `orientation` / `separator`                                                            |
| Alert        | `message`                      | `title`                                                                                |
| Card         | `bordered` / `bodyStyle`       | `variant` / `styles.body`                                                              |
| Tabs         | `Tabs.TabPane` / `tabPosition` | `items` / `tabPlacement`                                                               |
| Timeline     | `Timeline.Item`                | `items`                                                                                |
| Modal        | `destroyOnClose` / `bodyStyle` | `destroyOnHidden` / `styles.body`                                                      |
| Table        | `pagination.position`          | `pagination.placement`                                                                 |
| Tag          | `bordered={false}`             | `variant="filled"`                                                                     |
| Divider      | `type`                         | `orientation`                                                                          |
| Dropdown     | `Dropdown.Button`              | `Space.Compact + Dropdown + Button`                                                    |
| notification | `message`                      | `title`                                                                                |
| Progress     | `strokeWidth` / `trailColor`   | `size` / `railColor`                                                                   |
| Form         | `onFinish` 含未注册字段        | v6 起 `onFinish` **不包含**未注册的 Form.Item 字段                                     |

### 10.3 反馈组件必须走上下文

```tsx
import { App as AntdApp } from "antd";

const { message, modal, notification } = AntdApp.useApp();
```

**禁止**使用 `message.success()` 这类静态方法：静态方法拿不到 `ConfigProvider` 的主题与 locale。`app/root.tsx` 已用 `<AntdApp>` 包裹整棵树。

### 10.4 严格模式下的可选 prop

`exactOptionalPropertyTypes: true` 下**不能给可选 prop 传显式 `undefined`**，antd 的条件样式/状态最常踩：

```tsx
// ❌ type={done ? "secondary" : undefined}
<Typography.Text {...(done ? { type: "secondary" as const } : {})}>…</Typography.Text>
```

`validateStatus`、`help`、`status`、`type`、`variant` 等条件传参都要用条件展开。

### 10.5 布局与样式

- 布局优先用 antd 的 `Flex` / `Space` / `Row`+`Col` / `Layout`，**不要为新页面写 CSS**。
- 结构性辅助类集中在 `app/styles/layout.css`（`page-stack`、`page-head`、`status-card`、`fill-card`、`list-block`、`list-row` 等）。
- 早期手写样式（`web/src/styles/global.css`，840 行）已随旧前端归档，**不要再引入手写全局样式**。
- 视觉调整优先用 Design Token（`ConfigProvider` 的 `theme.token` / `theme.components`），而不是覆盖 antd 内部类名。

### 10.6 交付前新增一项门禁

```bash
npx antd lint app         # 必须 No issues found（当前 96 文件全过）
```

它不替代 `npm run lint`（oxlint），两者都要过。

### 10.7 列表页 / CRUD 交互规范（2026-09 页面重构后）

所有「列表 + 增删改」页面（`/tasks`、`/todos`、`/notes`、`/files`、`/organization`、`/admin`、`/reports`）
统一采用同一套骨架，共享组件集中在 `app/components/`：

| 组件 / Hook        | 职责                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| `page-header.tsx`  | 页头：栏目标识 + 标题（`level={4}`）+ 一句话说明；右侧 `extra` 放页级动作   |
| `crud-toolbar.tsx` | `TableToolbar`（左筛选 / 右动作）与 `SelectionAlert`（批量操作条）          |
| `crud-drawer.tsx`  | `FormDrawer`：新建与编辑共用的表单抽屉（含服务端错误展示）                  |
| `crud-actions.tsx` | `RowActions`（行内动作平铺）、`confirmAction`、`confirmDanger`              |
| `crud-hooks.ts`    | `useCrudFeedback`（成功 toast + 自动关抽屉）、`useListParams`（筛选进 URL） |

必须遵守的交互约定：

1. **结构**：`PageHeader` → 列表 `Card`（内含 `TableToolbar` + 可选 `SelectionAlert` + `Table`）→ 表单 `FormDrawer` / 详情 `Drawer`，录入与查看一律走右侧抽屉，不再用居中弹窗遮挡列表。
2. **录入**：新建与编辑一律走 `FormDrawer`（右侧抽屉），页面上不出现常驻「裸表单」；查看详情同样用 `Drawer` 只读展示，编辑从抽屉里的按钮打开表单抽屉，两者都在侧边完成。**同一时刻只挂一个右侧抽屉**：编辑对象存成组件 state（如 `editingTask`），详情抽屉加 `!editing*` 条件渲染——两个同层浮层的层级只由 DOM 顺序决定，叠在一起会互相压住，出现「点了编辑看不见表单」。编辑态不必进 URL，选中对象本身才是数据源（与 `/todos`、`/notes`、`/files` 一致）。
   浮层套浮层（例如表单抽屉里点「选择文件」打开一个选择器）可以，但**内层浮层必须挂在抽屉内容里**（`FormDrawer` 的 `afterForm`）：antd 会给嵌套浮层 +100 层级，保证内层稳稳盖在外层之上；不要写成两个同层抽屉靠 DOM 顺序压住彼此（`/files` 的 `WebDavFilePicker` 就是这么挂的，见 `WEBDAV.md` §2.2）。
3. **筛选**：筛选与搜索条件写进 URL（`useListParams`），可刷新、可分享、可回退；搜索框用 `Input.Search` 并只在回车/点击时提交。
4. **行操作**：`RowActions` 把所有动作**直接平铺**展示（不再收进「更多」下拉），每个动作统一 `size="small"` + `variant="text"` + **纯图标**，文字只出现在悬停 `Tooltip` 里（`label` 同时充当 `aria-label`），用 `tone` 区分语义（`default` 中性 / `primary` 强调 / `danger` 危险），必要时自动换行；`Upload` / `Popconfirm` 包裹按钮走 `render`，内部复用 `IconActionButton` 保持同一视觉。
5. **批量**：表格启用 `rowSelection` + `SelectionAlert`，批量动作逐条调用**同一个**服务函数并汇总成功/失败数，不新写 SQL。
6. **反馈**：成功用 `useCrudFeedback` 弹全局提示并关闭抽屉；失败**必须**渲染成常驻 `Alert`（页面顶部与抽屉顶部各一处），不要只弹 toast——SSR 冒烟测试也正是靠 HTML 里的错误文案做断言。
7. **确认**：破坏性操作（删除 / 归档 / 解散 / 停用）用 `confirmDanger`，文案要写清影响范围；普通操作（通过、启用、恢复）用 `confirmAction`，不用原生 `window.confirm`。
8. **表格**：稳定 `rowKey`、`size="middle"`、受控 `loading`、分页带 `showTotal`、`locale.emptyText` 用带引导动作的 `Empty`、需要时给 `sorter` 与列 `filters`。
   - **排版一律走 `dataTable()`**（`app/components/table-layout.ts` + `app/styles/table-layout.css`），不要自己写 `scroll={{ x: 数字 }}`：

     ```tsx
     const columns: TableProps<TaskRow>["columns"] = [/* … */];
     const table = useMemo(() => dataTable<TaskRow>({ columns, selectable: canManage }), [columns, canManage]);
     <Table<TaskRow> {...table} rowKey="id" dataSource={rows} loading={busy} />;
     ```

   - **自动排版**：`dataTable` 会设 `tableLayout="fixed"` 并把 `scroll.x` 按「列宽之和（+ 勾选列）」算出来——手写数字列一多一少就对不上，而定宽布局下长内容再也不会撑宽整张表；窄屏超出时自动出现横向滚动条。要纵向滚动时合并而不是覆盖：`scroll={{ ...table.scroll, y: 320 }}`。
   - **自动省略**：除行内动作列外，每列自动带 `ellipsis: true`——纯文本列出省略号并把全文写进 `title`，自定义 `render` 的列（按钮 / 标签 / 进度条 / 多行结构）被裁在自己列宽里，不再把右边的列挤歪。**行内动作列必须给 `ellipsis: false`**（一排图标按钮要能换行）。
   - **列宽**：主内容列不写 `width`（吃掉剩余空间），短文本列 100~~140，日期 / 人名 140~~180，进度 / 多标签 180~240，操作列按「每个图标按钮约 36px」给。同一张表在不同容器宽度下都用（如全屏入组页 + 工作台卡片）时用百分比列宽并传 `layout: "auto"`。
   - **线索**：单元格溢出把列挤歪是这套基线要根治的问题，回归时看渲染出的 `<table>` 是否有 `table-layout:fixed`、包装元素是否有 `data-table`、文本单元格是否有 `ant-table-cell-ellipsis`。
9. **契约不变**：页面 `action` 只做 `intent → 服务函数` 映射与文案包装，业务规则全部留在 `app/lib/*.server.ts`；改写 UI 不得绕过域校验，也不得改变既有表单字段名（`content` / `todoDate` / `name` / `filePath` / `category` / `orgId` 等）。
10. **字段对齐（D-47）**：**列表显示的每一列，都必须在新建/编辑抽屉里有对应字段或明确入口**；表单里的每个字段也必须在列表里有对应列（管理员专属字段就配管理员专属列）。同一个字段在**列头 / 筛选器 / 表单标签 / Tag 文案**里只用一个说法（例：`todos.is_completed` 一律叫「未完成 / 已完成」，不许列表里改叫「待处理」）。
    - 动作驱动的字段（任务的状态与进度）不做成可自由填写的输入项，而是在抽屉里**只读展示当前值 + 平铺当前允许的流转按钮**（见 `TaskProgressPanel`）；理由见 [`ACCOUNTS_AND_ORGS.md`](ACCOUNTS_AND_ORGS.md) §22.1。
    - 筛选器作用的字段必须在列表里看得见（例：`/tasks` 的「更新时间范围」对应「最近更新」列）；只能靠隐藏字段筛选时，要么补列，要么换筛选口径。
    - 冒烟测试只断言字符串标记，**发现不了字段集合缺失**：改 CRUD 页面时请手工把列头与表单字段逐个对一遍。

### 10.8 文案规范（界面文字，2026-09）

界面文字按「用户 3 秒内要知道什么、做什么」来写：**短、具体、可执行**。同一个 Tab 里同一样东西只出现一次。

| 位置               | 规范                                                 | 反例 → 正例                                                                                                                                       |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 页头 `description` | 一句话说清这一页管什么，动宾短语，≤ 14 字            | 「管理全部组织、成员与账号，审批加入与退出申请。」→「管理组织、成员与账号。」                                                                     |
| `Card` 脚注 / 说明 | 只写用户会踩的坑；不写实现、不写历史                 | 「地址是部署级的：请在仓库根的 .env 里设置 WEBDAV_URL，保存后重启服务。」→「请在 .env 中设置 WEBDAV_URL 后重启服务。」                            |
| `Alert`            | 标题给结论（≤ 10 字），正文给**一个**动作（≤ 20 字） | 「还没有可用的 WebDAV 连接」+「周报直接用上面…（用户名 / 密码 / 浏览根目录）：管理员先保存一次…」→「未配置 WebDAV 连接」+「请先在上方保存连接。」 |
| `tooltip`          | 只补充标签没说清的约束，≤ 16 字                      | 「部署级配置，来自环境变量 WEBDAV_URL；全员共用，改地址请改 .env 并重启服务」→「全员共用，修改后需重启服务」                                      |
| 占位符             | 示例或**当前状态**，不复述规则                       | 「留空 = 用连接的浏览根目录」→「留空则使用连接的浏览根目录」                                                                                      |
| 确认弹窗           | 「做了什么 + 影响范围」，一句话说完                  | 「恢复后本组织的周报写到连接的浏览根目录下（连接与其他组织都不受影响）。」→「将改回使用连接的浏览根目录。」                                       |
| 成功提示           | 「对象 + 已动作」，≤ 12 字                           | 「已恢复默认：本组织的周报写到连接的浏览根目录下」→「已恢复默认目录」                                                                             |

三条硬规则：

1. **不写实现**：界面里不出现表名 / 列名 / 迁移号 / 决策号（`D-xx`）/ 内部代号；`_v2`、`_2` 这类命名细节属于文档，不属于界面。
2. **不复述**：字段标签、`Tag`、占位符、脚注各说一遍同一件事；同一样东西不在两张卡里各画一次（例：「WebDAV 连接」只画在连接那张卡上，「周报上传」卡只回显目录）。
3. **语气**：不用感叹号、不用「我们」、不用「请点击」；中英文之间留一个空格，标点用中文全角。

> 改文案会牵动 SSR 冒烟（`tools/contract/smoke-ui.ts` 用字符串断言界面）：改完先 grep 一遍断言里的原句，一起更新。

## 11. 批量改文件的编码陷阱（2026-09 事故复盘）

源码是 **UTF-8 无 BOM**，而 Windows PowerShell **5.1** 的 `Get-Content` / `Set-Content` 默认走 **ANSI（GBK/936）**：

```powershell
# ❌ 5.1 下这条会把整个文件的中文读成乱码，并在写回时丢字节（每个中文字符串结尾都可能被吃掉引号）
(Get-Content $file -Raw).Replace(...) | Set-Content $file -Encoding utf8
```

实测（同一段 UTF-8 中文 `E4 B8 AD E6 96 87 EF BC 8C` 读→写一轮）：

| 解释器                         | 结果                                   |
| ------------------------------ | -------------------------------------- |
| Windows PowerShell 5.1（默认） | 丢字节（`，` 的尾字节被吃）            |
| PowerShell 7.x                 | 内容无损（`Encoding.Default = utf-8`） |

规定：

1. **改文件内容一律用编辑工具**（read / edit / write），不要用 shell 重定向写源码；
2. 必须脚本化处理文本时，用 PowerShell 7 的**绝对路径**调用，例如
   `& "$env:ProgramFiles\PowerShell\7\pwsh.exe" -NoProfile -File script.ps1`（本机 PS7 未加入 PATH，harness 的 `pwsh` 仍解析到 5.1）；
3. 在 5.1 里读写文件必须显式指定编码：`Get-Content -Encoding UTF8`、`Set-Content -Encoding UTF8`（`.NET` 侧则用 `New-Object System.Text.UTF8Encoding($false)` 避免 BOM）；
4. 事故可逆：5.1 的破坏是「UTF-8 字节按 GBK 解码后再按 UTF-8 写出」，可用 `[Text.Encoding]::GetEncoding(936).GetBytes()` 反向还原，只有解码失败的少数位置会丢字符（`U+FFFD` + `?`），此时以 `build/server/index.js`（事故前的构建产物）里的字符串为准逐条回填并全量比对。

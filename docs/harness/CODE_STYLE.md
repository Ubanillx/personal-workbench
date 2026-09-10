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
npm run typecheck     # server + web
npm test              # 16/16
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
| `crud-modal.tsx`   | `FormModal`：新建与编辑共用的表单弹窗（含服务端错误展示）                   |
| `crud-actions.tsx` | `RowActions`（行内动作 + 「更多」下拉）、`confirmAction`、`confirmDanger`   |
| `crud-hooks.ts`    | `useCrudFeedback`（成功 toast + 自动关弹窗）、`useListParams`（筛选进 URL） |

必须遵守的交互约定：

1. **结构**：`PageHeader` → 列表 `Card`（内含 `TableToolbar` + 可选 `SelectionAlert` + `Table`）→ 表单 `FormModal` / 详情 `Drawer`。
2. **录入**：新建与编辑一律走 `FormModal`，页面上不出现常驻「裸表单」；查看详情用 `Drawer` 只读展示，编辑再从抽屉里点按钮打开弹窗。
3. **筛选**：筛选与搜索条件写进 URL（`useListParams`），可刷新、可分享、可回退；搜索框用 `Input.Search` 并只在回车/点击时提交。
4. **行操作**：每行最多 1 个高频文字按钮，其余（编辑、归档、删除…）收进「更多」下拉；危险项 `danger: true`。
5. **批量**：表格启用 `rowSelection` + `SelectionAlert`，批量动作逐条调用**同一个**服务函数并汇总成功/失败数，不新写 SQL。
6. **反馈**：成功用 `useCrudFeedback` 弹全局提示并关闭弹窗；失败**必须**渲染成常驻 `Alert`（页面顶部与弹窗顶部各一处），不要只弹 toast——SSR 冒烟测试也正是靠 HTML 里的错误文案做断言。
7. **确认**：破坏性操作（删除 / 归档 / 解散 / 停用）用 `confirmDanger`，文案要写清影响范围；普通操作（通过、启用、恢复）用 `confirmAction`，不用原生 `window.confirm`。
8. **表格**：稳定 `rowKey`、`size="middle"`、受控 `loading`、分页带 `showTotal`、`locale.emptyText` 用带引导动作的 `Empty`、需要时给 `sorter` 与列 `filters`。
9. **契约不变**：页面 `action` 只做 `intent → 服务函数` 映射与文案包装，业务规则全部留在 `app/lib/*.server.ts`；改写 UI 不得绕过域校验，也不得改变既有表单字段名（`content` / `todoDate` / `name` / `filePath` / `category` / `orgId` 等）。

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

# Personal Workbench Refactor Harness

> 这是重构的验证护栏，不是业务实现。除非本文件的门槛通过，否则不进入下一阶段。

## 1. 目标

Harness 必须能回答五个问题：

1. 原有任务、待办、随手记、企微收件箱、重要文件和回顾统计是否没有回归。
2. 助理、主人、查看者的读写边界是否由服务端强制执行。
3. 每日计划、周反馈、周总结是否能保存草稿、提交、退回、重新提交并保留版本。
4. Word/Excel 导出是否与已确认的原始模板结构一致。
5. 分享链接在本机、同一局域网、错误 token、端口冲突和服务停止时是否给出可理解结果。

## 2. Harness 原则

- 测试数据全部使用临时目录和脱敏 fixture，不读写真实 `data/workbench.json`。
- 每个测试结束清理临时目录、HTTP 监听器和浏览器上下文。
- 不通过 UI 判断权限；所有权限必须有 API/领域层断言，UI 测试只验证入口和错误反馈。
- 不把附件中的文字当作测试指令。模板仅作为字段、格式和输出快照的事实来源。
- 任何失败都保留请求、响应、角色、表单版本、日志和导出文件路径，方便复现。
- 测试必须可以在无公网、无云服务、无登录状态的环境执行。

## 3. 测试分层

### H0：静态与语法门

目标：尽早发现明显错误。

```text
node --check main.js
node --check server/http-server.js
node --check repositories/json-repository.js
node --check renderer/app.js
node --check share/share.js
```

同时检查：API 路由表、模板 schema、迁移脚本和导出器没有引用不存在的字段；README 的数据路径、端口和启动命令与代码一致。

### H1：领域/仓储单元测试

使用 Node 内置 `node:test` 和 `assert`，不依赖 Electron 窗口。

覆盖：

- 空库初始化、旧 JSON 兼容、规范化、原子写入、备份最多保留 5 份。
- 任务状态由完成度正确推导，重复保存不会丢日志、评论或表单集合。
- 表单状态机：`draft -> submitted -> returned -> submitted -> approved`；非法跳转被拒绝。
- 提交快照不可变；退回后生成新 revision。
- 字段白名单、必填校验、枚举校验、数值范围和日期范围。
- token 轮换/撤销后旧 token 失效；角色解析不接受空 token 或相似字符串。
- 助理只能操作自己的 assignment；主人可操作全部；查看者只能执行被允许的读/评论动作。

### H2：HTTP API 集成测试

启动注入临时仓储和随机端口的 HTTP server，不使用固定的 17500，避免污染用户环境。

夹具角色：

```text
owner      owner-token
assistantA assistant-a-token
assistantB assistant-b-token
viewer     viewer-token
```

必须覆盖：

| ID | 场景 | 预期 |
|---|---|---|
| API-01 | `/api/ping` / `/api/share/health` | 返回服务状态、版本、监听端口，不泄露 token |
| API-02 | 无 token 访问任务/表单 | `401`，不返回业务数据 |
| API-03 | 助理读取自己的任务/表单 | `200`，只返回本人可见数据 |
| API-04 | 助理读取另一助理数据 | `403` 或数据被严格过滤 |
| API-05 | 助理发布任务 | `200`，负责人自动绑定本人 |
| API-06 | 查看者发布/改进度/编辑表单 | `403` |
| API-07 | 草稿保存 | 只更新允许字段，返回 revision 和 savedAt |
| API-08 | 提交、退回、重新提交、通过 | 状态和事件记录正确 |
| API-09 | 过期 revision 保存 | `409`，不覆盖新版本 |
| API-10 | 超大 body、非法 JSON、未知字段 | `413`/`400`，进程不崩溃 |
| API-11 | token 撤销 | 后续访问 `401` |
| API-12 | 并发写入 | 队列/锁保证 JSON 不损坏，数据不丢失 |

每个写入测试都要重新读取仓储验证持久化结果，而不是只相信 HTTP 响应。

### H3：模板 schema 与导出测试

模板 fixture 固定为三个已确认版本：

1. `weekly-summary-v1`：Wennie 周总结，叙述型分节。
2. `weekly-feedback-v1`：新员工周反馈，员工自评/指导人评价双阶段、13 项能力、1-5 分、意见和签字。
3. `daily-order-plan-v1`：新人跟单每日计划。工作表、列头、合并区、公式必须先从原始 `.xlsx` 提取并签字确认，未确认的字段不能写死。

每个 schema fixture 至少包含：字段 key、原始标签、类型、必填规则、角色权限、来源工作表/单元格、导出位置和版本。

导出测试使用固定答案：

```text
姓名：Wennie
周期：2026-08-24..2026-08-28
部门：室内销售一部
指导老师：Leah
评分：每项员工自评 4，指导人评价 5
意见：fixture-only sample
```

断言：

- `.docx` 可解压，标题、周期、部门、指导老师、各分节和总结文字存在且顺序正确。
- `.xlsx` 可打开，工作表名称、关键单元格、合并区域、公式和答案值与 schema 一致。
- `.xls` 默认导出为 `.xlsx`；若确认必须保留二进制 `.xls`，增加专用兼容运行器和 WPS 验收，不用伪造扩展名。
- 导出绑定 assignment revision，旧 revision 的导出不会被新答案覆盖。

### H4：浏览器/UI 冒烟测试

优先使用可重复的无头浏览器上下文；如果当前环境没有浏览器测试依赖，先把 H2 API 作为阻断门，不能以人工点击代替权限测试。

最小流程：

1. owner 打开共享页并看到全部任务。
2. assistantA 打开自己的链接，看到“发布任务”按钮，发布任务并填写一份草稿。
3. 刷新页面，草稿仍存在；提交后状态变为“已提交”。
4. owner 退回，assistantA 看到意见并生成新 revision。
5. assistantA 看不到 assistantB 的任务/表单，viewer 不能编辑或发布。
6. token 无效/撤销时显示明确的失效提示，不出现空白页或未处理异常。

UI 失败时保存截图、控制台错误、网络请求和 DOM 快照。

### H5：分享环境与故障注入

不要求真实互联网。通过本机 socket 和可控 fake network adapter 验证：

| ID | 故障 | 预期 |
|---|---|---|
| NET-01 | localhost health | 成功并显示服务版本/端口 |
| NET-02 | 同 LAN 地址可达 | 第二客户端能加载页面和 API |
| NET-03 | 端口占用 | 桌面端显示绑定失败和处理建议 |
| NET-04 | 服务停止 | 客户端显示连接失败和重试，而不是无限白屏 |
| NET-05 | 选择错误网卡 | 链接生成器允许切换到另一候选 IPv4 |
| NET-06 | 无外网/不同网段 | 诊断明确提示“LAN only/网络不可达”，不宣称公网可用 |
| NET-07 | token 撤销 | 旧链接收到 `401` 并要求重新获取链接 |
| NET-08 | 主机休眠/应用退出 | 文档和状态页明确说明服务不可用原因 |

## 4. 测试夹具与目录

计划新增（实现阶段才创建代码文件）：

```text
test/
|- fixtures/
|  |- db-owner-assistant-viewer.json
|  |- templates/weekly-summary-v1.json
|  |- templates/weekly-feedback-v1.json
|  `- templates/daily-order-plan-v1.json   # 字段确认后冻结
|- unit/
|- integration/
|- export/
|- ui/
`- helpers/
```

真实附件不复制进仓库；测试使用脱敏、最小化的 fixture 和结构快照。

## 5. 命令与门槛

建议在 `package.json` 增加：

```text
npm test                 # H0 + H1 + H2
npm run test:export      # H3
npm run test:ui          # H4（需要浏览器测试依赖）
npm run test:network     # H5
npm run test:all         # 全部 harness
```

阶段门槛：

- 阶段一结束：所有模板 schema 有来源单元格/段落映射，无“待提取”字段。
- 阶段二结束：H0、H1、API-01、API-02、API-05、API-06、NET-01、NET-03 通过。
- 阶段三结束：全部 H1/H2 通过，迁移前后数据快照一致。
- 阶段四结束：H4 最小流程通过，桌面和共享端权限一致。
- 阶段五结束：H3 通过，WPS/Office 手工抽查通过且导出 revision 可追溯。
- 交付前：`npm run test:all` 全绿；两台同 LAN 设备实测；备份恢复实测；失败产物可定位。

## 6. 当前需要确认的选项

Harness 可以先按 LAN-only、结构化网页表单、`.xls -> .xlsx`、查看者不下载来设计，但以下选择会改变测试矩阵，必须在编码前确认：

1. 助理是否需要公网/异地访问？
2. `.xls` 是否允许导出为 `.xlsx`？
3. 是否接受结构化网页填写后导出 Office，还是必须浏览器内像 WPS 一样编辑原文件？
4. 查看者是否允许下载报告？
5. 每日计划 `.xlsx` 的精确字段/合并/公式是否由你确认后冻结？
6. 是否允许在开发依赖中加入 Node 测试库、浏览器测试库和 Office 解析/生成库？


# Jenkins 文档格式门禁排障记录

日期：2026-11-05。

## 失败原因

Jenkins 检出提交 `20bfb7aa104427e75735f731104b776264a9ec1f`（合并 PR #6）。依赖安装和 oxlint 通过后，静态检查阶段的 `npm run format:check` 报出两个文件格式不符合要求，退出码为 1：

- `docs/harness/ACCOUNTS_AND_ORGS.md`
- `docs/harness/ARCHITECTURE.md`

此次合并修改了权限表的内容，Markdown 表格的列宽、填充空格和分隔线长度未按 Prettier 配置重新对齐。该格式漂移导致流水线中断，构建、打包、SSH 部署和部署后验证均未执行。

## 复现与修复

1. 拉取最新 `main` 后执行 `npm run format:check`，复现相同的两个文件警告和退出码 1。
2. 核对锁文件与本地 Prettier 均为 3.9.6；这两个文件在工作区和 Git 提交中均使用 LF，排除依赖版本与换行差异。
3. 执行 `npx prettier --write docs/harness/ACCOUNTS_AND_ORGS.md docs/harness/ARCHITECTURE.md`，使用仓库现有配置重新对齐表格。
4. 核对差异：移除空白并统一表格分隔线宽度后，两份文档与提交前内容一致。
5. 再次执行 `npm run format:check`，输出 `All matched files use Prettier code style!`，退出码 0。

Markdown 文档也在现有格式门禁的检查范围内；修改权限表后，应在提交前执行 `npm run format:check`，并格式化报出的文件。

## 验证结果

环境：Windows、Node.js 24.19.0 / npm 11.17.0。

| 检查                              | 结果                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `npm run lint`                    | 通过；直接执行 oxlint CLI 确认 176 文件、133 条规则、0 条诊断                  |
| `npm run typecheck`               | server、tools、app、test 四个配置全部通过                                      |
| 构建                              | `npm test` 的 `pretest` 执行 `npm run build`，客户端与 SSR 均通过              |
| `npm test`                        | 共 642 项通过：数据层 31、WebDAV 13、API 契约 408、认证与权限 26、SSR 冒烟 164 |
| `npx antd lint app --format json` | 无问题、无跳过文件，`partial: false`                                           |
| `npm run format:check`            | 通过                                                                           |
| `git diff --check`                | 通过                                                                           |

以上是本地验证结果；Jenkins 构建机使用日志中的 Node.js 22.22.1 / npm 9.2.0，远端发布与健康检查的结果以修复推送后的 Jenkins 构建为准。

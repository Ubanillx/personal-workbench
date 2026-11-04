# Jenkins 格式门禁排障记录

日期：2026-11-04。

## 失败原因

提供的 Jenkins 日志检出 `main` 的提交 `3b7ada9aaf9d12eafac137360b8b43f43f8ff3bd`。安装依赖和 oxlint 通过后，静态检查阶段的 `npm run format:check` 报出 6 个文件格式不符合要求，退出码为 1。后续构建、测试、打包、SSH 部署和部署后验证均未执行。

受影响文件：

- `app/components/task-dimensions.tsx`
- `app/lib/task-dimensions.server.ts`
- `app/routes/calendar.tsx`
- `app/routes/tasks.tsx`
- `docs/harness/DATA_MODEL.md`
- `tools/contract/smoke-ui.ts`

## 复现与修复

1. 拉取最新 `main`，执行 `npm run format:check`，复现相同的 6 个文件警告及退出码 1。
2. 执行 `npm ci --no-audit --no-fund --prefer-offline`，确认锁定的 Prettier 为 3.9.6；重新检查仍得到相同结果，排除本地依赖漂移。
3. 核对上述文件的工作区和 Git 已提交内容，均为 LF，排除 Windows/Linux 换行差异。
4. 用锁定的 Prettier 和仓库现有 `.prettierrc.json` 格式化上述 6 个文件，修正折行、缩进和 Markdown 表格对齐。
5. 重新运行 `npm run format:check`，输出 `All matched files use Prettier code style!`，退出码 0。

此修复仅调整格式；Jenkins 现有格式检查继续作为回归门禁。

## 验证结果

环境：Windows、Node.js 24.19.0、npm 11.17.0，使用 `package-lock.json` 安装依赖。

| 检查                              | 结果                                                                        |
| --------------------------------- | --------------------------------------------------------------------------- |
| `npm run lint`                    | 通过；另直接执行 oxlint CLI 确认 176 文件、133 条规则、0 条诊断             |
| `npm run typecheck`               | server、tools、app、test 四个配置全部通过                                   |
| 构建                              | `npm test` 的 `pretest` 自动执行 `npm run build`，客户端和 SSR 均通过       |
| `npm test`                        | 637 项通过：数据层 31、WebDAV 13、API 契约 406、认证与权限 26、SSR 冒烟 161 |
| `npx antd lint app --format json` | `issues: []`，无跳过文件，`partial: false`                                  |
| `npm run format:check`            | 通过                                                                        |
| `git diff --check`                | 通过                                                                        |

以上为本地验证结果。Jenkins 构建机使用日志中的 Node.js 22.22.1 / npm 9.2.0；远端打包、SSH 发布及健康检查的最终结果须以修复推送后的 Jenkins 构建为准。

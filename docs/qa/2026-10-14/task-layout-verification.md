# 任务进展排版验证记录

日期：2026-10-14。

## 桌面端

- 筛选下拉按时间、维度、状态、排序、负责人、组织排列，搜索栏紧随其后，显示控制统一为 Switch。
- “管理维度”与“新建任务”位于标题操作区；表格操作列显示设置维度、详情/汇报进度等图标。
- 清单视图中每条现有任务仍是一个子任务卡片，设置维度与详情/汇报进度图标固定在卡片右侧。

截图：`task-toolbar-redesign.png`、`task-checklist-redesign.png`。

## 移动端

- 使用 390×844 视口验证，页面 `scrollWidth` 为 390，无水平溢出。
- 三个 Switch 在窄屏仍保持可读；筛选项自然换行，清单卡片操作图标保持在右侧。

截图：`task-checklist-redesign-mobile.png`、`task-checklist-redesign-mobile-cards.png`。

## 行为核验

- 点击表格“设置维度”打开对应任务的个人维度抽屉。
- 清单中的“汇报进度”进入对应任务详情，详情内保留进度说明和保存入口。
- 切换清单视图通过 URL `view=checklist` 保持状态，未改变任务数据。

## 自动验证

- lint、四个配置的 typecheck、build、antd 官方 lint、format:check 通过。
- 全量 `npm test` 通过：数据层 31 项、WebDAV 13 项、API 契约 406 项、认证/权限/个人维度 15 项、SSR 冒烟 150 项。
- 首次全量运行发现个人维度测试仍断言旧摘要文案；已同步新文案并规范化文本空白，重新运行全部通过。

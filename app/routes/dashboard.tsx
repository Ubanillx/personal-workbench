import type React from "react";
import { Link, useLoaderData, useRevalidator } from "react-router";
import { Alert, Button, Card, Col, Empty, Flex, Listy, Progress, Row, Space, Statistic, Tag, Tooltip, Typography } from "antd";
import {
  AlertOutlined,
  ArrowRightOutlined,
  BellOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  EditOutlined,
  ReloadOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import type { TaskPriority, TaskStatus } from "../../shared/types/domain";
import { PageHeader } from "../components/page-header";
import { dashboardBoard, dashboardData, dashboardScopeLabel } from "../lib/dashboard.server";
import { requireUserOrRedirect } from "../lib/ui.server";

/**
 * 概览页：**只读展板**，不提供任何编辑入口（新增待办快捷表单已移除，见 D-40）。
 *
 * 数据全部来自 `app/lib/dashboard.server.ts`：
 * - `dashboardData(user)` 是与 `GET /api/dashboard` 共用的基础数据（任务 / 待办 / 随手记 + 统计）；
 * - `dashboardBoard(user, data)` 在同一份基础数据上派生只读展板（逾期与临期任务、今日待办、
 *   任务状态分布、最近随手记、最近文件、未读通知），**不额外重查任务/待办/随手记**。
 *
 * `requireUserOrRedirect` 已含三道页面门禁（未登录 → /login?redirectTo=…；待改密 → /password；
 * 未入组 → /join，D-34），数据范围文案由服务端算好下发，页面不自己维护角色映射。
 * 写入入口统一在 `/todos`、`/notes`、`/tasks` 等各自的列表页，概览页不再承担创建职责。
 */
/** 按时段给一句问候；在 loader 里算好下发，保证 SSR 与客户端 hydrate 文案一致 */
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 12) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

export async function loader({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  const data = dashboardData(user);
  return {
    ...data,
    scopeLabel: dashboardScopeLabel(user),
    board: dashboardBoard(user, data),
    greeting: greeting(),
  };
}

const STATUS_LABEL: Record<TaskStatus, string> = { todo: "待办", in_progress: "进行中", pending_review: "待验收", completed: "已完成" };
const STATUS_COLOR: Record<TaskStatus, string> = { todo: "default", in_progress: "processing", pending_review: "gold", completed: "green" };
const PRIORITY_COLOR: Record<TaskPriority, string> = { P0: "red", P1: "gold", P2: "default" };

/**
 * 顶部统计卡：只读数字 + 可选的口径提示。
 * `tone` 只在数字大于 0 时生效——「0 个逾期」不需要标红吓人，有数才提醒。
 * `hint` 只写「看不出来」的口径（例如哪些状态算未完成），标题已说清的不再重复。
 */
function StatCard({
  title,
  value,
  icon,
  hint,
  tone = "default",
}: {
  title: string;
  value: number;
  icon: React.ReactNode;
  hint?: string;
  tone?: "default" | "danger" | "warning" | "success";
}): React.ReactElement {
  const active = value > 0 && tone !== "default" ? tone : "default";
  const valueStyle =
    active === "danger"
      ? { color: "#cf1322" }
      : active === "warning"
        ? { color: "#d48806" }
        : active === "success"
          ? { color: "#389e0d" }
          : undefined;
  // 用 span 而不是 Space 作为 Tooltip 的挂载点：span 一定支持 ref，且能表达 help 光标
  const label = (
    <span className={hint ? "stat-label stat-label-help" : "stat-label"}>
      <span className={`stat-icon stat-icon-${active}`}>{icon}</span>
      <span>{title}</span>
    </span>
  );
  return (
    <Card variant="outlined" className="status-card" size="small">
      <Statistic value={value} title={hint ? <Tooltip title={hint}>{label}</Tooltip> : label} {...(valueStyle ? { valueStyle } : {})} />
    </Card>
  );
}

function statusTag(status: TaskStatus): React.ReactElement {
  return (
    <Tag color={STATUS_COLOR[status] ?? "default"} variant="filled">
      {STATUS_LABEL[status] ?? status}
    </Tag>
  );
}

export default function DashboardRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const busy = revalidator.state !== "idle";
  const { board } = data;
  // `dashboardData().tasks` 是 `unknown[]`（它就是 API 载荷，不在这里收紧形状），
  // 页面只读其中几个字段，这里就地声明一次视图形状给 Listy 用
  const tasks = data.tasks as unknown as Array<{
    id: string;
    title: string;
    status: TaskStatus;
    progress: number;
    orgName: string | null;
    ownerName: string | null;
  }>;

  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <PageHeader
        title="每日概览"
        eyebrow="TODAY"
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void revalidator.revalidate()} loading={busy}>
            刷新
          </Button>
        }
      />

      <Card variant="outlined" style={{ background: "linear-gradient(135deg, #eef5fd 0%, #ffffff 62%)", borderColor: "#d6e6f7" }}>
        <Space orientation="vertical" size={4} className="hero-copy">
          <Typography.Title level={4} className="hero-title">
            {data.greeting}，{data.user.name}
          </Typography.Title>
          <Space size={6} wrap align="center">
            <Tag color="blue" variant="filled">
              今天 {board.today}
            </Tag>
            <Typography.Text type="secondary">数据范围：{data.scopeLabel}</Typography.Text>
          </Space>
        </Space>
      </Card>

      {board.stats.overdueTasks > 0 || board.stats.overdueTodos > 0 ? (
        <Alert
          type="warning"
          showIcon
          title={`有 ${board.stats.overdueTasks} 个任务、${board.stats.overdueTodos} 条待办已逾期`}
          action={
            <Link to="/tasks">
              <Button size="small" icon={<ArrowRightOutlined />}>
                去处理
              </Button>
            </Link>
          }
        />
      ) : null}

      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} lg={4}>
          <StatCard title="未完成任务" value={data.stats.activeTasks} icon={<ClockCircleOutlined />} hint="含进行中与待验收" />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard title="逾期任务" value={board.stats.overdueTasks} icon={<AlertOutlined />} tone="danger" hint="截止日期已过且未完成" />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard title="待验收任务" value={board.stats.pendingReview} icon={<CheckCircleOutlined />} tone="warning" />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard title="今日待办" value={board.stats.todayTodos} icon={<UnorderedListOutlined />} />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard title="随手记" value={data.stats.notes} icon={<EditOutlined />} />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard title="未读通知" value={board.stats.unreadNotifications} icon={<BellOutlined />} tone="success" />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={10}>
          <Card title="任务状态分布" variant="outlined" className="fill-card">
            <Flex align="center" gap="large" wrap>
              <Progress
                type="dashboard"
                percent={board.completionRate}
                size={150}
                strokeColor="#185fa5"
                format={(percent) => (
                  <Space orientation="vertical" size={0}>
                    <Typography.Text strong className="gauge-value">
                      {percent}%
                    </Typography.Text>
                    <Typography.Text type="secondary" className="gauge-label">
                      完成率
                    </Typography.Text>
                  </Space>
                )}
              />
              <Space orientation="vertical" size="small" className="gauge-legend">
                {board.statusCounts.map((item) => (
                  <Flex key={item.status} justify="space-between" align="center" gap="middle" className="list-row">
                    {statusTag(item.status)}
                    <Typography.Text strong>{item.count}</Typography.Text>
                  </Flex>
                ))}
              </Space>
            </Flex>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card
            title={
              <Space size={6}>
                <span>需要关注的任务</span>
                <Tag color="orange" variant="filled">
                  {board.attentionTasks.length}
                </Tag>
              </Space>
            }
            extra={<Link to="/tasks">查看全部</Link>}
            variant="outlined"
            className="fill-card"
          >
            <Space orientation="vertical" size="middle" className="page-stack">
              <Typography.Text type="secondary">已逾期或 7 天内到期的未完成任务。</Typography.Text>
              {board.attentionTasks.length ? (
                <Listy
                  items={board.attentionTasks}
                  rowKey="id"
                  itemRender={(task) => (
                    <Space align="center" className="list-row">
                      <Space size={4} align="center" wrap>
                        <Tag color={PRIORITY_COLOR[task.priority] ?? "default"} variant="filled">
                          {task.priority}
                        </Tag>
                        <Link to={`/tasks?task=${task.id}`}>{task.title}</Link>
                      </Space>
                      <Space size={4} align="center">
                        <Tag color={task.overdue ? "red" : "orange"} variant="filled">
                          {task.overdue ? `逾期 ${task.dueDate}` : `${task.dueDate} 到期`}
                        </Tag>
                        <Typography.Text type="secondary">{task.ownerName ?? "未分配"}</Typography.Text>
                      </Space>
                    </Space>
                  )}
                />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="近 7 天没有需要关注的任务" />
              )}
            </Space>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={13}>
          <Card
            title={
              <Space size={6}>
                <span>最近任务</span>
                <Tag variant="filled">{tasks.length}</Tag>
              </Space>
            }
            extra={<Link to="/tasks">查看全部</Link>}
            variant="outlined"
            className="fill-card"
          >
            {tasks.length ? (
              <Listy
                items={tasks.slice(0, 6)}
                rowKey="id"
                itemRender={(task) => (
                  <Space orientation="vertical" size={2} className="list-block">
                    <Space size={4} align="center" wrap>
                      <Link to={`/tasks?task=${task.id}`}>{task.title}</Link>
                      {statusTag(task.status)}
                      {task.orgName ? <Tag>{task.orgName}</Tag> : null}
                      <Typography.Text type="secondary">{task.ownerName ?? "未分配"}</Typography.Text>
                    </Space>
                    <Progress percent={task.progress} size="small" status={task.status === "completed" ? "success" : "active"} />
                  </Space>
                )}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有任务">
                <Link to="/tasks">
                  <Button size="small" color="primary" variant="solid">
                    去创建任务
                  </Button>
                </Link>
              </Empty>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={11}>
          <Card
            title={
              <Space size={6}>
                <span>待办清单</span>
                <Tag color="blue" variant="filled">
                  {board.openTodos.length}
                </Tag>
              </Space>
            }
            extra={<Link to="/todos">查看全部</Link>}
            variant="outlined"
            className="fill-card"
          >
            <Space orientation="vertical" size="middle" className="page-stack">
              {board.openTodos.length ? (
                <Listy
                  items={board.openTodos}
                  rowKey="id"
                  itemRender={(todo) => (
                    <Space align="center" className="list-row">
                      <Typography.Text>{todo.content}</Typography.Text>
                      {todo.todoDate ? (
                        <Tag color={todo.todoDate < board.today ? "red" : todo.todoDate === board.today ? "blue" : "default"}>
                          {todo.todoDate}
                        </Tag>
                      ) : (
                        <Tag>未排期</Tag>
                      )}
                    </Space>
                  )}
                />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有未完成的待办">
                  <Link to="/todos">
                    <Button size="small" color="primary" variant="solid">
                      去添加待办
                    </Button>
                  </Link>
                </Empty>
              )}
            </Space>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={board.recentFiles ? 13 : 24}>
          <Card
            title={
              <Space size={6}>
                <span>最近随手记</span>
                <Tag variant="filled">{board.recentNotes.length}</Tag>
              </Space>
            }
            extra={<Link to="/notes">查看全部</Link>}
            variant="outlined"
            className="fill-card"
          >
            {board.recentNotes.length ? (
              <Listy
                items={board.recentNotes}
                rowKey="id"
                itemRender={(note) => (
                  <Space orientation="vertical" size={2} className="list-block">
                    <Space size={4} align="center">
                      {note.isPinned ? (
                        <Tag color="blue" variant="filled">
                          置顶
                        </Tag>
                      ) : null}
                      <Typography.Text>{note.content}</Typography.Text>
                    </Space>
                    <Typography.Text type="secondary">{dayjs(note.updatedAt).format("MM-DD HH:mm")}</Typography.Text>
                  </Space>
                )}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有随手记">
                <Link to="/notes">
                  <Button size="small" color="primary" variant="solid">
                    去记一条
                  </Button>
                </Link>
              </Empty>
            )}
          </Card>
        </Col>
        {board.recentFiles ? (
          <Col xs={24} lg={11}>
            <Card
              title={
                <Space size={6}>
                  <span>最近使用文件</span>
                  <Tag variant="filled">{board.recentFiles.length}</Tag>
                </Space>
              }
              extra={<Link to="/files">查看全部</Link>}
              variant="outlined"
              className="fill-card"
            >
              {board.recentFiles.length ? (
                <Listy
                  items={board.recentFiles}
                  rowKey="id"
                  itemRender={(file) => (
                    <Space align="center" className="list-row">
                      <Space size={4} align="center" wrap>
                        <Typography.Text>{file.name}</Typography.Text>
                        {file.category ? <Tag>{file.category}</Tag> : null}
                      </Space>
                      <Typography.Text type="secondary">
                        {file.lastUsedAt ? dayjs(file.lastUsedAt).format("MM-DD HH:mm") : "未使用"}
                      </Typography.Text>
                    </Space>
                  )}
                />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有登记文件索引">
                  <Link to="/files">
                    <Button size="small" color="primary" variant="solid">
                      去添加文件
                    </Button>
                  </Link>
                </Empty>
              )}
            </Card>
          </Col>
        ) : null}
      </Row>
    </Space>
  );
}

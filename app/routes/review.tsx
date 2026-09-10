import type React from "react";
import { useLoaderData, useNavigate, useRevalidator, useSearchParams } from "react-router";
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Flex,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  type TableProps,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { Task, TaskStatus, UserRole } from "../../shared/types/domain";
import { TableToolbar } from "../components/crud-toolbar";
import { PageHeader } from "../components/page-header";
import type { User } from "../lib/db.server";
import { listAllAccounts, listMembers } from "../lib/organization.server";
import { reviewData } from "../lib/review.server";
import { canManageTasks } from "../lib/tasks.server";
import { requireUserOrRedirect } from "../lib/ui.server";

type MemberRow = { id: string; name: string; role: UserRole };

const STATUS_LABEL: Record<TaskStatus, string> = { todo: "待办", in_progress: "进行中", pending_review: "待验收", completed: "已完成" };
const STATUS_COLOR: Record<TaskStatus, string> = { todo: "default", in_progress: "processing", pending_review: "gold", completed: "green" };
const RANGE_OPTIONS = [
  { value: "week", label: "最近 7 天" },
  { value: "month", label: "最近 30 天" },
  { value: "all", label: "全部时间" },
  { value: "custom", label: "自定义范围" },
];
const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "todo", label: "待办" },
  { value: "in_progress", label: "进行中" },
  { value: "pending_review", label: "待验收" },
  { value: "completed", label: "已完成" },
];

function formatDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

/** 负责人筛选的候选：admin 全部账号；manager 本组织成员加全局管理员（管理员也可以当负责人） */
function ownerCandidates(user: User): MemberRow[] {
  const toRow = (row: Record<string, unknown>): MemberRow => ({
    id: String(row.id),
    name: String(row.name ?? ""),
    role: String(row.role ?? "member") as UserRole,
  });
  if (user.role === "admin") return listAllAccounts().map(toRow);
  if (user.role === "manager" && user.orgId) {
    return [...listMembers(user.orgId), ...listAllAccounts().filter((row) => row.role === "admin")].map(toRow);
  }
  return [];
}

/** 回顾统计 loader：与 GET /api/review 共用 app/lib/review.server.ts；仅管理员与组织管理者可见（§4） */
export async function loader({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  if (!canManageTasks(user)) {
    return {
      forbidden: true as const,
      range: "month",
      from: "",
      to: "",
      ownerId: "",
      status: "",
      members: [] as MemberRow[],
      tasks: [] as Task[],
      summary: null,
    };
  }
  const query = new URL(request.url).searchParams;
  const range = query.get("range") ?? "month";
  const fromParam = query.get("from") ?? "";
  const toParam = query.get("to") ?? "";
  // 与旧前端一致：week/month 以"今天"回推，all 传空串，custom 用用户输入
  const end = new Date();
  const start = new Date();
  if (range === "week") start.setDate(end.getDate() - 7);
  if (range === "month") start.setDate(end.getDate() - 30);
  const filters = {
    from: range === "custom" ? fromParam : range === "all" ? "" : formatDate(start),
    to: range === "custom" ? toParam : range === "all" ? "" : formatDate(end),
    ownerId: query.get("ownerId") ?? "",
    status: query.get("status") ?? "",
  };
  // 空筛选表示不限；传空字符串会变成 owner_id=''，导致「全部负责人」没有数据。
  const { tasks, summary } = reviewData(user, {
    from: filters.from || null,
    to: filters.to || null,
    ownerId: filters.ownerId || null,
    status: filters.status || null,
  });
  return {
    forbidden: false as const,
    range,
    from: fromParam,
    to: toParam,
    ownerId: filters.ownerId,
    status: filters.status,
    members: ownerCandidates(user),
    tasks: tasks as unknown as Task[],
    summary,
  };
}

export default function ReviewRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [params] = useSearchParams();
  const busy = revalidator.state !== "idle";
  const today = dayjs().format("YYYY-MM-DD");

  /** 改一个查询参数就重跑 loader；不再维护筛选 state */
  const setParam = (patch: Record<string, string>): void => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    navigate(`?${next.toString()}`, { replace: true });
  };
  const resetFilters = (): void => {
    void navigate("?", { replace: true });
  };

  if (data.forbidden) {
    return (
      <Flex vertical gap="large" className="page-stack">
        <PageHeader eyebrow="REVIEW" title="回顾统计" description="按时间范围、负责人与状态统计任务完成情况。" />
        <Alert type="error" showIcon title="当前账户没有回顾统计权限" description="回顾统计仅对管理员与组织管理者开放。" />
      </Flex>
    );
  }

  const ownerOptions = [
    { value: "", label: "全部负责人" },
    { value: "unassigned", label: "未分配" },
    ...data.members.map((member) => ({ value: member.id, label: member.name })),
  ];
  const filtered = Boolean(data.range !== "month" || data.ownerId || data.status);
  const overdue = data.tasks.filter((task) => Boolean(task.dueDate && task.dueDate < today && task.status !== "completed")).length;

  const taskColumns: TableProps<Task>["columns"] = [
    {
      title: "任务",
      dataIndex: "title",
      key: "title",
      sorter: (a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"),
      render: (_value, task) => (
        <Space size={4} wrap>
          <Typography.Text>{task.title}</Typography.Text>
          {task.priority === "P0" ? (
            <Tag color="red" variant="filled">
              P0
            </Tag>
          ) : null}
        </Space>
      ),
    },
    { title: "负责人", dataIndex: "ownerName", key: "ownerName", width: 140, render: (_value, task) => task.ownerName ?? "未分配" },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      filters: Object.entries(STATUS_LABEL).map(([value, text]) => ({ text, value })),
      onFilter: (value, task) => task.status === value,
      render: (_value, task) => (
        <Tag color={STATUS_COLOR[task.status]} variant="filled">
          {STATUS_LABEL[task.status]}
        </Tag>
      ),
    },
    {
      title: "进度",
      dataIndex: "progress",
      key: "progress",
      width: 180,
      sorter: (a, b) => a.progress - b.progress,
      render: (_value, task) => <Progress percent={task.progress} size="small" />,
    },
    {
      title: "截止日期",
      dataIndex: "dueDate",
      key: "dueDate",
      width: 130,
      sorter: (a, b) => String(a.dueDate ?? "9999").localeCompare(String(b.dueDate ?? "9999")),
      render: (_value, task) =>
        task.dueDate ? (
          <Typography.Text {...(task.dueDate < today && task.status !== "completed" ? { type: "danger" as const } : {})}>
            {task.dueDate}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">未设置</Typography.Text>
        ),
    },
    {
      title: "最近更新",
      dataIndex: "updatedAt",
      key: "updatedAt",
      width: 170,
      sorter: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
      render: (_value, task) => <Typography.Text type="secondary">{dayjs(task.updatedAt).format("MM-DD HH:mm")}</Typography.Text>,
    },
  ];

  return (
    <Flex vertical gap="large" className="page-stack">
      <PageHeader
        title="回顾统计"
        description="按任务更新时间统计完成情况。"
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void revalidator.revalidate()} loading={busy}>
            刷新
          </Button>
        }
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card variant="outlined">
            <Statistic title="完成率" value={data.summary?.completionRate ?? 0} suffix="%" />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card variant="outlined">
            <Statistic title="任务总数" value={data.tasks.length} suffix="个" />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card variant="outlined">
            <Statistic title="待验收" value={data.tasks.filter((task) => task.status === "pending_review").length} suffix="个" />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card variant="outlined">
            <Statistic title="已逾期" value={overdue} suffix="个" />
          </Card>
        </Col>
      </Row>

      <Card variant="outlined" title="任务明细">
        <Flex vertical gap="middle">
          <TableToolbar
            extra={
              <Typography.Text type="secondary">
                共 {data.tasks.length} 个任务{filtered ? "（已筛选）" : ""}
              </Typography.Text>
            }
          >
            <Select
              value={data.range}
              onChange={(value: string) => setParam({ range: value })}
              options={RANGE_OPTIONS}
              style={{ width: 150 }}
            />
            {data.range === "custom" ? (
              <DatePicker.RangePicker
                value={data.from && data.to ? [dayjs(data.from), dayjs(data.to)] : null}
                onChange={(values) =>
                  setParam({
                    range: "custom",
                    from: values?.[0] ? values[0].format("YYYY-MM-DD") : "",
                    to: values?.[1] ? values[1].format("YYYY-MM-DD") : "",
                  })
                }
                format="YYYY-MM-DD"
              />
            ) : null}
            <Select
              value={data.ownerId}
              onChange={(value: string) => setParam({ ownerId: value })}
              options={ownerOptions}
              style={{ width: 170 }}
            />
            <Select
              value={data.status}
              onChange={(value: string) => setParam({ status: value })}
              options={STATUS_OPTIONS}
              style={{ width: 140 }}
            />
            {filtered ? (
              <Button color="default" variant="text" onClick={resetFilters}>
                重置
              </Button>
            ) : null}
          </TableToolbar>

          <Table<Task>
            rowKey="id"
            size="middle"
            columns={taskColumns}
            dataSource={data.tasks}
            loading={busy}
            scroll={{ x: 980 }}
            pagination={{
              pageSize: 10,
              showSizeChanger: true,
              showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 条`,
            }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前条件下没有任务" /> }}
          />
        </Flex>
      </Card>
    </Flex>
  );
}

import type React from "react";
import { useLoaderData, useNavigate, useRevalidator, useSearchParams } from "react-router";
import { Alert, Button, Card, Col, DatePicker, Flex, Row, Select, Space, Statistic, Table, Typography, type TableProps } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { Task, TaskStatus } from "../../shared/types/domain";
import { reviewData } from "../lib/review.server";
import { requireUserOrRedirect } from "../lib/ui.server";
import { listUsersFor } from "../lib/users.server";

type MemberRow = { id: string; name: string; role: "owner" | "assistant" | "viewer"; isActive: number | boolean };

function formatDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function labelsFor(status: TaskStatus): string {
  return { todo: "待办", in_progress: "进行中", pending_review: "待验收", completed: "已完成" }[status];
}

/** 回顾统计 loader：与 GET /api/review 共用 app/lib/review.server.ts；仅主人可见 */
export async function loader({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  if (user.role !== "owner") {
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
  const { tasks, summary } = reviewData(filters);
  const members = (listUsersFor("owner") as unknown as MemberRow[]).filter((member) => member.role !== "viewer");
  return {
    forbidden: false as const,
    range,
    from: fromParam,
    to: toParam,
    ownerId: filters.ownerId,
    status: filters.status,
    members,
    tasks: tasks as unknown as Task[],
    summary,
  };
}

export default function ReviewRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [params] = useSearchParams();

  if (data.forbidden) {
    return (
      <Space orientation="vertical" size="large" className="page-stack">
        <div>
          <Typography.Title level={3} className="page-title">
            回顾统计
          </Typography.Title>
        </div>
        <Alert type="error" showIcon title="当前账户没有回顾统计权限" description="回顾统计仅对主人开放，请使用主人令牌登录。" />
      </Space>
    );
  }

  /** 改一个查询参数就重跑 loader；不再维护筛选 state */
  const setParam = (patch: Record<string, string>): void => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    navigate(`?${next.toString()}`, { replace: true });
  };

  const ownerOptions = [
    { value: "", label: "全部负责人" },
    { value: "unassigned", label: "未分配" },
    ...data.members.map((member) => ({ value: member.id, label: member.name })),
  ];

  const taskColumns: TableProps<Task>["columns"] = [
    {
      title: "任务",
      dataIndex: "title",
      key: "title",
      render: (_value, task) => <Typography.Text>{task.title}</Typography.Text>,
    },
    { title: "负责人", dataIndex: "ownerName", key: "ownerName", render: (_value, task) => task.ownerName ?? "未分配" },
    { title: "状态", dataIndex: "status", key: "status", render: (_value, task) => labelsFor(task.status) },
    { title: "进度", dataIndex: "progress", key: "progress", render: (_value, task) => `${task.progress}%` },
  ];

  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <Space align="center" className="page-head" size="middle">
        <div>
          <Typography.Title level={3} className="page-title">
            回顾统计
          </Typography.Title>
        </div>
        {/* 同 URL 导航不会重跑 loader，刷新必须用 revalidate */}
        <Button icon={<ReloadOutlined />} onClick={() => revalidator.revalidate()} loading={revalidator.state !== "idle"}>
          刷新
        </Button>
      </Space>

      <Flex gap="small" align="center" wrap>
        <Select
          value={data.range}
          onChange={(value: string) => setParam({ range: value })}
          options={[
            { value: "week", label: "最近 7 天" },
            { value: "month", label: "最近 30 天" },
            { value: "all", label: "全部时间" },
            { value: "custom", label: "自定义范围" },
          ]}
          style={{ minWidth: 140 }}
        />
        {data.range === "custom" && (
          <>
            <DatePicker
              value={data.from ? dayjs(data.from) : null}
              onChange={(value) => setParam({ range: "custom", from: value ? value.format("YYYY-MM-DD") : "" })}
              format="YYYY-MM-DD"
            />
            <DatePicker
              value={data.to ? dayjs(data.to) : null}
              onChange={(value) => setParam({ range: "custom", to: value ? value.format("YYYY-MM-DD") : "" })}
              format="YYYY-MM-DD"
            />
          </>
        )}
        <Select
          value={data.ownerId}
          onChange={(value: string) => setParam({ ownerId: value })}
          options={ownerOptions}
          style={{ minWidth: 150 }}
        />
        <Select
          value={data.status}
          onChange={(value: string) => setParam({ status: value })}
          options={[
            { value: "", label: "全部状态" },
            { value: "todo", label: "待办" },
            { value: "in_progress", label: "进行中" },
            { value: "pending_review", label: "待验收" },
            { value: "completed", label: "已完成" },
          ]}
          style={{ minWidth: 140 }}
        />
      </Flex>

      {data.summary && (
        <>
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={8}>
              <Card variant="outlined">
                <Statistic title="完成率" value={data.summary.completionRate} suffix="%" />
              </Card>
            </Col>
            <Col xs={24} sm={8}>
              <Card variant="outlined">
                <Statistic title="逾期" value={data.summary.overdue} />
              </Card>
            </Col>
            <Col xs={24} sm={8}>
              <Card variant="outlined">
                <Statistic title="待验收" value={data.tasks.filter((task) => task.status === "pending_review").length} />
              </Card>
            </Col>
          </Row>

          <Card title="任务明细" variant="outlined" className="fill-card">
            <Table<Task>
              rowKey="id"
              columns={taskColumns}
              dataSource={data.tasks}
              pagination={false}
              locale={{ emptyText: "当前条件下没有任务。" }}
            />
          </Card>
        </>
      )}
    </Space>
  );
}

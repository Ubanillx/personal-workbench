import type React from "react";
import { useActionData, useLoaderData, useNavigation, useRevalidator, useSubmit } from "react-router";
import { Alert, Button, Card, Col, Empty, Form, Input, Listy, Progress, Row, Select, Space, Statistic, Tag, Typography } from "antd";
import { CheckCircleOutlined, ClockCircleOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { dashboardData, dashboardScopeLabel, dashboardTodoOrgs } from "../lib/dashboard.server";
import { readPayload } from "../lib/form.server";
import { roleLabel } from "../lib/session.server";
import { createTodoRecord } from "../lib/todos.server";
import { requireUserOrRedirect } from "../lib/ui.server";

/**
 * 概览页 loader：与 GET /api/dashboard 共用 app/lib/dashboard.server.ts 的实现，组织范围也一致
 * ——管理员是全部组织的合并数据，其他人只看到本组织。
 * `requireUserOrRedirect` 已含三道页面门禁（未登录 → /login?redirectTo=…；待改密 → /password；
 * 未入组 → /join，D-34），角色与数据范围文案由服务端算好下发，页面不再自己维护旧的角色映射。
 */
export async function loader({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  return {
    ...dashboardData(user),
    roleLabel: roleLabel(user.role),
    scopeLabel: dashboardScopeLabel(user),
    todoOrgs: dashboardTodoOrgs(user),
  };
}

/**
 * 待办快捷新增：页面表单（form-urlencoded）与 JSON 提交都走 readPayload，再调用共享服务（不是打 API）。
 * 待办按组织隔离（迁移 009 起 `todos.org_id` 是 NOT NULL），组织归属由 app/lib/todos.server.ts 的
 * `createTodoRecord(user, body)` 解析——普通用户/组织管理者写自己的组织；管理员不隶属组织（§3.2），
 * 目标组织先看表单字段，再看页面上的组织筛选器 `?org=`（D-28 的接缝，与 /todos、/notes 页一致）。
 * dashboard 不自己写 INSERT，避免出现第二套写入逻辑。
 */
export async function action({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  const payload = await readPayload(request);
  const result = createTodoRecord(user, {
    content: payload.content,
    todoDate: new Date().toISOString().slice(0, 10),
    orgId: payload.orgId || new URL(request.url).searchParams.get("org"),
  });
  return { error: result.ok ? "" : result.message };
}

export default function DashboardRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submit = useSubmit();
  const busy = navigation.state !== "idle" || revalidator.state !== "idle";
  const error = actionData?.error ?? "";
  const tasks = data.tasks as unknown as Array<{ id: string; title: string; progress: number }>;
  const todos = data.todos as unknown as Array<{ id: string; content: string; isCompleted: number | boolean }>;
  // 管理员的写入目标组织：默认选中第一个可用组织（表单只在有可选项时才渲染这一列）
  const defaultOrgId = data.todoOrgs.at(0)?.id ?? "";

  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <Space align="center" className="page-head" size="middle">
        <div>
          <Typography.Title level={3} className="page-title">
            每日概览
          </Typography.Title>
          <Typography.Text type="secondary">任务、待办和随手记已接入 SQLite，并按组织隔离。</Typography.Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => revalidator.revalidate()} loading={busy}>
          刷新
        </Button>
      </Space>

      <Card
        variant="outlined"
        className="status-card"
        title={
          <Space size="small">
            <Tag color="green">已连接</Tag>
            <Typography.Text strong>工作台状态</Typography.Text>
          </Space>
        }
      >
        <Space orientation="vertical" size={4}>
          <Typography.Text type="secondary">{`已连接，当前用户：${data.user.name}`}</Typography.Text>
          <Space size="small" align="center" wrap>
            <Tag color="blue">{data.roleLabel}</Tag>
            <Typography.Text type="secondary">{`数据范围：${data.scopeLabel}`}</Typography.Text>
          </Space>
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={8}>
          <Card variant="outlined">
            <Statistic title="进行中任务" value={data.stats.activeTasks} prefix={<ClockCircleOutlined />} />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card variant="outlined">
            <Statistic title="待办" value={data.stats.pendingTodos} prefix={<CheckCircleOutlined />} />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card variant="outlined">
            <Statistic title="随手记" value={data.stats.notes} prefix={<EditOutlined />} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={13}>
          <Card title="最近任务" variant="outlined" className="fill-card">
            {tasks.length ? (
              <Listy
                items={tasks.slice(0, 6)}
                rowKey="id"
                itemRender={(task) => (
                  <Space orientation="vertical" size={2} className="list-block">
                    <Typography.Text>{task.title}</Typography.Text>
                    <Progress percent={task.progress} size="small" status="active" />
                  </Space>
                )}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={11}>
          <Card title="待办清单" variant="outlined" className="fill-card">
            <Space orientation="vertical" size="middle" className="page-stack">
              {error ? <Alert type="error" showIcon title={error} /> : null}
              {/* 待办快捷新增走既有共享服务（同一份逻辑），成功后由 loader 重新校验刷新；
                  管理员不隶属组织，必须先在表单里选一个写入目标（records.server 的硬要求） */}
              <Form
                layout="inline"
                className="quick-add"
                onFinish={(values: { content?: string; orgId?: string }) => {
                  const content = values.content?.trim();
                  if (!content || busy) return;
                  submit(
                    { content, todoDate: new Date().toISOString().slice(0, 10), ...(values.orgId ? { orgId: values.orgId } : {}) },
                    { method: "post", encType: "application/json" },
                  );
                }}
              >
                {data.todoOrgs.length ? (
                  <Form.Item name="orgId" className="quick-add-item" initialValue={defaultOrgId}>
                    <Select placeholder="选择组织" options={data.todoOrgs.map((org) => ({ value: org.id, label: org.name }))} />
                  </Form.Item>
                ) : null}
                <Form.Item name="content" className="quick-add-item">
                  <Input placeholder="添加今日待办" allowClear />
                </Form.Item>
                <Form.Item>
                  <Button color="primary" variant="solid" htmlType="submit" icon={<PlusOutlined />} disabled={busy}>
                    添加
                  </Button>
                </Form.Item>
              </Form>
              {todos.length ? (
                <Listy
                  items={todos.slice(0, 5)}
                  rowKey="id"
                  itemRender={(todo) => (
                    <Space align="center" className="list-row">
                      <Typography.Text delete={Boolean(todo.isCompleted)}>{todo.content}</Typography.Text>
                      <Tag color={todo.isCompleted ? "default" : "blue"}>{todo.isCompleted ? "已完成" : "待处理"}</Tag>
                    </Space>
                  )}
                />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待办" />
              )}
            </Space>
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

import type React from "react";
import { Form, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { Button, Card, Col, Empty, Input, Listy, Progress, Row, Space, Statistic, Tag, Typography } from "antd";
import { CheckCircleOutlined, ClockCircleOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { dashboardData } from "../lib/dashboard.server";
import { createTodoRecord } from "../lib/todos.server";
import { requireUserOrRedirect } from "../lib/ui.server";

/** 概览页 loader：与 GET /api/dashboard 共用 app/lib/dashboard.server.ts 的实现 */
export async function loader({ request }: { request: Request }) {
  return dashboardData(requireUserOrRedirect(request));
}

/** 待办快捷新增：表单是 form-urlencoded，因此在这里读 formData 并调用共享服务（不是打 API） */
export async function action({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  const form = await request.formData();
  const content = String(form.get("content") ?? "");
  if (user.role === "owner") createTodoRecord(content, new Date().toISOString().slice(0, 10));
  return null;
}

export default function DashboardRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const busy = navigation.state !== "idle" || revalidator.state !== "idle";
  const tasks = data.tasks as unknown as Array<{ id: string; title: string; progress: number }>;
  const todos = data.todos as unknown as Array<{ id: string; content: string; isCompleted: number | boolean }>;

  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <Space align="center" className="page-head" size="middle">
        <div>
          <Typography.Title level={3} className="page-title">
            每日概览
          </Typography.Title>
          <Typography.Text type="secondary">任务、待办和随手记已接入 SQLite。</Typography.Text>
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
        <Typography.Text type="secondary">{`已连接，当前用户：${data.user.name}`}</Typography.Text>
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
              {/* 待办快捷新增走既有资源路由（同一份服务端逻辑），成功后由 revalidate 刷新 loader */}
              <Form method="post" className="quick-add">
                <Space.Compact style={{ width: "100%" }}>
                  <Input name="content" placeholder="添加今日待办" allowClear />
                  <Button color="primary" variant="solid" htmlType="submit" icon={<PlusOutlined />}>
                    添加
                  </Button>
                </Space.Compact>
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

import type React from "react";
import { useEffect, useState } from "react";
import { App as AntdApp, Button, Card, Col, Empty, Form, Input, Listy, Progress, Row, Space, Statistic, Tag, Typography } from "antd";
import { CheckCircleOutlined, ClockCircleOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { createTodo, getDashboard, type DashboardData } from "../services/apiClient";

export function DashboardPage(): React.ReactElement {
  const { message } = AntdApp.useApp();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [detail, setDetail] = useState("正在读取工作台数据");
  const [data, setData] = useState<DashboardData | null>(null);

  const load = (): void => {
    setStatus("loading");
    setDetail("正在读取工作台数据");
    void getDashboard()
      .then((next) => {
        setStatus("ready");
        setDetail(`已连接，当前用户：${next.user.name}`);
        setData(next);
      })
      .catch((reason: unknown) => {
        setStatus("error");
        setDetail(reason instanceof Error ? reason.message : "暂时无法连接 Node API");
      });
  };
  useEffect(load, []);

  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <Space align="center" className="page-head" size="middle">
        <div>
          <Typography.Title level={3} className="page-title">
            每日概览
          </Typography.Title>
          <Typography.Text type="secondary">任务、待办和随手记已接入 SQLite。</Typography.Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={load} loading={status === "loading"}>
          刷新
        </Button>
      </Space>

      <Card
        variant="outlined"
        className="status-card"
        title={
          <Space size="small">
            <Tag color={status === "ready" ? "green" : status === "error" ? "red" : "blue"}>
              {status === "ready" ? "已连接" : status === "error" ? "连接异常" : "连接中"}
            </Tag>
            <Typography.Text strong>工作台状态</Typography.Text>
          </Space>
        }
      >
        <Typography.Text type={status === "error" ? "danger" : "secondary"}>{detail}</Typography.Text>
      </Card>

      {data && (
        <>
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
                {data.tasks.length ? (
                  <Listy
                    items={data.tasks.slice(0, 6)}
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
                <TodoQuickList
                  todos={data.todos}
                  onCreated={(todo) =>
                    setData((current) =>
                      current
                        ? {
                            ...current,
                            todos: [todo, ...current.todos],
                            stats: { ...current.stats, pendingTodos: current.stats.pendingTodos + 1 },
                          }
                        : current,
                    )
                  }
                  onError={(reason) => void message.error(reason)}
                />
              </Card>
            </Col>
          </Row>
        </>
      )}
    </Space>
  );
}

function TodoQuickList({
  todos,
  onCreated,
  onError,
}: {
  todos: DashboardData["todos"];
  onCreated: (todo: DashboardData["todos"][number]) => void;
  onError: (reason: string) => void;
}): React.ReactElement {
  const [form] = Form.useForm<{ content: string }>();
  const [busy, setBusy] = useState(false);

  return (
    <Space orientation="vertical" size="middle" className="page-stack">
      <Form
        form={form}
        layout="inline"
        onFinish={(values: { content: string }) => {
          const content = values.content?.trim();
          if (!content) return;
          setBusy(true);
          void createTodo({ content, todoDate: new Date().toISOString().slice(0, 10) })
            .then((todo) => {
              onCreated(todo);
              form.resetFields();
            })
            .catch((reason: unknown) => onError(reason instanceof Error ? reason.message : "添加失败"))
            .finally(() => setBusy(false));
        }}
        className="quick-add"
      >
        <Form.Item name="content" className="quick-add-item">
          <Input placeholder="添加今日待办" allowClear />
        </Form.Item>
        <Form.Item>
          <Button color="primary" variant="solid" htmlType="submit" icon={<PlusOutlined />} loading={busy}>
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
              <Typography.Text delete={todo.isCompleted} {...(todo.isCompleted ? { type: "secondary" as const } : {})}>
                {todo.content}
              </Typography.Text>
              <Tag color={todo.isCompleted ? "default" : "blue"}>{todo.isCompleted ? "已完成" : "待处理"}</Tag>
            </Space>
          )}
        />
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待办" />
      )}
    </Space>
  );
}

import type React from "react";
import { useActionData, useLoaderData, useNavigation, useRevalidator, useSubmit } from "react-router";
import { Alert, Button, Checkbox, Empty, Form, Input, Listy, Popconfirm, Space, Typography } from "antd";
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { readPayload } from "../lib/form.server";
import { createTodoRecord, deleteTodoRecord, listTodos, updateTodoRecord } from "../lib/todos.server";
import { requireUserOrRedirect } from "../lib/ui.server";

type TodoRow = { id: string; content: string; todoDate: string | null; isCompleted: number | boolean; completedAt: string | null };

export async function loader({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  // 待办是主人专属（与 API 的 requireOwner 一致）；非主人看到同样的提示，而不是空白页
  if (user.role !== "owner") return { items: [] as TodoRow[], forbidden: true };
  return { items: listTodos() as unknown as TodoRow[], forbidden: false };
}

export async function action({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  if (user.role !== "owner") return { error: "只有主人可以访问此功能" };
  const payload = await readPayload(request);
  const intent = String(payload.intent ?? "");
  if (intent === "create") {
    const created = createTodoRecord(String(payload.content ?? ""), payload.todoDate ?? new Date().toISOString().slice(0, 10));
    return created ? { ok: true } : { error: "待办内容不能为空" };
  }
  const id = String(payload.id ?? "");
  if (intent === "toggle") {
    const updated = updateTodoRecord(id, { isCompleted: Boolean(payload.isCompleted) });
    return updated ? { ok: true } : { error: "待办不存在" };
  }
  if (intent === "delete") {
    deleteTodoRecord(id);
    return { ok: true };
  }
  return { error: "未知操作" };
}

export default function TodosRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submit = useSubmit();
  const error = actionData && "error" in actionData ? actionData.error : "";
  const busy = navigation.state !== "idle";

  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <Space orientation="vertical" size={0}>
        <Typography.Text type="secondary">TODAY</Typography.Text>
        <Typography.Title level={3} className="page-title">
          待办清单
        </Typography.Title>
      </Space>

      {(error || data.forbidden) && (
        <Alert
          type="error"
          showIcon
          title={error || "只有主人可以访问此功能"}
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={() => revalidator.revalidate()}>
              重试
            </Button>
          }
        />
      )}

      {!data.forbidden && (
        <Form
          layout="inline"
          className="quick-add"
          onFinish={(values: { content?: string }) => {
            const content = values.content?.trim();
            if (!content || busy) return;
            submit(
              { intent: "create", content, todoDate: new Date().toISOString().slice(0, 10) },
              { method: "post", encType: "application/json" },
            );
          }}
        >
          <Form.Item name="content" className="quick-add-item">
            <Input placeholder="添加一条今日待办" allowClear />
          </Form.Item>
          <Form.Item>
            <Button color="primary" variant="solid" htmlType="submit" icon={<PlusOutlined />} disabled={busy}>
              添加
            </Button>
          </Form.Item>
        </Form>
      )}

      {data.items.length ? (
        <Listy
          items={data.items}
          rowKey="id"
          itemRender={(item) => (
            <Space align="center" size="middle" className="list-row">
              <Checkbox
                checked={Boolean(item.isCompleted)}
                disabled={busy}
                onChange={(event) =>
                  submit(
                    { intent: "toggle", id: item.id, isCompleted: event.target.checked },
                    { method: "post", encType: "application/json" },
                  )
                }
              >
                <Typography.Text delete={Boolean(item.isCompleted)} {...(item.isCompleted ? { type: "secondary" as const } : {})}>
                  {item.content}
                </Typography.Text>
              </Checkbox>
              <Popconfirm
                title="确定删除吗？"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => submit({ intent: "delete", id: item.id }, { method: "post", encType: "application/json" })}
              >
                <Button color="danger" variant="text" icon={<DeleteOutlined />} aria-label="删除待办" />
              </Popconfirm>
            </Space>
          )}
        />
      ) : (
        !data.forbidden && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space orientation="vertical" size={2}>
                <Typography.Text strong>暂无待办</Typography.Text>
                <Typography.Text type="secondary">添加一条今天要完成的事情。</Typography.Text>
              </Space>
            }
          />
        )
      )}
    </Space>
  );
}

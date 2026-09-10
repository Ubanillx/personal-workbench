import type React from "react";
import { useActionData, useLoaderData, useNavigation, useRevalidator, useSubmit } from "react-router";
import { Alert, Button, Checkbox, Empty, Form, Input, Listy, Popconfirm, Space, Typography } from "antd";
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { readPayload } from "../lib/form.server";
import { createTodoRecord, deleteTodoRecord, listTodos, updateTodoRecord } from "../lib/todos.server";
import { requireUserOrRedirect } from "../lib/ui.server";

type TodoRow = { id: string; content: string; todoDate: string | null; isCompleted: number | boolean; completedAt: string | null };

/**
 * 待办按组织隔离（§14.2）：登录即可用（不再有「主人专属」这一档角色），
 * 未加入组织的账号由 requireUserOrRedirect 送回 /join（D-34），跨组织数据在域里就已经过滤掉。
 * `?org=` 是管理员（D-28）的筛选器接缝：既是列表过滤，也是管理员新增时的目标组织。
 */
export async function loader({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  // 组织筛选器只对管理员有意义（D-28），与 /tasks 页的写法一致
  const orgFilter = user.role === "admin" ? new URL(request.url).searchParams.get("org") : null;
  return { items: listTodos(user, orgFilter) as unknown as TodoRow[] };
}

export async function action({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  const payload = await readPayload(request);
  const intent = String(payload.intent ?? "");
  if (intent === "create") {
    // 组织归属由 app/lib/todos.server.ts 解析：成员/管理者写本组织；
    // 管理员是全局角色，目标组织先看表单字段，再看页面上的组织筛选器 ?org=（D-28 的接缝）
    const created = createTodoRecord(user, {
      content: payload.content,
      todoDate: payload.todoDate ?? new Date().toISOString().slice(0, 10),
      orgId: payload.orgId || new URL(request.url).searchParams.get("org"),
    });
    return created.ok ? { ok: true } : { error: created.message };
  }
  const id = String(payload.id ?? "");
  if (intent === "toggle") {
    const updated = updateTodoRecord(user, id, { isCompleted: Boolean(payload.isCompleted) });
    return updated.ok ? { ok: true } : { error: updated.message };
  }
  if (intent === "delete") {
    // 不存在与跨组织给出同一句提示（页面不泄露资源是否存在）
    const removed = deleteTodoRecord(user, id);
    return removed.ok ? { ok: true } : { error: removed.message };
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

      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={() => revalidator.revalidate()}>
              重试
            </Button>
          }
        />
      )}

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
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Space orientation="vertical" size={2}>
              <Typography.Text strong>暂无待办</Typography.Text>
              <Typography.Text type="secondary">添加一条今天要完成的事情。</Typography.Text>
            </Space>
          }
        />
      )}
    </Space>
  );
}

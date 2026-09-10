import type React from "react";
import { useActionData, useLoaderData, useNavigation, useRevalidator, useSubmit } from "react-router";
import { Alert, Button, Empty, Form, Input, Listy, Popconfirm, Space, Typography } from "antd";
import { DeleteOutlined, ReloadOutlined } from "@ant-design/icons";
import { readPayload } from "../lib/form.server";
import { createNoteRecord, deleteNoteRecord, listNotes } from "../lib/notes.server";
import { requireUserOrRedirect } from "../lib/ui.server";

type NoteRow = { id: string; content: string; isPinned: number | boolean; createdAt: string; updatedAt: string };

export async function loader({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  // 随手记是主人专属（与 API 的 requireOwner 一致）
  if (user.role !== "owner") return { items: [] as NoteRow[], forbidden: true };
  return { items: listNotes() as unknown as NoteRow[], forbidden: false };
}

export async function action({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  if (user.role !== "owner") return { error: "只有主人可以访问此功能" };
  const payload = await readPayload(request);
  const intent = String(payload.intent ?? "");
  if (intent === "create") {
    const created = createNoteRecord(payload.content);
    return created ? { ok: true } : { error: "笔记内容不能为空" };
  }
  if (intent === "delete") {
    deleteNoteRecord(String(payload.id ?? ""));
    return { ok: true };
  }
  return { error: "未知操作" };
}

export default function NotesRoute(): React.ReactElement {
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
        <Typography.Text type="secondary">CAPTURE</Typography.Text>
        <Typography.Title level={3} className="page-title">
          随手记
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
          className="page-stack"
          onFinish={(values: { content?: string }) => {
            const content = values.content?.trim();
            if (!content || busy) return;
            submit({ intent: "create", content }, { method: "post", encType: "application/json" });
          }}
        >
          <Form.Item name="content" className="quick-add-item">
            <Input.TextArea placeholder="记录想法、会议要点或临时事项" rows={3} allowClear />
          </Form.Item>
          <Form.Item>
            <Button color="primary" variant="solid" htmlType="submit" disabled={busy}>
              保存记录
            </Button>
          </Form.Item>
        </Form>
      )}

      {data.items.length ? (
        <Listy
          items={data.items}
          rowKey="id"
          itemRender={(item) => (
            <Space align="start" size="middle" className="list-row">
              <Typography.Paragraph style={{ margin: 0, flex: 1 }}>{item.content}</Typography.Paragraph>
              <Popconfirm
                title="确定删除吗？"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => submit({ intent: "delete", id: item.id }, { method: "post", encType: "application/json" })}
              >
                <Button color="danger" variant="text" icon={<DeleteOutlined />} aria-label="删除随手记" />
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
                <Typography.Text strong>暂无随手记</Typography.Text>
                <Typography.Text type="secondary">记录会议要点或临时想法。</Typography.Text>
              </Space>
            }
          />
        )
      )}
    </Space>
  );
}

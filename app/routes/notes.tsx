import type React from "react";
import { useActionData, useLoaderData, useNavigation, useRevalidator, useSubmit } from "react-router";
import { Alert, Button, Empty, Form, Input, Listy, Popconfirm, Space, Typography } from "antd";
import { DeleteOutlined, ReloadOutlined } from "@ant-design/icons";
import { readPayload } from "../lib/form.server";
import { createNoteRecord, deleteNoteRecord, listNotes } from "../lib/notes.server";
import { requireUserOrRedirect } from "../lib/ui.server";

type NoteRow = { id: string; content: string; isPinned: number | boolean; createdAt: string; updatedAt: string };

/**
 * 随手记按组织隔离（§14.2）：登录即可用（不再有「主人专属」这一档角色），
 * 未加入组织的账号由 requireUserOrRedirect 送回 /join（D-34），跨组织数据在域里就已经过滤掉。
 * `?org=` 是管理员（D-28）的筛选器接缝：既是列表过滤，也是管理员新增时的目标组织。
 */
export async function loader({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  // 组织筛选器只对管理员有意义（D-28），与 /tasks 页的写法一致
  const orgFilter = user.role === "admin" ? new URL(request.url).searchParams.get("org") : null;
  return { items: listNotes(user, orgFilter) as unknown as NoteRow[] };
}

export async function action({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  const payload = await readPayload(request);
  const intent = String(payload.intent ?? "");
  if (intent === "create") {
    // 组织归属由 app/lib/notes.server.ts 解析：成员/管理者写本组织；
    // 管理员是全局角色，目标组织先看表单字段，再看页面上的组织筛选器 ?org=（D-28 的接缝）
    const created = createNoteRecord(user, {
      content: payload.content,
      orgId: payload.orgId || new URL(request.url).searchParams.get("org"),
    });
    return created.ok ? { ok: true } : { error: created.message };
  }
  if (intent === "delete") {
    // 不存在与跨组织给出同一句提示（页面不泄露资源是否存在）
    const removed = deleteNoteRecord(user, String(payload.id ?? ""));
    return removed.ok ? { ok: true } : { error: removed.message };
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
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Space orientation="vertical" size={2}>
              <Typography.Text strong>暂无随手记</Typography.Text>
              <Typography.Text type="secondary">记录会议要点或临时想法。</Typography.Text>
            </Space>
          }
        />
      )}
    </Space>
  );
}

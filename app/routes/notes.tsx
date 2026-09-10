import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useActionData, useLoaderData, useNavigation, useRevalidator, useSubmit } from "react-router";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Empty,
  Flex,
  Form,
  Input,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  type TableProps,
} from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, PushpinFilled, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { confirmDanger, RowActions } from "../components/crud-actions";
import { useCrudFeedback, useListParams } from "../components/crud-hooks";
import { FormModal } from "../components/crud-modal";
import { SelectionAlert, TableToolbar } from "../components/crud-toolbar";
import { PageHeader } from "../components/page-header";
import { readPayload } from "../lib/form.server";
import { listOrganizations } from "../lib/organization.server";
import { createNoteRecord, deleteNoteRecord, listNotes, updateNoteRecord } from "../lib/notes.server";
import { requireUserOrRedirect } from "../lib/ui.server";

type NoteRow = {
  id: string;
  content: string;
  isPinned: number | boolean;
  createdAt: string;
  updatedAt: string;
};
type OrgOption = { id: string; name: string; status: string };
type ActionResult = { ok: true; notice: string } | { error: string };

const PIN_OPTIONS = [
  { value: "all", label: "全部记录" },
  { value: "pinned", label: "仅置顶" },
  { value: "normal", label: "非置顶" },
];

/**
 * 随手记按组织隔离（§14.2）：登录即可用（不再有「主人专属」这一档角色），
 * 未加入组织的账号由 requireUserOrRedirect 送回 /join（D-34），跨组织数据在域里就已经过滤掉。
 * `?org=` 是管理员（D-28）的筛选器接缝：既是列表过滤，也是管理员新增时的目标组织。
 */
export async function loader({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  // 组织筛选器只对管理员有意义（D-28），与 /tasks 页的写法一致
  const orgFilter = user.role === "admin" ? new URL(request.url).searchParams.get("org") : null;
  const organizations =
    user.role === "admin"
      ? listOrganizations(user).map((org) => ({ id: org.id, name: org.name, status: String(org.status) }) as OrgOption)
      : [];
  return { items: listNotes(user, orgFilter) as unknown as NoteRow[], organizations, orgFilter: orgFilter ?? "" };
}

/**
 * 随手记写操作：与 API `/api/notes*` 共用 app/lib/notes.server.ts 的同一份实现。
 * 页面此前只有「新建 / 删除」两个入口，编辑与置顶只能走 API；这里补齐 update + bulk-*，
 * 让页面的 CRUD 与接口能力一致（仍然逐条调用同一个服务函数，不新写 SQL）。
 */
export async function action({ request }: { request: Request }): Promise<ActionResult> {
  const user = requireUserOrRedirect(request);
  const payload = await readPayload(request);
  const intent = String(payload.intent ?? "");
  const id = String(payload.id ?? "");
  const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : [];

  if (intent === "create") {
    // 组织归属由 app/lib/notes.server.ts 解析：成员/管理者写本组织；
    // 管理员是全局角色，目标组织先看表单字段，再看页面上的组织筛选器 ?org=（D-28 的接缝）
    const created = createNoteRecord(user, {
      content: payload.content,
      orgId: payload.orgId || new URL(request.url).searchParams.get("org"),
    });
    return created.ok ? { ok: true, notice: "随手记已保存" } : { error: created.message };
  }
  if (intent === "update") {
    const updated = updateNoteRecord(user, id, { content: payload.content, isPinned: payload.isPinned });
    return updated.ok ? { ok: true, notice: "随手记已保存" } : { error: updated.message };
  }
  if (intent === "pin") {
    const updated = updateNoteRecord(user, id, { isPinned: Boolean(payload.isPinned) });
    return updated.ok ? { ok: true, notice: payload.isPinned ? "已置顶" : "已取消置顶" } : { error: updated.message };
  }
  if (intent === "delete") {
    // 不存在与跨组织给出同一句提示（页面不泄露资源是否存在）
    const removed = deleteNoteRecord(user, id);
    return removed.ok ? { ok: true, notice: "随手记已删除" } : { error: removed.message };
  }
  if (intent === "bulk-delete" || intent === "bulk-pin" || intent === "bulk-unpin") {
    if (!ids.length) return { error: "请先选择记录" };
    let succeeded = 0;
    const failures: string[] = [];
    for (const target of ids) {
      const result =
        intent === "bulk-delete" ? deleteNoteRecord(user, target) : updateNoteRecord(user, target, { isPinned: intent === "bulk-pin" });
      if (result.ok) succeeded += 1;
      else failures.push(result.message);
    }
    if (!succeeded) return { error: failures[0] ?? "没有可处理的记录" };
    const verb = intent === "bulk-delete" ? "删除" : intent === "bulk-pin" ? "置顶" : "取消置顶";
    return {
      ok: true,
      notice: `已${verb} ${succeeded} 条记录${failures.length ? `，${failures.length} 条被跳过` : ""}`,
    };
  }
  return { error: "未知操作" };
}

export default function NotesRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submit = useSubmit();
  const { modal } = AntdApp.useApp();
  const list = useListParams();
  const [createForm] = Form.useForm<{ content?: string; orgId?: string }>();
  const [editForm] = Form.useForm<{ content?: string; isPinned?: boolean }>();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<NoteRow | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const { error } = useCrudFeedback(actionData, () => {
    setCreateOpen(false);
    setEditing(null);
    setSelectedKeys([]);
  });
  const busy = navigation.state !== "idle";
  const isAdmin = data.organizations.length > 0;

  const keyword = list.get("q");
  const pin = list.get("pin", "all");
  const orgFilter = list.get("org");
  const [draftKeyword, setDraftKeyword] = useState(keyword);
  useEffect(() => setDraftKeyword(keyword), [keyword]);

  const rows = useMemo(
    () =>
      data.items
        .filter((item) => {
          if (keyword && !item.content.includes(keyword)) return false;
          if (pin === "pinned" && !item.isPinned) return false;
          if (pin === "normal" && item.isPinned) return false;
          return true;
        })
        // 置顶优先，其次按最近更新：与随手记的使用习惯一致
        .toSorted((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updatedAt.localeCompare(a.updatedAt)),
    [data.items, keyword, pin],
  );

  const post = (payload: Record<string, unknown>): void => {
    submit(payload as Parameters<typeof submit>[0], { method: "post", encType: "application/json" });
  };
  const filtered = Boolean(keyword || pin !== "all" || orgFilter);

  const columns: TableProps<NoteRow>["columns"] = [
    {
      title: "置顶",
      dataIndex: "isPinned",
      key: "isPinned",
      width: 84,
      align: "center",
      render: (_value, row) => (
        <Switch
          size="small"
          checked={Boolean(row.isPinned)}
          disabled={busy}
          aria-label={row.isPinned ? "取消置顶" : "置顶"}
          onChange={(checked) => post({ intent: "pin", id: row.id, isPinned: checked })}
        />
      ),
    },
    {
      title: "记录内容",
      dataIndex: "content",
      key: "content",
      render: (_value, row) => (
        <Space size={4} align="start">
          {row.isPinned ? <PushpinFilled style={{ color: "#faad14", marginTop: 4 }} /> : null}
          <Tooltip title={row.content.length > 80 ? row.content : ""} placement="topLeft">
            <Typography.Paragraph style={{ margin: 0 }} ellipsis={{ rows: 2, expandable: false }}>
              {row.content}
            </Typography.Paragraph>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: "状态",
      key: "state",
      width: 100,
      filters: [
        { text: "已置顶", value: "pinned" },
        { text: "普通", value: "normal" },
      ],
      onFilter: (value, row) => (value === "pinned" ? Boolean(row.isPinned) : !row.isPinned),
      render: (_value, row) => (
        <Tag color={row.isPinned ? "gold" : "default"} variant="filled">
          {row.isPinned ? "已置顶" : "普通"}
        </Tag>
      ),
    },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      key: "updatedAt",
      width: 170,
      sorter: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
      defaultSortOrder: "descend",
      render: (_value, row) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text>{dayjs(row.updatedAt).format("YYYY-MM-DD HH:mm")}</Typography.Text>
          <Typography.Text type="secondary">创建于 {dayjs(row.createdAt).format("MM-DD HH:mm")}</Typography.Text>
        </Space>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 120,
      align: "right",
      render: (_value, row) => (
        <RowActions
          extra={
            <Button size="small" color="default" variant="text" icon={<EditOutlined />} onClick={() => setEditing(row)}>
              编辑
            </Button>
          }
          items={[
            {
              key: "pin",
              label: row.isPinned ? "取消置顶" : "置顶",
              onClick: () => post({ intent: "pin", id: row.id, isPinned: !row.isPinned }),
            },
            { type: "divider" },
            {
              key: "delete",
              label: "删除",
              danger: true,
              icon: <DeleteOutlined />,
              onClick: () =>
                confirmDanger(modal, {
                  title: "删除这条随手记？",
                  content: "删除后无法恢复。",
                  okText: "删除",
                  onOk: () => post({ intent: "delete", id: row.id }),
                }),
            },
          ]}
        />
      ),
    },
  ];

  return (
    <Flex vertical gap="large" className="page-stack">
      <PageHeader
        title="随手记"
        description="记录想法与要点，重要内容可置顶。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => revalidator.revalidate()} loading={busy}>
              刷新
            </Button>
            <Button color="primary" variant="solid" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建记录
            </Button>
          </>
        }
      />

      {error ? <Alert type="error" showIcon title={error} /> : null}

      <Card variant="outlined">
        <Flex vertical gap="middle">
          <TableToolbar
            extra={
              <Typography.Text type="secondary">
                共 {rows.length} 条{filtered ? `（总计 ${data.items.length} 条）` : ""}
              </Typography.Text>
            }
          >
            <Input.Search
              allowClear
              placeholder="搜索记录内容"
              style={{ width: 260 }}
              value={draftKeyword}
              loading={busy}
              onChange={(event) => setDraftKeyword(event.target.value)}
              onSearch={(value) => list.patch({ q: value.trim() })}
            />
            <Select
              value={pin}
              options={PIN_OPTIONS}
              style={{ width: 140 }}
              onChange={(value: string) => list.patch({ pin: value === "all" ? null : value })}
            />
            {isAdmin ? (
              <Select
                value={orgFilter || "all"}
                style={{ width: 180 }}
                options={[{ value: "all", label: "全部组织" }, ...data.organizations.map((org) => ({ value: org.id, label: org.name }))]}
                onChange={(value: string) => list.patch({ org: value === "all" ? null : value })}
              />
            ) : null}
            {filtered ? (
              <Button color="default" variant="text" onClick={() => list.reset()}>
                重置
              </Button>
            ) : null}
          </TableToolbar>

          <SelectionAlert count={selectedKeys.length} noun="条记录" onClear={() => setSelectedKeys([])}>
            <Button size="small" onClick={() => post({ intent: "bulk-pin", ids: selectedKeys })}>
              批量置顶
            </Button>
            <Button size="small" onClick={() => post({ intent: "bulk-unpin", ids: selectedKeys })}>
              取消置顶
            </Button>
            <Button
              size="small"
              color="danger"
              variant="outlined"
              onClick={() =>
                confirmDanger(modal, {
                  title: `删除选中的 ${selectedKeys.length} 条记录？`,
                  content: "删除后无法恢复。",
                  okText: "批量删除",
                  onOk: () => post({ intent: "bulk-delete", ids: selectedKeys }),
                })
              }
            >
              批量删除
            </Button>
          </SelectionAlert>

          <Table<NoteRow>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={rows}
            loading={busy}
            scroll={{ x: 880 }}
            rowSelection={{
              selectedRowKeys: selectedKeys,
              preserveSelectedRowKeys: true,
              onChange: (keys) => setSelectedKeys(keys),
            }}
            pagination={{
              pageSize: 10,
              showSizeChanger: true,
              showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 条`,
            }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    <Space orientation="vertical" size={2}>
                      <Typography.Text strong>{filtered ? "没有符合条件的记录" : "暂无随手记"}</Typography.Text>
                      <Typography.Text type="secondary">
                        {filtered ? "调整筛选条件，或重置后查看全部。" : "点击右上角「新建记录」写下第一条内容。"}
                      </Typography.Text>
                    </Space>
                  }
                >
                  {filtered ? <Button onClick={() => list.reset()}>重置筛选</Button> : null}
                </Empty>
              ),
            }}
          />
        </Flex>
      </Card>

      <FormModal
        open={createOpen}
        title="新建随手记"
        okText="保存"
        form={createForm}
        submitting={busy}
        error={error}
        initialValues={{ orgId: orgFilter || data.organizations.at(0)?.id || "" }}
        onCancel={() => setCreateOpen(false)}
        onFinish={(values) => {
          const content = values.content?.trim();
          if (!content) return;
          post({ intent: "create", content, ...(isAdmin ? { orgId: values.orgId ?? "" } : {}) });
        }}
      >
        <Form.Item name="content" label="记录内容" rules={[{ required: true, message: "请输入记录内容" }]}>
          <Input.TextArea
            rows={6}
            maxLength={2000}
            showCount
            placeholder="会议要点、客户反馈、临时想法…"
            autoSize={{ minRows: 5, maxRows: 10 }}
          />
        </Form.Item>
        {isAdmin ? (
          <Form.Item name="orgId" label="所属组织" rules={[{ required: true, message: "请选择记录所属组织" }]}>
            <Select
              placeholder="请选择所属组织"
              options={data.organizations.filter((org) => org.status === "active").map((org) => ({ value: org.id, label: org.name }))}
            />
          </Form.Item>
        ) : null}
      </FormModal>

      <FormModal
        open={editing !== null}
        title="编辑随手记"
        form={editForm}
        submitting={busy}
        error={error}
        formKey={editing?.id ?? "none"}
        initialValues={{ content: editing?.content ?? "", isPinned: Boolean(editing?.isPinned) }}
        onCancel={() => setEditing(null)}
        onFinish={(values) => {
          if (!editing) return;
          const content = values.content?.trim();
          if (!content) return;
          post({ intent: "update", id: editing.id, content, isPinned: Boolean(values.isPinned) });
        }}
      >
        <Form.Item name="content" label="记录内容" rules={[{ required: true, message: "请输入记录内容" }]}>
          <Input.TextArea rows={8} maxLength={2000} showCount autoSize={{ minRows: 6, maxRows: 12 }} />
        </Form.Item>
        <Form.Item name="isPinned" label="置顶" valuePropName="checked" tooltip="置顶记录在列表最前，便于随时查看">
          <Switch checkedChildren="已置顶" unCheckedChildren="普通" />
        </Form.Item>
      </FormModal>
    </Flex>
  );
}

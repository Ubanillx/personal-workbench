import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useActionData, useLoaderData, useNavigation, useRevalidator, useSubmit } from "react-router";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Empty,
  Flex,
  Form,
  Input,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  type TableProps,
} from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { confirmDanger, RowActions } from "../components/crud-actions";
import { useCrudFeedback, useListParams } from "../components/crud-hooks";
import { FormModal } from "../components/crud-modal";
import { SelectionAlert, TableToolbar } from "../components/crud-toolbar";
import { PageHeader } from "../components/page-header";
import { readPayload } from "../lib/form.server";
import { listOrganizations } from "../lib/organization.server";
import { createTodoRecord, deleteTodoRecord, listTodos, updateTodoRecord } from "../lib/todos.server";
import { requireUserOrRedirect } from "../lib/ui.server";

type TodoRow = {
  id: string;
  content: string;
  todoDate: string | null;
  isCompleted: number | boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
type OrgOption = { id: string; name: string; status: string };
type ActionResult = { ok: true; notice: string } | { error: string };

const STATUS_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "open", label: "未完成" },
  { value: "done", label: "已完成" },
];
const DATE_OPTIONS = [
  { value: "all", label: "全部日期" },
  { value: "today", label: "今天" },
  { value: "overdue", label: "已逾期" },
];

/**
 * 待办按组织隔离（§14.2）：登录即可用（不再有「主人专属」这一档角色），
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
  return { items: listTodos(user, orgFilter) as unknown as TodoRow[], organizations, orgFilter: orgFilter ?? "" };
}

/**
 * 待办写操作：与 API `/api/todos*` 共用 app/lib/todos.server.ts 的同一份实现。
 * 单条动作（create/update/toggle/delete）之外补了批量动作（bulk-*）：中后台列表的批量语义，
 * 逐条调用同一个服务函数，成功计数、失败原因汇总后再反馈，绝不绕过域里的组织与权限校验。
 */
export async function action({ request }: { request: Request }): Promise<ActionResult> {
  const user = requireUserOrRedirect(request);
  const payload = await readPayload(request);
  const intent = String(payload.intent ?? "");
  const id = String(payload.id ?? "");
  const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : [];
  const orgFromUrl = new URL(request.url).searchParams.get("org");

  if (intent === "create") {
    // 组织归属由 app/lib/todos.server.ts 解析：成员/管理者写本组织；
    // 管理员是全局角色，目标组织先看表单字段，再看页面上的组织筛选器 ?org=（D-28 的接缝）
    const created = createTodoRecord(user, {
      content: payload.content,
      todoDate: payload.todoDate ?? new Date().toISOString().slice(0, 10),
      orgId: payload.orgId || orgFromUrl,
    });
    return created.ok ? { ok: true, notice: "待办已创建" } : { error: created.message };
  }
  if (intent === "update") {
    const updated = updateTodoRecord(user, id, {
      content: payload.content,
      todoDate: payload.todoDate,
      isCompleted: payload.isCompleted,
    });
    return updated.ok ? { ok: true, notice: "待办已保存" } : { error: updated.message };
  }
  if (intent === "toggle") {
    const updated = updateTodoRecord(user, id, { isCompleted: Boolean(payload.isCompleted) });
    return updated.ok ? { ok: true, notice: payload.isCompleted ? "已标记完成" : "已恢复为未完成" } : { error: updated.message };
  }
  if (intent === "delete") {
    // 不存在与跨组织给出同一句提示（页面不泄露资源是否存在）
    const removed = deleteTodoRecord(user, id);
    return removed.ok ? { ok: true, notice: "待办已删除" } : { error: removed.message };
  }
  if (intent === "bulk-delete" || intent === "bulk-complete" || intent === "bulk-reopen") {
    if (!ids.length) return { error: "请先选择待办" };
    let succeeded = 0;
    const failures: string[] = [];
    for (const target of ids) {
      const result =
        intent === "bulk-delete"
          ? deleteTodoRecord(user, target)
          : updateTodoRecord(user, target, { isCompleted: intent === "bulk-complete" });
      if (result.ok) succeeded += 1;
      else failures.push(result.message);
    }
    if (!succeeded) return { error: failures[0] ?? "没有可处理的待办" };
    const verb = intent === "bulk-delete" ? "删除" : intent === "bulk-complete" ? "标记完成" : "恢复为未完成";
    return {
      ok: true,
      notice: `已${verb} ${succeeded} 条待办${failures.length ? `，${failures.length} 条被跳过` : ""}`,
    };
  }
  return { error: "未知操作" };
}

export default function TodosRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submit = useSubmit();
  const { modal } = AntdApp.useApp();
  const list = useListParams();
  const [createForm] = Form.useForm<{ content?: string; todoDate?: dayjs.Dayjs | null; orgId?: string }>();
  const [editForm] = Form.useForm<{ content?: string; todoDate?: dayjs.Dayjs | null; isCompleted?: boolean }>();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<TodoRow | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  // 成功即关闭弹窗并清空选择：反馈与状态收口在一个地方，页面不再各自处理
  const { error } = useCrudFeedback(actionData, () => {
    setCreateOpen(false);
    setEditing(null);
    setSelectedKeys([]);
  });
  const busy = navigation.state !== "idle";
  const isAdmin = data.organizations.length > 0;

  const keyword = list.get("q");
  const status = list.get("status", "all");
  const dateFilter = list.get("date", "all");
  const orgFilter = list.get("org");
  const [draftKeyword, setDraftKeyword] = useState(keyword);
  // URL 是筛选条件的唯一来源：浏览器前进/后退时输入框跟着回到一致状态
  useEffect(() => setDraftKeyword(keyword), [keyword]);

  const today = dayjs().format("YYYY-MM-DD");
  const rows = useMemo(
    () =>
      data.items.filter((item) => {
        if (keyword && !item.content.includes(keyword)) return false;
        const done = Boolean(item.isCompleted);
        if (status === "open" && done) return false;
        if (status === "done" && !done) return false;
        if (dateFilter === "today" && item.todoDate !== today) return false;
        if (dateFilter === "overdue" && (done || !item.todoDate || item.todoDate >= today)) return false;
        return true;
      }),
    [data.items, keyword, status, dateFilter, today],
  );

  const post = (payload: Record<string, unknown>): void => {
    submit(payload as Parameters<typeof submit>[0], { method: "post", encType: "application/json" });
  };
  const toggle = (row: TodoRow, isCompleted: boolean): void => post({ intent: "toggle", id: row.id, isCompleted });

  const filtered = Boolean(keyword || status !== "all" || dateFilter !== "all" || orgFilter);

  const columns: TableProps<TodoRow>["columns"] = [
    {
      title: "完成",
      dataIndex: "isCompleted",
      key: "isCompleted",
      width: 76,
      align: "center",
      render: (_value, row) => (
        <Switch
          size="small"
          checked={Boolean(row.isCompleted)}
          disabled={busy}
          aria-label={row.isCompleted ? "恢复为未完成" : "标记为已完成"}
          onChange={(checked) => toggle(row, checked)}
        />
      ),
    },
    {
      title: "待办内容",
      dataIndex: "content",
      key: "content",
      sorter: (a, b) => a.content.localeCompare(b.content, "zh-Hans-CN"),
      render: (_value, row) => (
        <Typography.Text delete={Boolean(row.isCompleted)} {...(row.isCompleted ? { type: "secondary" as const } : {})}>
          {row.content}
        </Typography.Text>
      ),
    },
    {
      title: "计划日期",
      dataIndex: "todoDate",
      key: "todoDate",
      width: 150,
      sorter: (a, b) => String(a.todoDate ?? "").localeCompare(String(b.todoDate ?? "")),
      render: (_value, row) => {
        if (!row.todoDate) return <Typography.Text type="secondary">未设置</Typography.Text>;
        const overdue = !row.isCompleted && row.todoDate < today;
        return (
          <Space size={4}>
            <Typography.Text {...(overdue ? { type: "danger" as const } : {})}>{row.todoDate}</Typography.Text>
            {overdue ? (
              <Tag color="red" variant="filled">
                逾期
              </Tag>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: "状态",
      dataIndex: "isCompleted",
      key: "status",
      width: 110,
      filters: [
        { text: "未完成", value: "open" },
        { text: "已完成", value: "done" },
      ],
      onFilter: (value, row) => (value === "done" ? Boolean(row.isCompleted) : !row.isCompleted),
      render: (_value, row) => (
        <Tag color={row.isCompleted ? "green" : "blue"} variant="filled">
          {row.isCompleted ? "已完成" : "待处理"}
        </Tag>
      ),
    },
    {
      title: "最近更新",
      dataIndex: "updatedAt",
      key: "updatedAt",
      width: 170,
      sorter: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
      render: (_value, row) => <Typography.Text type="secondary">{dayjs(row.updatedAt).format("MM-DD HH:mm")}</Typography.Text>,
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
              key: "toggle",
              label: row.isCompleted ? "恢复为未完成" : "标记完成",
              onClick: () => toggle(row, !row.isCompleted),
            },
            { type: "divider" },
            {
              key: "delete",
              label: "删除",
              danger: true,
              icon: <DeleteOutlined />,
              onClick: () =>
                confirmDanger(modal, {
                  title: "删除这条待办？",
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
        title="待办清单"
        description="安排日常事项，及时处理待办。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => revalidator.revalidate()} loading={busy}>
              刷新
            </Button>
            <Button color="primary" variant="solid" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建待办
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
              placeholder="搜索待办内容"
              style={{ width: 260 }}
              value={draftKeyword}
              loading={busy}
              onChange={(event) => setDraftKeyword(event.target.value)}
              onSearch={(value) => list.patch({ q: value.trim() })}
            />
            <Select
              value={status}
              options={STATUS_OPTIONS}
              style={{ width: 130 }}
              onChange={(value: string) => list.patch({ status: value === "all" ? null : value })}
            />
            <Select
              value={dateFilter}
              options={DATE_OPTIONS}
              style={{ width: 130 }}
              onChange={(value: string) => list.patch({ date: value === "all" ? null : value })}
            />
            {isAdmin ? (
              <Select
                value={orgFilter || "all"}
                style={{ width: 180 }}
                placeholder="全部组织"
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

          <SelectionAlert count={selectedKeys.length} noun="条待办" onClear={() => setSelectedKeys([])}>
            <Button size="small" onClick={() => post({ intent: "bulk-complete", ids: selectedKeys })}>
              标记完成
            </Button>
            <Button size="small" onClick={() => post({ intent: "bulk-reopen", ids: selectedKeys })}>
              恢复未完成
            </Button>
            <Button
              size="small"
              color="danger"
              variant="outlined"
              onClick={() =>
                confirmDanger(modal, {
                  title: `删除选中的 ${selectedKeys.length} 条待办？`,
                  content: "删除后无法恢复。",
                  okText: "批量删除",
                  onOk: () => post({ intent: "bulk-delete", ids: selectedKeys }),
                })
              }
            >
              批量删除
            </Button>
          </SelectionAlert>

          <Table<TodoRow>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={rows}
            loading={busy}
            scroll={{ x: 900 }}
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
                      <Typography.Text strong>{filtered ? "没有符合条件的待办" : "暂无待办"}</Typography.Text>
                      <Typography.Text type="secondary">
                        {filtered ? "调整筛选条件，或重置后查看全部。" : "点击右上角「新建待办」添加今天要做的事情。"}
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
        title="新建待办"
        okText="创建"
        form={createForm}
        submitting={busy}
        error={error}
        initialValues={{ todoDate: dayjs(), orgId: orgFilter || data.organizations.at(0)?.id || "" }}
        onCancel={() => setCreateOpen(false)}
        onFinish={(values) => {
          const content = values.content?.trim();
          if (!content) return;
          post({
            intent: "create",
            content,
            todoDate: values.todoDate ? values.todoDate.format("YYYY-MM-DD") : today,
            ...(isAdmin ? { orgId: values.orgId ?? "" } : {}),
          });
        }}
      >
        <Form.Item name="content" label="待办内容" rules={[{ required: true, message: "请输入待办内容" }]}>
          <Input.TextArea rows={3} maxLength={200} showCount placeholder="例如：跟进报价单回签" />
        </Form.Item>
        <Form.Item name="todoDate" label="计划日期">
          <DatePicker format="YYYY-MM-DD" style={{ width: "100%" }} placeholder="默认今天" />
        </Form.Item>
        {isAdmin ? (
          <Form.Item name="orgId" label="所属组织" rules={[{ required: true, message: "请选择待办所属组织" }]}>
            <Select
              placeholder="请选择所属组织"
              options={data.organizations.filter((org) => org.status === "active").map((org) => ({ value: org.id, label: org.name }))}
            />
          </Form.Item>
        ) : null}
      </FormModal>

      <FormModal
        open={editing !== null}
        title="编辑待办"
        form={editForm}
        submitting={busy}
        error={error}
        formKey={editing?.id ?? "none"}
        initialValues={{
          content: editing?.content ?? "",
          todoDate: editing?.todoDate ? dayjs(editing.todoDate) : null,
          isCompleted: Boolean(editing?.isCompleted),
        }}
        onCancel={() => setEditing(null)}
        onFinish={(values) => {
          if (!editing) return;
          const content = values.content?.trim();
          if (!content) return;
          post({
            intent: "update",
            id: editing.id,
            content,
            todoDate: values.todoDate ? values.todoDate.format("YYYY-MM-DD") : null,
            isCompleted: Boolean(values.isCompleted),
          });
        }}
      >
        <Form.Item name="content" label="待办内容" rules={[{ required: true, message: "请输入待办内容" }]}>
          <Input.TextArea rows={3} maxLength={200} showCount />
        </Form.Item>
        <Form.Item name="todoDate" label="计划日期">
          <DatePicker format="YYYY-MM-DD" style={{ width: "100%" }} placeholder="未设置" allowClear />
        </Form.Item>
        <Form.Item name="isCompleted" label="完成状态" valuePropName="checked">
          <Switch checkedChildren="已完成" unCheckedChildren="未完成" />
        </Form.Item>
      </FormModal>
    </Flex>
  );
}

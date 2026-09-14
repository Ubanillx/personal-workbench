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
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  type TableProps,
} from "antd";
import { CheckOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, UndoOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { confirmDanger, RowActions } from "../components/crud-actions";
import { useCrudFeedback, useListParams, useServerTable } from "../components/crud-hooks";
import { FormDrawer } from "../components/crud-drawer";
import { SelectionAlert, TableToolbar } from "../components/crud-toolbar";
import { PageHeader } from "../components/page-header";
import { dataTable } from "../components/table-layout";
import { readPayload } from "../lib/form.server";
import { listOrganizations } from "../lib/organization.server";
import { pagingOf, sortOf, type Paged } from "../lib/paging";
import { sortableKeys } from "../lib/paging.server";
import {
  createTodoRecord,
  DEFAULT_TODO_SORT,
  deleteTodoRecord,
  TODO_SORTABLE,
  todosPage,
  updateTodoRecord,
  type TodoFilters,
} from "../lib/todos.server";
import { requireUserOrRedirect } from "../lib/ui.server";

type TodoRow = {
  id: string;
  content: string;
  todoDate: string | null;
  isCompleted: number | boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * 所属组织：服务端读模型里有这一列（`records.server.ts` 的 `TODO_SELECT`），API 载荷里不带
   * （契约冻结），页面用它渲染管理员的「所属组织」列——表单里的「所属组织」字段必须在列表里看得见。
   * 注意它**不是**可见性字段：待办自 D-54 起是本人数据（`owner_id = 本人`），
   * 组织只决定「这条待办写在哪个组织下」。
   */
  orgId: string | null;
};
type OrgOption = { id: string; name: string; status: string };
type ActionResult = { ok: true; notice: string } | { error: string };

const STATUS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "open", label: "未完成" },
  { value: "done", label: "已完成" },
];

/**
 * 编辑表单里的「状态」选项：只保留两个真实状态，不含筛选器里的「全部」。
 * 表单里**不用 Switch**——开关语义是「立刻切换」，而这里是在编辑一条记录的状态，
 * 与其它编辑表单（如任务的优先级、随手记的置顶状态）一致，用 `Select` 选。
 */
const TODO_STATE_OPTIONS = [
  { value: "open", label: "未完成" },
  { value: "done", label: "已完成" },
];
const DATE_OPTIONS = [
  { value: "all", label: "全部日期" },
  { value: "today", label: "今天" },
  { value: "overdue", label: "已逾期" },
];

/**
 * 待办是**本人数据**（D-54）：列表、新增、编辑、删除全部只作用于当前账号自己的待办，
 * 管理员也一样（他通过组织筛选器看的是「自己在那个组织下的待办」，而不是别人的）。
 * 未加入组织的账号由 requireUserOrRedirect 送回 /join（D-34）。
 * `?org=` 是管理员（D-28）的筛选器接缝：既是列表过滤，也是管理员新增时的目标组织。
 */
export async function loader({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  const url = new URL(request.url);
  // 组织筛选器只对管理员有意义（D-28），与 /tasks 页的写法一致
  const orgFilter = user.role === "admin" ? url.searchParams.get("org") : null;
  const organizations =
    user.role === "admin"
      ? listOrganizations(user).map((org) => ({ id: org.id, name: org.name, status: String(org.status) }) as OrgOption)
      : [];
  // 服务端当天：`?date=today|overdue` 的 SQL 条件与页面上的「逾期」标记共用同一个日期
  const today = dayjs().format("YYYY-MM-DD");
  const filters: TodoFilters = {
    orgFilter,
    keyword: url.searchParams.get("q") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    date: url.searchParams.get("date") ?? undefined,
    today,
  };
  // 筛选、排序、分页都在服务端（口径见 app/lib/paging.ts）：URL 是唯一真相，loader 只回一页
  const paging = pagingOf(url.searchParams);
  const sort = sortOf(url.searchParams, sortableKeys(TODO_SORTABLE), DEFAULT_TODO_SORT);
  return {
    items: todosPage(user, filters, paging, sort) as unknown as Paged<TodoRow>,
    organizations,
    orgFilter: orgFilter ?? "",
    today,
  };
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
  const [editForm] = Form.useForm<{ content?: string; todoDate?: dayjs.Dayjs | null; state?: string }>();
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

  const today = data.today;
  // 关键词 / 完成状态 / 计划日期都在服务端过滤（原来这里是浏览器 filter，服务端分页后会被切页吃掉）
  const rows = data.items.rows;
  const paging = useServerTable<TodoRow>(data.items);
  /**
   * 勾选只作用于**当前这一页**（见 /tasks 的同名处理）：列表参数一变就清空，
   * 否则「批量删除选中的 5 条」里会混进看不见的行。
   */
  const listSignature = ["q", "status", "date", "org", "page", "size", "sort", "order"].map((key) => list.get(key)).join("|");
  useEffect(() => setSelectedKeys([]), [listSignature]);

  const post = (payload: Record<string, unknown>): void => {
    submit(payload as Parameters<typeof submit>[0], { method: "post", encType: "application/json" });
  };
  const toggle = (row: TodoRow, isCompleted: boolean): void => post({ intent: "toggle", id: row.id, isCompleted });

  const filtered = Boolean(keyword || status !== "all" || dateFilter !== "all" || orgFilter);

  // 列表里不再放「完成」开关列：切换完成状态由右侧「操作」列的按钮负责（还有批量操作），
  // 同一个动作在表格里出现两次既重复又容易误点；「状态」列只做只读展示。
  const columns: TableProps<TodoRow>["columns"] = [
    {
      title: "待办内容",
      dataIndex: "content",
      key: "content",
      // 表头排序由服务端做（客户端比较器只能排当前这一页）：`sorter: true` 只画箭头，状态受控于 URL
      sorter: true,
      sortOrder: paging.sortOrderOf("content"),
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
      sorter: true,
      sortOrder: paging.sortOrderOf("todoDate"),
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
      // 列上的筛选下拉已删除：完成状态由工具栏的 Segmented 负责（同一个字段只留一套说法，
      // 且列筛选只作用于当前页；服务端分页下它必然给出错误结果）
      render: (_value, row) => (
        <Tag color={row.isCompleted ? "green" : "blue"} variant="filled">
          {/* 状态词与筛选器、编辑表单逐字一致（D-46 的用词约定：同一个字段只有一套说法） */}
          {row.isCompleted ? "已完成" : "未完成"}
        </Tag>
      ),
    },
    {
      title: "最近更新",
      dataIndex: "updatedAt",
      key: "updatedAt",
      width: 170,
      sorter: true,
      sortOrder: paging.sortOrderOf("updatedAt"),
      render: (_value, row) => <Typography.Text type="secondary">{dayjs(row.updatedAt).format("MM-DD HH:mm")}</Typography.Text>,
    },
    // 「所属组织」列只对管理员渲染：新建表单里就有这个字段（管理员必须选），列表里也就必须看得见（D-47）
    ...(isAdmin
      ? ([
          {
            title: "所属组织",
            key: "orgName",
            width: 140,
            render: (_value: unknown, row: TodoRow) => {
              const name = data.organizations.find((org) => org.id === row.orgId)?.name;
              return name ? <Tag color="blue">{name}</Tag> : <Typography.Text type="secondary">—</Typography.Text>;
            },
          },
        ] satisfies TableProps<TodoRow>["columns"])
      : []),
    {
      title: "操作",
      key: "actions",
      // 三个图标动作按钮（编辑 / 标记完成 / 删除），每个约 36px
      width: 140,
      align: "right",
      ellipsis: false,
      render: (_value, row) => (
        <RowActions
          actions={[
            {
              key: "edit",
              label: "编辑",
              icon: <EditOutlined />,
              onClick: () => setEditing(row),
            },
            {
              key: "toggle",
              label: row.isCompleted ? "恢复为未完成" : "标记完成",
              icon: row.isCompleted ? <UndoOutlined /> : <CheckOutlined />,
              onClick: () => toggle(row, !row.isCompleted),
            },
            {
              key: "delete",
              label: "删除",
              icon: <DeleteOutlined />,
              tone: "danger",
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

  // 表格排版方案（自动省略 + 定宽排版）：本页始终带勾选列，总宽要把勾选列算进去
  const table = useMemo(() => dataTable<TodoRow>({ columns, selectable: true }), [columns]);

  return (
    <Flex vertical gap="large" className="page-stack">
      <PageHeader
        title="待办清单"
        eyebrow="TODOS"
        description="按计划日期安排日常事项。"
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
                共 {data.items.total} 条{filtered ? "（已筛选）" : ""}
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
            <Segmented
              value={status}
              options={STATUS_OPTIONS}
              aria-label="按完成状态筛选"
              onChange={(value) => list.patch({ status: value === "all" ? null : String(value) })}
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
            {...table}
            rowKey="id"
            size="middle"
            dataSource={rows}
            loading={busy}
            rowSelection={{
              selectedRowKeys: selectedKeys,
              onChange: (keys) => setSelectedKeys(keys),
            }}
            pagination={paging.pagination}
            onChange={paging.onTableChange}
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

      <FormDrawer
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
      </FormDrawer>

      <FormDrawer
        open={editing !== null}
        title="编辑待办"
        form={editForm}
        submitting={busy}
        error={error}
        formKey={editing?.id ?? "none"}
        initialValues={{
          content: editing?.content ?? "",
          todoDate: editing?.todoDate ? dayjs(editing.todoDate) : null,
          state: editing?.isCompleted ? "done" : "open",
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
            isCompleted: values.state === "done",
          });
        }}
      >
        <Form.Item name="content" label="待办内容" rules={[{ required: true, message: "请输入待办内容" }]}>
          <Input.TextArea rows={3} maxLength={200} showCount />
        </Form.Item>
        <Form.Item name="todoDate" label="计划日期">
          <DatePicker format="YYYY-MM-DD" style={{ width: "100%" }} placeholder="未设置" allowClear />
        </Form.Item>
        <Form.Item name="state" label="状态">
          <Select options={TODO_STATE_OPTIONS} />
        </Form.Item>
      </FormDrawer>
    </Flex>
  );
}

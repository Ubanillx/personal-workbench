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
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  type TableProps,
} from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, PushpinFilled, PushpinOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { confirmDanger, RowActions } from "../components/crud-actions";
import { useCrudFeedback, useListParams, useServerTable } from "../components/crud-hooks";
import { FormDrawer } from "../components/crud-drawer";
import { SelectionAlert, TableToolbar } from "../components/crud-toolbar";
import { PageHeader } from "../components/page-header";
import { dataTable } from "../components/table-layout";
import { readPayload } from "../lib/form.server";
import {
  createNoteRecord,
  DEFAULT_NOTE_SORT,
  deleteNoteRecord,
  NOTE_SORTABLE,
  notesPage,
  updateNoteRecord,
  type NoteFilters,
} from "../lib/notes.server";
import { listOrganizations } from "../lib/organization.server";
import { pagingOf, sortOf, type Paged } from "../lib/paging";
import { sortableKeys } from "../lib/paging.server";
import { requireUserOrRedirect } from "../lib/ui.server";

type NoteRow = {
  id: string;
  content: string;
  isPinned: number | boolean;
  createdAt: string;
  updatedAt: string;
  /**
   * 所属组织：服务端读模型里有（`records.server.ts` 的 `NOTE_SELECT`），API 载荷不带（契约冻结），
   * 页面用它渲染管理员列。注意它**不是**可见性字段：随手记自 D-54 起是本人数据
   * （`owner_id = 本人`），组织只决定「这条记录写在哪个组织下」。
   */
  orgId: string | null;
};
type OrgOption = { id: string; name: string; status: string };
type ActionResult = { ok: true; notice: string } | { error: string };

/**
 * 随手记的「灵感等级」用词约定（D-46）：
 * - **状态词**（字段名 / 列头 / Tag / 筛选器）用「灵感等级：重点 / 普通」；
 * - **动作词**（右侧操作按钮 / 批量按钮 / 成功提示）仍用「置顶 / 取消置顶」——
 *   它描述的是「排到列表最前」这个效果，是中文后台里更好懂的动词。
 * 两套词各管一头，但都是同一件事：`notes.is_pinned`。
 */
const PIN_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "pinned", label: "仅重点" },
  { value: "normal", label: "普通" },
];

/**
 * 编辑表单里的「灵感等级」选项：只保留两个真实等级，不含筛选器里的「全部」。
 * 表单里**不用 Switch**——开关语义是「立刻切换」，而这里是在编辑一条记录的等级，
 * 与其它编辑表单（如任务的优先级）一致，用 `Select` 选。
 * 取值仍用 `pinned` / `normal`，与数据列 `is_pinned` 一一对应，便于对照。
 */
const PIN_FORM_OPTIONS = [
  { value: "pinned", label: "重点" },
  { value: "normal", label: "普通" },
];

/**
 * 随手记是**本人数据**（D-54）：列表、新增、编辑、删除全部只作用于当前账号自己的随手记，
 * 管理员也一样（他通过组织筛选器看的是「自己在那个组织下的记录」，而不是别人的）。
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
  const filters: NoteFilters = {
    orgFilter,
    keyword: url.searchParams.get("q") ?? undefined,
    pin: url.searchParams.get("pin") ?? undefined,
  };
  // 筛选、排序、分页都在服务端（口径见 app/lib/paging.ts）：URL 是唯一真相，loader 只回一页
  const paging = pagingOf(url.searchParams);
  const sort = sortOf(url.searchParams, sortableKeys(NOTE_SORTABLE), DEFAULT_NOTE_SORT);
  return {
    items: notesPage(user, filters, paging, sort) as unknown as Paged<NoteRow>,
    organizations,
    orgFilter: orgFilter ?? "",
  };
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
  const [editForm] = Form.useForm<{ content?: string; level?: string }>();
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

  // 关键词 / 灵感等级在服务端过滤；「重点优先，其次最近更新」的次序也由服务端的默认排序负责
  const rows = data.items.rows;
  const paging = useServerTable<NoteRow>(data.items);
  /**
   * 勾选只作用于**当前这一页**（见 /tasks 的同名处理）：列表参数一变就清空，
   * 否则「批量删除选中的 5 条」里会混进看不见的行。
   */
  const listSignature = ["q", "pin", "org", "page", "size", "sort", "order"].map((key) => list.get(key)).join("|");
  useEffect(() => setSelectedKeys([]), [listSignature]);

  const post = (payload: Record<string, unknown>): void => {
    submit(payload as Parameters<typeof submit>[0], { method: "post", encType: "application/json" });
  };
  const filtered = Boolean(keyword || pin !== "all" || orgFilter);

  // 列表里不再放「置顶」开关列：置顶 / 取消置顶由右侧「操作」列的按钮负责（还有批量操作），
  // 同一个动作在表格里出现两次既重复又容易误点；「灵感等级」列与内容前的图钉只做只读展示。
  const columns: TableProps<NoteRow>["columns"] = [
    {
      title: "记录内容",
      dataIndex: "content",
      key: "content",
      render: (_value, row) => (
        // 主内容列：图钉 + 两行省略的正文。`Flex` 而不是 `Space`——正文要吃掉剩余宽度，
        // 定宽布局下才能在两行处出省略号（配 `table-layout.css` 里的收缩规则）
        <Flex gap={4} align="flex-start" style={{ width: "100%" }}>
          {row.isPinned ? <PushpinFilled style={{ color: "#faad14", marginTop: 2, flex: "none" }} /> : null}
          <Tooltip title={row.content.length > 80 ? row.content : ""} placement="topLeft">
            <Typography.Paragraph style={{ margin: 0 }} ellipsis={{ rows: 2, expandable: false }}>
              {row.content}
            </Typography.Paragraph>
          </Tooltip>
        </Flex>
      ),
    },
    {
      title: "灵感等级",
      key: "level",
      width: 120,
      // 列上的筛选下拉已删除：灵感等级由工具栏的 Segmented 负责（同一字段只留一套说法；
      // 列筛选只作用于当前页，服务端分页下必然给出错误结果）
      render: (_value, row) => (
        <Tag color={row.isPinned ? "gold" : "default"} variant="filled">
          {row.isPinned ? "重点" : "普通"}
        </Tag>
      ),
    },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      key: "updatedAt",
      width: 170,
      sorter: true,
      sortOrder: paging.sortOrderOf("updatedAt"),
      render: (_value, row) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text>{dayjs(row.updatedAt).format("YYYY-MM-DD HH:mm")}</Typography.Text>
          <Typography.Text type="secondary">创建于 {dayjs(row.createdAt).format("MM-DD HH:mm")}</Typography.Text>
        </Space>
      ),
    },
    // 「所属组织」列只对管理员渲染：新建表单里就有这个字段（管理员必须选），列表里也就必须看得见（D-47）
    ...(isAdmin
      ? ([
          {
            title: "所属组织",
            key: "orgName",
            width: 140,
            render: (_value: unknown, row: NoteRow) => {
              const name = data.organizations.find((org) => org.id === row.orgId)?.name;
              return name ? <Tag color="blue">{name}</Tag> : <Typography.Text type="secondary">—</Typography.Text>;
            },
          },
        ] satisfies TableProps<NoteRow>["columns"])
      : []),
    {
      title: "操作",
      key: "actions",
      // 三个图标动作按钮（编辑 / 置顶 / 删除），每个约 36px
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
              key: "pin",
              label: row.isPinned ? "取消置顶" : "置顶",
              icon: <PushpinOutlined />,
              onClick: () => post({ intent: "pin", id: row.id, isPinned: !row.isPinned }),
            },
            {
              key: "delete",
              label: "删除",
              icon: <DeleteOutlined />,
              tone: "danger",
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

  // 表格排版方案（自动省略 + 定宽排版）：本页始终带勾选列
  const table = useMemo(() => dataTable<NoteRow>({ columns, selectable: true }), [columns]);

  return (
    <Flex vertical gap="large" className="page-stack">
      <PageHeader
        title="随手记"
        eyebrow="NOTES"
        description="记录要点与灵感，重点内容会排在列表最前。"
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
                共 {data.items.total} 条{filtered ? "（已筛选）" : ""}
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
            <Segmented
              value={pin}
              options={PIN_OPTIONS}
              aria-label="按灵感等级筛选"
              onChange={(value) => list.patch({ pin: value === "all" ? null : String(value) })}
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

      <FormDrawer
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
      </FormDrawer>

      <FormDrawer
        open={editing !== null}
        title="编辑随手记"
        form={editForm}
        submitting={busy}
        error={error}
        formKey={editing?.id ?? "none"}
        initialValues={{ content: editing?.content ?? "", level: editing?.isPinned ? "pinned" : "normal" }}
        onCancel={() => setEditing(null)}
        onFinish={(values) => {
          if (!editing) return;
          const content = values.content?.trim();
          if (!content) return;
          post({ intent: "update", id: editing.id, content, isPinned: values.level === "pinned" });
        }}
      >
        <Form.Item name="content" label="记录内容" rules={[{ required: true, message: "请输入记录内容" }]}>
          <Input.TextArea rows={8} maxLength={2000} showCount autoSize={{ minRows: 6, maxRows: 12 }} />
        </Form.Item>
        <Form.Item name="level" label="灵感等级" tooltip="重点的记录排在列表最前，便于随时查看">
          <Select options={PIN_FORM_OPTIONS} />
        </Form.Item>
      </FormDrawer>
    </Flex>
  );
}

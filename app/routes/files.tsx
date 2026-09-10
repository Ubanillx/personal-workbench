import type React from "react";
import { useEffect, useState } from "react";
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
  Table,
  Tag,
  Tooltip,
  Typography,
  type TableProps,
} from "antd";
import { CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { confirmDanger, RowActions } from "../components/crud-actions";
import { useCrudFeedback, useListParams } from "../components/crud-hooks";
import { FormModal } from "../components/crud-modal";
import { SelectionAlert, TableToolbar } from "../components/crud-toolbar";
import { PageHeader } from "../components/page-header";
import { readPayload } from "../lib/form.server";
import { createFileRecord, deleteFileRecord, listFiles, markFileUsedRecord, updateFileRecord } from "../lib/files.server";
import { listOrganizations } from "../lib/organization.server";
import { requireManagerOrRedirect } from "../lib/ui.server";

type FileRow = {
  id: string;
  name: string;
  filePath: string;
  category: string;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
type FileFormValues = { name?: string; filePath?: string; category?: string; orgId?: string };
type OrgOption = { id: string; name: string; status: string };
type ActionResult = { ok: true; notice: string } | { error: string };

/**
 * 文件页：与 GET /api/files 共用 app/lib/files.server.ts。
 * 文件库只对管理员与组织管理者开放（§4），普通成员由 requireManagerOrRedirect 送回首页；
 * 列表按组织过滤，`?org=` 是管理员（D-28）的筛选器接缝：既是列表过滤，也是管理员新增时的目标组织。
 */
export async function loader({ request }: { request: Request }) {
  const user = requireManagerOrRedirect(request);
  const query = new URL(request.url).searchParams;
  // 组织筛选器只对管理员有意义（D-28），与 /tasks 页的写法一致
  const files = listFiles(
    user,
    (query.get("search") ?? "").trim(),
    (query.get("category") ?? "").trim(),
    user.role === "admin" ? query.get("org") : null,
  ) as unknown as FileRow[];
  // 分类候选取自未过滤的全量列表，避免选中某个分类后其余分类从下拉里消失
  const all = listFiles(user, "", "", user.role === "admin" ? query.get("org") : null) as unknown as FileRow[];
  const organizations =
    user.role === "admin"
      ? listOrganizations(user).map((org) => ({ id: org.id, name: org.name, status: String(org.status) }) as OrgOption)
      : [];
  return {
    files,
    categories: [...new Set(all.map((file) => file.category).filter(Boolean))].toSorted((a, b) => a.localeCompare(b, "zh-Hans-CN")),
    organizations,
  };
}

/**
 * 文件索引写操作：与 `/api/files*` 共用 app/lib/files.server.ts 的同一份实现。
 * 表单是页面里的弹窗（JSON）与历史浏览器表单（form-urlencoded）两种提交方式，
 * 因此 `intent` 缺省时按「新增」处理——老入口不带 intent 也能照常工作。
 */
export async function action({ request }: { request: Request }): Promise<ActionResult> {
  const user = requireManagerOrRedirect(request);
  const payload = await readPayload(request);
  const intent = String(payload.intent ?? "create");
  const id = String(payload.id ?? "");
  const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : [];
  // 组织归属由 app/lib/files.server.ts 解析：管理者写本组织；
  // 管理员是全局角色，目标组织先看表单字段，再看页面上的组织筛选器 ?org=（D-28 的接缝）
  const orgFromUrl = new URL(request.url).searchParams.get("org");

  if (intent === "create") {
    const created = createFileRecord(user, {
      name: String(payload.name ?? ""),
      filePath: String(payload.filePath ?? ""),
      category: String(payload.category ?? ""),
      orgId: payload.orgId || orgFromUrl,
    });
    return created.ok ? { ok: true, notice: "文件索引已添加" } : { error: created.message };
  }
  if (intent === "update") {
    const updated = updateFileRecord(user, id, { name: payload.name, filePath: payload.filePath, category: payload.category });
    return updated.ok ? { ok: true, notice: "文件索引已保存" } : { error: updated.message };
  }
  if (intent === "delete") {
    const removed = deleteFileRecord(user, id);
    return removed.ok ? { ok: true, notice: "文件索引已删除" } : { error: removed.message };
  }
  if (intent === "touch") {
    const touched = markFileUsedRecord(user, id);
    return touched.ok ? { ok: true, notice: "已记录最近使用时间" } : { error: touched.message };
  }
  if (intent === "bulk-delete") {
    if (!ids.length) return { error: "请先选择文件" };
    let succeeded = 0;
    const failures: string[] = [];
    for (const target of ids) {
      const result = deleteFileRecord(user, target);
      if (result.ok) succeeded += 1;
      else failures.push(result.message);
    }
    if (!succeeded) return { error: failures[0] ?? "没有可删除的文件索引" };
    return { ok: true, notice: `已删除 ${succeeded} 条文件索引${failures.length ? `，${failures.length} 条被跳过` : ""}` };
  }
  return { error: "未知操作" };
}

export default function FilesRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submit = useSubmit();
  const { message, modal } = AntdApp.useApp();
  const list = useListParams();
  const [createForm] = Form.useForm<FileFormValues>();
  const [editForm] = Form.useForm<FileFormValues>();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<FileRow | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const { error } = useCrudFeedback(actionData, () => {
    setCreateOpen(false);
    setEditing(null);
    setSelectedKeys([]);
  });
  const busy = navigation.state !== "idle" || revalidator.state !== "idle";
  const isAdmin = data.organizations.length > 0;

  const search = list.get("search");
  const category = list.get("category");
  const orgFilter = list.get("org");
  const [draftSearch, setDraftSearch] = useState(search);
  useEffect(() => setDraftSearch(search), [search]);

  const post = (payload: Record<string, unknown>): void => {
    submit(payload as Parameters<typeof submit>[0], { method: "post", encType: "application/json" });
  };

  /** 复制路径 + 记一次「最近使用」：复制成功才上报，避免把失败算成使用 */
  const copyPath = (file: FileRow): void => {
    if (!navigator.clipboard) {
      window.prompt("请复制以下路径", file.filePath);
      return;
    }
    void navigator.clipboard
      .writeText(file.filePath)
      .then(() => {
        void message.success("路径已复制");
        post({ intent: "touch", id: file.id });
      })
      .catch(() => window.prompt("请复制以下路径", file.filePath));
  };

  const remove = (file: FileRow): void =>
    confirmDanger(modal, {
      title: `删除「${file.name}」的索引？`,
      content: "只删除索引记录，不会删除磁盘上的文件。",
      okText: "删除",
      onOk: () => post({ intent: "delete", id: file.id }),
    });

  const filtered = Boolean(search || category || orgFilter);

  const columns: TableProps<FileRow>["columns"] = [
    {
      title: "文件名称",
      dataIndex: "name",
      key: "name",
      width: 240,
      sorter: (a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"),
      render: (_value, file) => <Typography.Text strong>{file.name}</Typography.Text>,
    },
    {
      title: "文件路径",
      dataIndex: "filePath",
      key: "filePath",
      render: (_value, file) => (
        <Typography.Text code copyable={{ text: file.filePath, tooltips: ["复制路径", "已复制"] }}>
          {file.filePath}
        </Typography.Text>
      ),
    },
    {
      title: "分类",
      dataIndex: "category",
      key: "category",
      width: 140,
      filters: data.categories.map((item) => ({ text: item, value: item })),
      onFilter: (value, file) => file.category === value,
      render: (_value, file) =>
        file.category ? (
          <Tag color="blue" variant="filled">
            {file.category}
          </Tag>
        ) : (
          <Typography.Text type="secondary">未分类</Typography.Text>
        ),
    },
    {
      title: "最近使用",
      dataIndex: "lastUsedAt",
      key: "lastUsedAt",
      width: 170,
      sorter: (a, b) => String(a.lastUsedAt ?? "").localeCompare(String(b.lastUsedAt ?? "")),
      render: (_value, file) =>
        file.lastUsedAt ? (
          <Tooltip title={dayjs(file.lastUsedAt).format("YYYY-MM-DD HH:mm:ss")}>
            <Typography.Text>{dayjs(file.lastUsedAt).format("MM-DD HH:mm")}</Typography.Text>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">尚未记录</Typography.Text>
        ),
    },
    {
      title: "操作",
      key: "actions",
      width: 160,
      align: "right",
      render: (_value, file) => (
        <RowActions
          extra={
            <Button size="small" color="default" variant="text" icon={<CopyOutlined />} onClick={() => copyPath(file)}>
              复制路径
            </Button>
          }
          items={[
            { key: "edit", label: "编辑", icon: <EditOutlined />, onClick: () => setEditing(file) },
            { key: "touch", label: "记录为最近使用", onClick: () => post({ intent: "touch", id: file.id }) },
            { type: "divider" },
            { key: "delete", label: "删除索引", danger: true, icon: <DeleteOutlined />, onClick: () => remove(file) },
          ]}
        />
      ),
    },
  ];

  return (
    <Flex vertical gap="large" className="page-stack">
      <PageHeader
        title="重要文件"
        description="收藏本机或共享盘文件路径，方便查找与复制。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => revalidator.revalidate()} loading={busy}>
              刷新
            </Button>
            <Button color="primary" variant="solid" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              添加文件
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
                共 {data.files.length} 条{filtered ? "（已筛选）" : ""}
              </Typography.Text>
            }
          >
            <Input.Search
              allowClear
              placeholder="搜索文件名称或路径"
              style={{ width: 280 }}
              value={draftSearch}
              loading={busy}
              onChange={(event) => setDraftSearch(event.target.value)}
              onSearch={(value) => list.patch({ search: value.trim() })}
            />
            <Select
              value={category || "all"}
              style={{ width: 160 }}
              options={[{ value: "all", label: "全部分类" }, ...data.categories.map((item) => ({ value: item, label: item }))]}
              onChange={(value: string) => list.patch({ category: value === "all" ? null : value })}
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

          <SelectionAlert count={selectedKeys.length} noun="个文件" onClear={() => setSelectedKeys([])}>
            <Button
              size="small"
              color="danger"
              variant="outlined"
              onClick={() =>
                confirmDanger(modal, {
                  title: `删除选中的 ${selectedKeys.length} 条索引？`,
                  content: "只删除索引记录，不会删除磁盘上的文件。",
                  okText: "批量删除",
                  onOk: () => post({ intent: "bulk-delete", ids: selectedKeys }),
                })
              }
            >
              批量删除
            </Button>
          </SelectionAlert>

          <Table<FileRow>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={data.files}
            loading={busy}
            scroll={{ x: 960 }}
            rowSelection={{ selectedRowKeys: selectedKeys, preserveSelectedRowKeys: true, onChange: (keys) => setSelectedKeys(keys) }}
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
                      <Typography.Text strong>{filtered ? "没有符合条件的文件" : "暂无已登记文件"}</Typography.Text>
                      <Typography.Text type="secondary">
                        {filtered ? "调整筛选条件，或重置后查看全部。" : "添加报价单、客户资料或模板的路径索引。"}
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
        title="添加文件索引"
        okText="添加"
        form={createForm}
        submitting={busy}
        error={error}
        initialValues={{ orgId: orgFilter || data.organizations.at(0)?.id || "" }}
        onCancel={() => setCreateOpen(false)}
        onFinish={(values) => {
          const name = values.name?.trim();
          const filePath = values.filePath?.trim();
          if (!name || !filePath) return;
          post({
            intent: "create",
            name,
            filePath,
            category: values.category?.trim() ?? "",
            ...(isAdmin ? { orgId: values.orgId ?? "" } : {}),
          });
        }}
      >
        <Form.Item name="name" label="文件名称" rules={[{ required: true, message: "请输入文件名称" }]}>
          <Input placeholder="例如：2026 版报价单模板" maxLength={80} />
        </Form.Item>
        <Form.Item
          name="filePath"
          label="文件路径"
          rules={[{ required: true, message: "请输入文件路径" }]}
          tooltip="本机绝对路径或共享盘路径（\\\\server\\share\\...）"
        >
          <Input placeholder="C:\work\报价单模板.xlsx" maxLength={400} />
        </Form.Item>
        <Form.Item name="category" label="分类" tooltip="用于列表筛选，例如：报价 / 客户资料 / 模板">
          <Input placeholder="可选" maxLength={40} />
        </Form.Item>
        {isAdmin ? (
          <Form.Item name="orgId" label="所属组织" rules={[{ required: true, message: "请选择文件所属组织" }]}>
            <Select
              placeholder="请选择所属组织"
              options={data.organizations.filter((org) => org.status === "active").map((org) => ({ value: org.id, label: org.name }))}
            />
          </Form.Item>
        ) : null}
      </FormModal>

      <FormModal
        open={editing !== null}
        title="编辑文件索引"
        form={editForm}
        submitting={busy}
        error={error}
        formKey={editing?.id ?? "none"}
        initialValues={{
          name: editing?.name ?? "",
          filePath: editing?.filePath ?? "",
          category: editing?.category ?? "",
        }}
        onCancel={() => setEditing(null)}
        onFinish={(values) => {
          if (!editing) return;
          const name = values.name?.trim();
          const filePath = values.filePath?.trim();
          if (!name || !filePath) return;
          post({ intent: "update", id: editing.id, name, filePath, category: values.category?.trim() ?? "" });
        }}
      >
        <Form.Item name="name" label="文件名称" rules={[{ required: true, message: "请输入文件名称" }]}>
          <Input maxLength={80} />
        </Form.Item>
        <Form.Item name="filePath" label="文件路径" rules={[{ required: true, message: "请输入文件路径" }]}>
          <Input maxLength={400} />
        </Form.Item>
        <Form.Item name="category" label="分类">
          <Input placeholder="可选" maxLength={40} />
        </Form.Item>
      </FormModal>
    </Flex>
  );
}

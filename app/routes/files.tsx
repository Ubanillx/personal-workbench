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
import {
  CloudOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import type { WebDavBrowseEntry, WebDavFileStatus } from "../../shared/types/domain";
import { confirmDanger, RowActions } from "../components/crud-actions";
import { useCrudFeedback, useListParams } from "../components/crud-hooks";
import { FormDrawer } from "../components/crud-drawer";
import { SelectionAlert, TableToolbar } from "../components/crud-toolbar";
import { PageHeader } from "../components/page-header";
import { displayPath, formatBytes, remoteParentPath } from "../components/webdav-browser";
import { WebDavFilePicker } from "../components/webdav-file-picker";
import { WebDavUploadPicker } from "../components/webdav-upload-picker";
import { readPayload } from "../lib/form.server";
import { createFileRecord, deleteFileRecord, listFiles, markFileUsedRecord, updateFileRecord } from "../lib/files.server";
import { listOrganizations } from "../lib/organization.server";
import { requireManagerOrRedirect } from "../lib/ui.server";
import { isWebDavPath, remoteStatuses, toRemotePath, webDavStatus } from "../lib/webdav.server";

type FileRow = {
  id: string;
  name: string;
  filePath: string;
  category: string;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** 所属组织：服务端读模型里有（`records.server.ts` 的 `FILE_SELECT`），API 载荷不带（契约冻结），页面用它渲染管理员列 */
  orgId: string | null;
};
type FileFormValues = { name?: string; filePath?: string; category?: string; orgId?: string };
type OrgOption = { id: string; name: string; status: string };
type ActionResult = { ok: true; notice: string } | { error: string };
/** 表单里的「选择文件」当前在为哪个抽屉挑文件（null = 没在挑） */
type PickTarget = "create" | "edit";

/**
 * 文件页：与 GET /api/files 共用 app/lib/files.server.ts。
 * 文件库只对管理员与组织管理者开放（§4），普通成员由 requireManagerOrRedirect 送回首页；
 * 列表按组织过滤，`?org=` 是管理员（D-28）的筛选器接缝：既是列表过滤，也是管理员新增时的目标组织。
 *
 * WebDAV（可选接入，见 docs/harness/WEBDAV.md）：`file_path` 以 `webdav:` 开头的是远端条目，
 * 页面对它们额外探测一次远端状态（大小 / 修改时间 / 是否还在），数量与耗时都有上限；
 * 当前账号在设置页里没配 WebDAV 时整块信息为 `enabled: false`，只能查看已有索引（新增需先配置）。
 *
 * 路径**只能选**（D-48）：新建 / 编辑抽屉里的「选择文件」走 `WebDavFilePicker`（字段只读，选中的文件填进表单），
 * 页头的「浏览 WebDAV」走 `WebDavUploadPicker`（选中即登记 + 上传），两者共用 `webdav-browser.tsx`。
 * 浏览器读不到本机磁盘、服务端也不该为此暴露文件系统，所以本机路径不再有新增入口（老数据照常展示）。
 */
export async function loader({ request }: { request: Request }) {
  const user = requireManagerOrRedirect(request);
  const query = new URL(request.url).searchParams;
  // 组织筛选器只对管理员有意义（D-28），与 /tasks 页的写法一致
  const orgFilter = user.role === "admin" ? query.get("org") : null;
  const files = listFiles(
    user,
    (query.get("search") ?? "").trim(),
    (query.get("category") ?? "").trim(),
    orgFilter,
  ) as unknown as FileRow[];
  // 分类候选取自未过滤的全量列表，避免选中某个分类后其余分类从下拉里消失
  const all = listFiles(user, "", "", orgFilter) as unknown as FileRow[];
  const organizations =
    user.role === "admin"
      ? listOrganizations(user).map((org) => ({ id: org.id, name: org.name, status: String(org.status) }) as OrgOption)
      : [];

  const status = webDavStatus(user.id);
  const remotePaths = files.filter((file) => isWebDavPath(file.filePath)).map((file) => toRemotePath(file.filePath));
  const probe =
    status.enabled && remotePaths.length
      ? await remoteStatuses(user.id, remotePaths)
      : { reachable: true, message: null, statuses: new Map<string, WebDavFileStatus>() };
  const remote: Record<string, WebDavFileStatus | null> = {};
  for (const file of files) {
    if (isWebDavPath(file.filePath)) remote[file.id] = probe.statuses.get(toRemotePath(file.filePath)) ?? null;
  }

  return {
    files,
    categories: [...new Set(all.map((file) => file.category).filter(Boolean))].toSorted((a, b) => a.localeCompare(b, "zh-Hans-CN")),
    organizations,
    webdav: {
      enabled: status.enabled,
      configured: status.configured,
      root: status.root,
      url: status.url,
      probeLimit: status.probeLimit,
      reachable: probe.reachable,
      message: probe.message,
      remote,
    },
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
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pickTarget, setPickTarget] = useState<PickTarget | null>(null);
  /** 「选择文件」打开时定位到的目录（编辑远端条目直接进它所在那层，新建从浏览根开始） */
  const [pickStart, setPickStart] = useState("");
  /** 打开「选择文件」时表单里已填的路径：命中的那一行显示「当前」 */
  const [pickCurrent, setPickCurrent] = useState("");
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

  /**
   * 打开「选择文件」（D-48）：起点用**表单当前值**定——编辑远端条目时直接进它所在那层目录，
   * 不必每次从浏览根一路点进去；老的本机路径没有对应远端目录，回到浏览根。
   */
  const openFilePicker = (target: PickTarget): void => {
    const form = target === "edit" ? editForm : createForm;
    const current = String(form.getFieldValue("filePath") ?? "");
    setPickStart(remoteParentPath(current));
    setPickCurrent(current);
    setPickTarget(target);
  };

  /** 选中文件后回填：路径一定覆盖；文件名称**还空着**才用文件名补上（用户改过的说法不覆盖） */
  const applyPicked = (entry: WebDavBrowseEntry): void => {
    if (!pickTarget) return;
    const form = pickTarget === "edit" ? editForm : createForm;
    const named = String(form.getFieldValue("name") ?? "").trim();
    form.setFieldsValue({ filePath: entry.filePath, ...(named ? {} : { name: entry.name }) });
    setPickTarget(null);
    void message.success(`已选择「${entry.name}」`);
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

  /**
   * 下载远端文件（D-49）：GET /api/files/:id/download 是服务端流式代理，
   * 响应带 content-disposition: attachment，浏览器拿到后直接落盘、页面不跳走。
   * 本机路径的索引没有下载入口（服务端读不到本机磁盘）。
   */
  const download = (file: FileRow): void => {
    window.location.href = `/api/files/${file.id}/download`;
  };

  const remove = (file: FileRow): void =>
    confirmDanger(modal, {
      title: `删除「${file.name}」的索引？`,
      content: "只删除索引记录，不会删除磁盘上的文件。",
      okText: "删除",
      onOk: () => post({ intent: "delete", id: file.id }),
    });

  const filtered = Boolean(search || category || orgFilter);
  /** 该行是不是 WebDAV 远端条目：loader 对每个远端行都会写 remote[file.id]（未检查时为 null） */
  const isRemote = (file: FileRow): boolean => data.webdav.remote[file.id] !== undefined;

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
        <Space size={4} align="center">
          {isRemote(file) ? (
            <Tag color="geekblue" variant="filled">
              WebDAV
            </Tag>
          ) : null}
          <Typography.Text code copyable={{ text: file.filePath, tooltips: ["复制路径", "已复制"] }}>
            {displayPath(file.filePath)}
          </Typography.Text>
        </Space>
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
      title: "文件情况",
      key: "remote",
      width: 230,
      render: (_value, file) => {
        // 本机路径没法从服务端探测（服务只看得到路径字符串），如实标注而不是显示成「正常」
        if (!isRemote(file)) return <Typography.Text type="secondary">本机路径，无法检查</Typography.Text>;
        const status = data.webdav.remote[file.id] ?? null;
        if (!status) return <Tag>未检查</Tag>;
        if (!status.exists)
          return (
            <Tag color="red" variant="filled">
              远端已不存在
            </Tag>
          );
        return (
          <Space size={4} wrap>
            <Tag color="green" variant="filled">
              可访问
            </Tag>
            <Typography.Text>{formatBytes(status.size)}</Typography.Text>
            <Typography.Text type="secondary">
              {status.lastModified ? dayjs(status.lastModified).format("MM-DD HH:mm") : "无时间"}
            </Typography.Text>
          </Space>
        );
      },
    },
    // 「所属组织」列只对管理员渲染：新建表单里就有这个字段（管理员必须选），列表里也就必须看得见（D-47）
    ...(isAdmin
      ? ([
          {
            title: "所属组织",
            key: "orgName",
            width: 140,
            render: (_value: unknown, file: FileRow) => {
              const name = data.organizations.find((org) => org.id === file.orgId)?.name;
              return name ? <Tag color="blue">{name}</Tag> : <Typography.Text type="secondary">—</Typography.Text>;
            },
          },
        ] satisfies TableProps<FileRow>["columns"])
      : []),
    {
      title: "操作",
      key: "actions",
      width: 320,
      align: "right",
      render: (_value, file) => {
        const status = data.webdav.remote[file.id] ?? null;
        return (
          <RowActions
            actions={[
              {
                key: "copy",
                label: "复制路径",
                icon: <CopyOutlined />,
                onClick: () => copyPath(file),
              },
              // 下载只对远端条目开放，且本账号要配好 WebDAV（否则点下去必 503）；
              // 「远端已不存在」时置灰而不是让用户点出 404
              ...(isRemote(file) && data.webdav.enabled
                ? [
                    {
                      key: "download",
                      label: status && !status.exists ? "远端已不存在，无法下载" : "下载",
                      icon: <DownloadOutlined />,
                      disabled: status ? !status.exists : false,
                      onClick: () => download(file),
                    },
                  ]
                : []),
              { key: "edit", label: "编辑", icon: <EditOutlined />, onClick: () => setEditing(file) },
              {
                key: "touch",
                label: "记录为最近使用",
                icon: <HistoryOutlined />,
                onClick: () => post({ intent: "touch", id: file.id }),
              },
              { key: "delete", label: "删除索引", icon: <DeleteOutlined />, tone: "danger", onClick: () => remove(file) },
            ]}
          />
        );
      },
    },
  ];

  return (
    <Flex vertical gap="large" className="page-stack">
      <PageHeader
        title="重要文件"
        eyebrow="FILES"
        description={
          data.webdav.enabled
            ? `从 WebDAV「${data.webdav.root}」直接浏览、选择与上传。`
            : "配置 WebDAV 后，即可从远端直接浏览、选择与上传。"
        }
        help="只登记路径索引，不会移动或删除磁盘上的原文件。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => revalidator.revalidate()} loading={busy}>
              刷新
            </Button>
            {data.webdav.enabled ? (
              <Button icon={<CloudOutlined />} onClick={() => setUploadOpen(true)}>
                浏览 WebDAV
              </Button>
            ) : (
              <Button icon={<SettingOutlined />} href="/settings?tab=webdav">
                配置 WebDAV
              </Button>
            )}
            <Button color="primary" variant="solid" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              添加文件
            </Button>
          </>
        }
      />

      {error ? <Alert type="error" showIcon title={error} /> : null}

      {data.webdav.enabled && !data.webdav.reachable ? (
        <Alert type="warning" showIcon title="WebDAV 暂时不可达，远端文件状态未检查" description={data.webdav.message ?? undefined} />
      ) : null}

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
            scroll={{ x: isAdmin ? 1100 : 960 }}
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

      <FormDrawer
        open={createOpen}
        title="添加文件索引"
        okText="添加"
        form={createForm}
        submitting={busy}
        error={error}
        initialValues={{ orgId: orgFilter || data.organizations.at(0)?.id || "" }}
        onCancel={() => setCreateOpen(false)}
        // 选择器挂在本抽屉**里面**（afterForm）：antd 会给嵌套的浮层 +100 层级，
        // 保证它稳稳盖在表单抽屉之上，不依赖两个同层抽屉的 DOM 顺序（CODE_STYLE §10.7 第 2 条）
        afterForm={
          <WebDavFilePicker
            open={pickTarget === "create"}
            root={data.webdav.root}
            initialPath={pickStart}
            currentFilePath={pickCurrent}
            onClose={() => setPickTarget(null)}
            onPick={applyPicked}
          />
        }
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
        <Form.Item
          name="name"
          label="文件名称"
          rules={[{ required: true, message: "请输入文件名称" }]}
          tooltip="从 WebDAV 选文件时会自动填入文件名（已经填过就不覆盖）"
        >
          <Input placeholder="例如：2026 版报价单模板" maxLength={80} />
        </Form.Item>
        <FilePathItem webdavEnabled={data.webdav.enabled} onPick={() => openFilePicker("create")} />
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
      </FormDrawer>

      <FormDrawer
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
        afterForm={
          <WebDavFilePicker
            open={pickTarget === "edit"}
            root={data.webdav.root}
            initialPath={pickStart}
            currentFilePath={pickCurrent}
            onClose={() => setPickTarget(null)}
            onPick={applyPicked}
          />
        }
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
        <FilePathItem webdavEnabled={data.webdav.enabled} onPick={() => openFilePicker("edit")} />
        <Form.Item name="category" label="分类">
          <Input placeholder="可选" maxLength={40} />
        </Form.Item>
      </FormDrawer>

      <WebDavUploadPicker
        open={uploadOpen}
        root={data.webdav.root}
        organizations={data.organizations.filter((org) => org.status === "active")}
        defaultOrgId={orgFilter || data.organizations.at(0)?.id || ""}
        defaultCategory={category}
        onClose={() => setUploadOpen(false)}
        onRegister={(entry, values) => {
          setUploadOpen(false);
          post({
            intent: "create",
            name: entry.name,
            filePath: entry.filePath,
            category: values.category,
            ...(values.orgId ? { orgId: values.orgId } : {}),
          });
        }}
        onUploaded={() => void revalidator.revalidate()}
      />
    </Flex>
  );
}

/**
 * 「文件路径」字段（D-48）：**只能选**——点「选择文件」在 WebDAV 目录里挑，字段只读展示选中的路径。
 * 浏览器读不到本机磁盘、服务端也不该为此暴露文件系统，所以这里不再有手写入口
 * （已有的本机路径索引照常显示，复制 / 改名 / 分类不受影响）。
 *
 * 用 `Space.Compact` + 内层 `Form.Item noStyle` 是 antd 的标准「输入框 + 按钮」写法：
 * 校验与外层的标签 / 提示仍然由外层 `Form.Item` 负责，两个抽屉共用同一个字段定义。
 */
function FilePathItem({ webdavEnabled, onPick }: { webdavEnabled: boolean; onPick: () => void }): React.ReactElement {
  return (
    <Form.Item
      label="文件路径"
      required
      tooltip="点「选择文件」在远端目录里挑，路径自动填好"
      {...(webdavEnabled ? {} : { extra: "本账号还没配置 WebDAV，「选择文件」暂时用不了：请先到「设置 → WebDAV」保存一次账号。" })}
    >
      <Space.Compact style={{ width: "100%" }}>
        <Form.Item name="filePath" noStyle rules={[{ required: true, message: "请选择文件" }]}>
          <Input readOnly placeholder="点右侧「选择文件」从 WebDAV 挑" maxLength={400} />
        </Form.Item>
        <Button icon={<FolderOpenOutlined />} onClick={onPick} disabled={!webdavEnabled}>
          选择文件
        </Button>
      </Space.Compact>
    </Form.Item>
  );
}

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
  Radio,
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
import { useCrudFeedback, useListParams, useServerTable } from "../components/crud-hooks";
import { FormDrawer } from "../components/crud-drawer";
import { SelectionAlert, TableToolbar } from "../components/crud-toolbar";
import { PageHeader } from "../components/page-header";
import { dataTable } from "../components/table-layout";
import { displayPath, formatBytes, remoteParentPath } from "../components/webdav-browser";
import { WebDavFilePicker } from "../components/webdav-file-picker";
import { WebDavUploadPicker } from "../components/webdav-upload-picker";
import {
  createFileRecord,
  DEFAULT_FILE_SORT,
  deleteFileRecord,
  FILE_SORTABLE,
  fileCategories,
  filesPage,
  markFileUsedRecord,
  updateFileRecord,
  type FileFilters,
} from "../lib/files.server";
import { readPayload } from "../lib/form.server";
import { listOrganizations } from "../lib/organization.server";
import { pagingOf, sortOf, type Paged } from "../lib/paging";
import { sortableKeys } from "../lib/paging.server";
import { requireUserOrRedirect } from "../lib/ui.server";
import { isWebDavPath, remoteStatuses, toRemotePath, webDavStatus } from "../lib/webdav.server";

type FileRow = {
  id: string;
  name: string;
  filePath: string;
  category: string;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** 可见范围（D-55）：`private` = 仅自己与本组织管理员，`org` = 组织内公开 */
  visibility: "org" | "private";
  /** 这条索引是不是当前账号登记的（页面显示「我登记的」用；**不是**权限判据，服务端删除时会重判） */
  owned: boolean;
  /** 所属组织：服务端读模型里有（`records.server.ts` 的 `FILE_SELECT`），API 载荷不带，页面用它渲染管理员列 */
  orgId: string | null;
};
type FileFormValues = { name?: string; filePath?: string; category?: string; orgId?: string; visibility?: "org" | "private" };
type OrgOption = { id: string; name: string; status: string };
type ActionResult = { ok: true; notice: string } | { error: string };
/** 表单里的「选择文件」当前在为哪个抽屉挑文件（null = 没在挑） */
type PickTarget = "create" | "edit";

/** 「给谁看」的两个选项：列表标识、表单单选、WebDAV 登记共用同一份文案，避免三处说法漂移 */
const VISIBILITY_LABEL: Record<"org" | "private", string> = { org: "组织可见", private: "仅自己" };
const VISIBILITY_OPTIONS = [
  { value: "org", label: "给组织看", description: "本组织所有人都能看到、编辑与下载" },
  { value: "private", label: "给自己看", description: "只有你与本组织管理员能看到" },
] as const;

/**
 * 文件页：与 GET /api/files 共用 app/lib/files.server.ts。
 * 组织内所有人都能进（D-54）：普通成员可查看、新增、编辑。
 *
 * **可见范围由每条索引自己决定（D-55）**：`给组织看` = 本组织公开；`给自己看` = 只有创建人
 * 与本组织的全局管理员能看到。**删除权限因此是逐条算的**：创建人可以删自己登记的（含个人文件），
 * 组织管理者可以删本组织的公开文件，管理员全可删 —— `deletableIds` 由服务端用同一个
 * `canDeleteFile()` 算好，页面只负责渲染入口（页面不自己判角色）。
 *
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
  const user = requireUserOrRedirect(request);
  const query = new URL(request.url).searchParams;
  // 组织筛选器只对管理员有意义（D-28），与 /tasks 页的写法一致
  const orgFilter = user.role === "admin" ? query.get("org") : null;
  const filters: FileFilters = {
    search: (query.get("search") ?? "").trim(),
    category: (query.get("category") ?? "").trim(),
    visibility: query.get("visibility") ?? undefined,
    orgFilter,
  };
  // 筛选、排序、分页都在服务端（口径见 app/lib/paging.ts）：URL 是唯一真相，loader 只回一页
  const paging = pagingOf(query);
  const sort = sortOf(query, sortableKeys(FILE_SORTABLE), DEFAULT_FILE_SORT);
  /**
   * `deletableIds` 由服务端用同一个 `canDeleteFile()` 算好（D-55），只覆盖当页：
   * 勾选与批量删除本来就只作用于当页；真正删除时服务端还会再判一次。
   */
  const { page, deletableIds } = filesPage(user, filters, paging, sort);
  const files = page as unknown as Paged<FileRow>;
  const isAdmin = user.role === "admin";
  const organizations = isAdmin
    ? listOrganizations(user).map((org) => ({ id: org.id, name: org.name, status: String(org.status) }) as OrgOption)
    : [];

  const status = webDavStatus(user.id);
  const remotePaths = files.rows.filter((file) => isWebDavPath(file.filePath)).map((file) => toRemotePath(file.filePath));
  const probe =
    status.enabled && remotePaths.length
      ? await remoteStatuses(user.id, remotePaths)
      : { reachable: true, message: null, statuses: new Map<string, WebDavFileStatus>() };
  const remote: Record<string, WebDavFileStatus | null> = {};
  for (const file of files.rows) {
    if (isWebDavPath(file.filePath)) remote[file.id] = probe.statuses.get(toRemotePath(file.filePath)) ?? null;
  }

  return {
    files,
    categories: fileCategories(user, orgFilter),
    organizations,
    isAdmin,
    deletableIds,
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
 * 删除类 intent 在这里不额外判角色：`deleteFileRecord` 会用 `canDeleteFile()` 把门，
 * 页面只是不渲染入口，服务端才是判权的那个地方。
 */
export async function action({ request }: { request: Request }): Promise<ActionResult> {
  const user = requireUserOrRedirect(request);
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
      // 可见范围（D-55）：`private` = 仅自己与本组织管理员；缺省 / 其他值按 `org`（组织可见）
      visibility: payload.visibility,
      orgId: payload.orgId || orgFromUrl,
    });
    return created.ok ? { ok: true, notice: "文件索引已添加" } : { error: created.message };
  }
  if (intent === "update") {
    const updated = updateFileRecord(user, id, {
      name: payload.name,
      filePath: payload.filePath,
      category: payload.category,
      // 不带就保持原值（改名的请求不该顺手改掉可见范围）
      visibility: payload.visibility,
    });
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
  // 「所属组织」列与组织筛选器只对管理员有意义；它与「能不能删」是两件事，不要合并成一个开关
  const isAdmin = data.isAdmin;
  /** 删除是**逐条**判的（D-55）：创建人能删自己的，组织管理者能删本组织的公开文件 */
  const deletable = new Set(data.deletableIds);
  /** 当页只要有一行可删，就保留勾选框与批量删除入口（勾选只作用于当页，服务端只回当页的判权结论） */
  const canDeleteAny = data.deletableIds.length > 0;
  const selectedDeletable = selectedKeys.filter((key) => deletable.has(String(key)));

  const search = list.get("search");
  const category = list.get("category");
  const visibility = list.get("visibility");
  const orgFilter = list.get("org");
  const [draftSearch, setDraftSearch] = useState(search);
  useEffect(() => setDraftSearch(search), [search]);
  // 搜索 / 分类 / 可见范围都在服务端过滤；这里只渲染 loader 给的那一页
  const rows = data.files.rows;
  const paging = useServerTable<FileRow>(data.files);
  /**
   * 勾选只作用于**当前这一页**（见 /tasks 的同名处理）：列表参数一变就清空，
   * 否则「批量删除选中的 5 条」会把看不见的行也算进去。
   */
  const listSignature = ["search", "category", "visibility", "org", "page", "size", "sort", "order"].map((key) => list.get(key)).join("|");
  useEffect(() => setSelectedKeys([]), [listSignature]);

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

  const filtered = Boolean(search || category || visibility || orgFilter);
  /** 该行是不是 WebDAV 远端条目：loader 对每个远端行都会写 remote[file.id]（未检查时为 null） */
  const isRemote = (file: FileRow): boolean => data.webdav.remote[file.id] !== undefined;

  const columns: TableProps<FileRow>["columns"] = [
    {
      title: "文件名称",
      dataIndex: "name",
      key: "name",
      width: 240,
      // 表头排序由服务端做（客户端比较器只能排当前这一页）
      sorter: true,
      sortOrder: paging.sortOrderOf("name"),
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
      title: "可见范围",
      dataIndex: "visibility",
      key: "visibility",
      width: 150,
      // 可见范围的筛选搬到工具栏（原来在列头的筛选下拉里，只作用于当前页）：
      // 两个取值都是用户自己选的可见范围（D-55），列头与表单字段用同一套说法
      render: (_value, file) => (
        <Space size={4} align="center">
          <Tag color={file.visibility === "private" ? "purple" : "blue"} variant="filled">
            {VISIBILITY_LABEL[file.visibility]}
          </Tag>
          {file.owned ? <Typography.Text type="secondary">我登记的</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: "分类",
      dataIndex: "category",
      key: "category",
      width: 140,
      // 分类筛选由工具栏的分类下拉负责（同一字段只留一套说法；列筛选只作用于当前页）
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
      sorter: true,
      sortOrder: paging.sortOrderOf("lastUsedAt"),
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
      // 图标动作按钮平铺（复制路径 / 下载 / 编辑 / 记录使用 / 删除索引），每个约 36px
      width: 220,
      align: "right",
      ellipsis: false,
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
              // 删除**逐条**判（D-55）：创建人能删自己登记的（含个人文件），
              // 组织管理者能删本组织的公开文件；服务端删除时会用同一判据再判一次
              ...(deletable.has(file.id)
                ? [{ key: "delete", label: "删除索引", icon: <DeleteOutlined />, tone: "danger" as const, onClick: () => remove(file) }]
                : []),
            ]}
          />
        );
      },
    },
  ];

  // 表格排版方案（自动省略 + 定宽排版）：勾选列只在「有任意一条可删除」时出现
  const table = useMemo(() => dataTable<FileRow>({ columns, selectable: canDeleteAny }), [columns, canDeleteAny]);

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
                共 {data.files.total} 条{filtered ? "（已筛选）" : ""}
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
            <Select
              aria-label="按可见范围筛选"
              value={visibility || "all"}
              style={{ width: 150 }}
              options={[
                { value: "all", label: "全部可见范围" },
                { value: "org", label: VISIBILITY_LABEL.org },
                { value: "private", label: VISIBILITY_LABEL.private },
              ]}
              onChange={(value: string) => list.patch({ visibility: value === "all" ? null : value })}
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

          {/*
            批量删除：只有在**选中的行里有自己删得动的**时才出现（D-55 起删除是逐条判的）。
            默认把指令作用在可删的那部分上，并说清楚跳过了几条——不要给一个点了会静默失败的按钮。
          */}
          {canDeleteAny ? (
            <SelectionAlert count={selectedKeys.length} noun="个文件" onClear={() => setSelectedKeys([])}>
              <Button
                size="small"
                color="danger"
                variant="outlined"
                disabled={selectedDeletable.length === 0}
                onClick={() =>
                  confirmDanger(modal, {
                    title: `删除选中的 ${selectedDeletable.length} 条索引？`,
                    content: "只删除索引记录，不会删除磁盘上的文件。",
                    okText: "批量删除",
                    onOk: () => post({ intent: "bulk-delete", ids: selectedDeletable }),
                  })
                }
              >
                批量删除
                {selectedKeys.length > selectedDeletable.length ? `（可删 ${selectedDeletable.length} 条）` : ""}
              </Button>
            </SelectionAlert>
          ) : null}

          <Table<FileRow>
            {...table}
            rowKey="id"
            size="middle"
            dataSource={rows}
            loading={busy}
            {...(canDeleteAny
              ? {
                  rowSelection: {
                    selectedRowKeys: selectedKeys,
                    // 删不动的行不给勾：勾了也只能失败
                    getCheckboxProps: (file: FileRow) => ({ disabled: !deletable.has(file.id) }),
                    onChange: (keys: React.Key[]) => setSelectedKeys(keys),
                  },
                }
              : {})}
            pagination={paging.pagination}
            onChange={paging.onTableChange}
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
        initialValues={{ orgId: orgFilter || data.organizations.at(0)?.id || "", visibility: "org" }}
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
            visibility: values.visibility ?? "org",
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
        <VisibilityItem />
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
          visibility: editing?.visibility ?? "org",
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
          post({
            intent: "update",
            id: editing.id,
            name,
            filePath,
            category: values.category?.trim() ?? "",
            // 改名不该顺手改可见范围，所以这里显式回填当前值（用户改过的以表单为准）
            visibility: values.visibility ?? editing.visibility,
          });
        }}
      >
        <Form.Item name="name" label="文件名称" rules={[{ required: true, message: "请输入文件名称" }]}>
          <Input maxLength={80} />
        </Form.Item>
        <FilePathItem webdavEnabled={data.webdav.enabled} onPick={() => openFilePicker("edit")} />
        <Form.Item name="category" label="分类">
          <Input placeholder="可选" maxLength={40} />
        </Form.Item>
        <VisibilityItem />
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
            visibility: values.visibility,
            ...(values.orgId ? { orgId: values.orgId } : {}),
          });
        }}
        onUploaded={() => void revalidator.revalidate()}
      />
    </Flex>
  );
}

/**
 * 「可见范围」字段（D-55）：新建时选「给组织看」还是「给自己看」，编辑时改它。
 *
 * 用 `Radio.Group` 而不是 `Select`：只有两个取值，而且**默认就是「给组织看」**——
 * 单选项把「另一种选择是什么」直接摆在眼前，不用点开才知道。
 * 两个抽屉共用这一个字段定义，列表的「可见范围」列也用同一份 `VISIBILITY_LABEL`。
 */
function VisibilityItem(): React.ReactElement {
  return (
    <Form.Item
      name="visibility"
      label="可见范围"
      rules={[{ required: true, message: "请选择可见范围" }]}
      tooltip="给自己看的文件只有你与本组织管理员能看到，也不会出现在同事的文件列表里"
    >
      <Radio.Group
        options={VISIBILITY_OPTIONS.map((option) => ({
          value: option.value,
          label: (
            <Space orientation="vertical" size={0}>
              <Typography.Text>{option.label}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {option.description}
              </Typography.Text>
            </Space>
          ),
        }))}
      />
    </Form.Item>
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

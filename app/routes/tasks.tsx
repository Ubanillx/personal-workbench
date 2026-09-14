import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useActionData, useLoaderData, useNavigation, useRevalidator, useSubmit } from "react-router";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  Progress,
  Select,
  Slider,
  Space,
  Statistic,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  type DescriptionsProps,
  type TableProps,
} from "antd";
import {
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  ImportOutlined,
  InboxOutlined,
  PlusOutlined,
  ReloadOutlined,
  RiseOutlined,
  RollbackOutlined,
  SendOutlined,
  UndoOutlined,
  UserSwitchOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import type { UserRole } from "../../shared/types/domain";
import { confirmAction, confirmDanger, RowActions, type RowAction } from "../components/crud-actions";
import { useCrudFeedback, useListParams, useServerTable } from "../components/crud-hooks";
import { FormDrawer } from "../components/crud-drawer";
import { SelectionAlert, TableToolbar } from "../components/crud-toolbar";
import { PageHeader } from "../components/page-header";
import { dataTable } from "../components/table-layout";
import { WecomImportDrawer } from "../components/wecom-import-drawer";
import { db, type User } from "../lib/db.server";
import { readPayload } from "../lib/form.server";
import { listAllAccounts, listMembers, listOrganizations } from "../lib/organization.server";
import { pagingOf, sortOf, type Paged } from "../lib/paging";
import { sortableKeys } from "../lib/paging.server";
import { assertOrgAccess } from "../lib/session.server";
import {
  addComment,
  approveTask,
  archiveTask,
  createTask,
  deleteTask,
  listActivity,
  markTaskNotificationsRead,
  reportProgress,
  restoreTask,
  returnTask,
  submitReview,
  updateTask,
  type ServiceResult,
} from "../lib/task-service.server";
import {
  canManageTasks,
  canView,
  DEFAULT_TASK_SORT,
  findTaskWithOrg,
  notifyOverdueTasks,
  TASK_SORTABLE,
  taskStats,
  visiblePage,
  type TaskFilters,
} from "../lib/tasks.server";
import { requireUserOrRedirect } from "../lib/ui.server";

/* ------------------------------------------------------------------ 视图类型与字典 */

type TaskRow = {
  id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  progress: number;
  dueDate: string | null;
  ownerId: string | null;
  ownerName?: string;
  createdBy: string;
  archivedAt: string | null;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
  /** 组织归属（VIEW 新增字段）：管理员合并视图里显示每行属于哪个组织（D-28） */
  orgId: string | null;
  orgName: string | null;
};
type ActivityRow = {
  id: string;
  kind: string;
  authorName: string | null;
  content: string;
  progress: number | null;
  createdAt: string;
};
/** 指派下拉的候选：admin 是全部账号，manager 是本组织成员加全局管理员 */
type Member = { id: string; name: string; role: UserRole; orgId: string | null; orgName: string | null; isActive: boolean };
type Me = { id: string; name: string; role: UserRole; orgId: string | null; orgName: string | null };
type OrgOption = { id: string; name: string; status: string };
type TaskFormValues = {
  title?: string;
  description?: string;
  priority?: string;
  ownerId?: string;
  dueDate?: dayjs.Dayjs | null;
  orgId?: string;
  isPrivate?: boolean;
};
/** 改派只动负责人，字段刻意只有一项：服务端 `updateTask` 会按 key 是否存在决定是否改 owner_id */
type ReassignFormValues = { ownerId?: string };
type ActionResult = { ok: true; notice: string } | { error: string };

const STATUS_LABEL: Record<string, string> = { todo: "待办", in_progress: "进行中", pending_review: "待验收", completed: "已完成" };
const STATUS_COLOR: Record<string, string> = { todo: "default", in_progress: "processing", pending_review: "gold", completed: "green" };
const PRIORITY_COLOR: Record<string, string> = { P0: "red", P1: "gold", P2: "default" };
const EVENT_LABEL: Record<string, string> = {
  task_created: "创建",
  task_reassigned: "改派",
  task_moved: "调整组织",
  task_submitted: "提交验收",
  task_approved: "验收通过",
  task_returned: "退回",
  task_archived: "归档",
  task_restored: "恢复",
};
const TIMELINE_COLOR: Record<string, string> = {
  task_approved: "green",
  task_returned: "red",
  task_archived: "gray",
  task_moved: "purple",
};
const PRIORITY_OPTIONS = [
  { value: "P0", label: "P0 · 最高" },
  { value: "P1", label: "P1 · 普通" },
  { value: "P2", label: "P2 · 较低" },
];
const STATUS_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "todo", label: "待办" },
  { value: "in_progress", label: "进行中" },
  { value: "pending_review", label: "待验收" },
  { value: "completed", label: "已完成" },
];
const RETURN_NOTE_DEFAULT = "请补充完成情况后重新提交";
const NOTICE: Record<string, string> = {
  create: "任务已创建",
  update: "任务已保存",
  progress: "进度已更新",
  "submit-review": "已提交验收",
  approve: "已通过验收",
  return: "已退回修改",
  archive: "任务已归档",
  restore: "任务已恢复",
  delete: "任务已彻底删除",
  comment: "评论已发送",
};

function toMember(row: Record<string, unknown>): Member {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    role: String(row.role ?? "member") as UserRole,
    orgId: row.orgId === null || row.orgId === undefined ? null : String(row.orgId),
    orgName: row.orgName === null || row.orgName === undefined ? null : String(row.orgName),
    isActive: Number(row.isActive) === 1,
  };
}

/**
 * 负责人候选（§14.3 指派规则）：
 * - admin：全部账号（跨组织，界面上按组织筛选，服务端仍要求负责人属于任务所在组织）。
 * - manager：本组织成员，另加全局管理员（管理员可以当负责人）。
 * - member：只能建给自己的任务，没有可选名单。
 */
function assigneeCandidates(user: User): Member[] {
  if (user.role === "admin") return listAllAccounts().map(toMember);
  if (user.role === "manager" && user.orgId) {
    const admins = listAllAccounts().filter((row) => row.role === "admin");
    return [...listMembers(user.orgId), ...admins].map(toMember);
  }
  return [];
}

/**
 * 多组织时用「姓名（管理员）」区分全局账号；同组织内只显示姓名。
 *
 * 判据必须是 **`role`**，不能是「没有组织」：`users` 的约束只要求「管理员不隶属组织」，
 * 反过来的「没有组织 ⇒ 管理员」并不成立——注册后还没入组、被移出组织、组织被解散（D-24/D-32/D-33）
 * 都会产生「role=member 且 org_id 为 NULL」的账号，按旧写法会把普通成员显示成「（管理员）」。
 */
function memberLabel(member: Member): string {
  return member.role === "admin" ? `${member.name}（管理员）` : member.name;
}

function isOverdue(task: TaskRow, today: string): boolean {
  return Boolean(task.dueDate && task.dueDate < today && task.status !== "completed" && !task.archivedAt);
}

/* ------------------------------------------------------------------ loader / action */

export async function loader({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  const url = new URL(request.url);
  const database = db();
  notifyOverdueTasks(database);
  const canManage = canManageTasks(user);
  const includeArchived = canManage && url.searchParams.get("archived") === "1";
  const status = url.searchParams.get("status") ?? undefined;
  const assignee = url.searchParams.get("assignee") ?? undefined;
  // 组织筛选器只给管理员（D-28）；其他人的组织范围由可见性条件锁死
  const org = user.role === "admin" ? (url.searchParams.get("org") ?? null) : null;
  const requestedRange = url.searchParams.get("range") ?? "all";
  const range = canManage && ["week", "month", "custom"].includes(requestedRange) ? requestedRange : "all";
  const today = dayjs().format("YYYY-MM-DD");
  const validDate = (value: string | null): string =>
    value && /^\d{4}-\d{2}-\d{2}$/.test(value) && dayjs(value).isValid() && dayjs(value).format("YYYY-MM-DD") === value ? value : "";
  const from =
    range === "custom"
      ? validDate(url.searchParams.get("from"))
      : range === "all"
        ? ""
        : dayjs()
            .subtract(range === "week" ? 7 : 30, "day")
            .format("YYYY-MM-DD");
  const to = range === "custom" ? validDate(url.searchParams.get("to")) : range === "all" ? "" : today;
  /**
   * 筛选、排序、分页**都在服务端**（口径见 app/lib/paging.ts）：URL 是唯一真相，loader 只回一页。
   * 同一份筛选条件也喂给 `taskStats()`——列表与统计必须是同一批数据的两个视图，
   * 否则「任务总数 / 完成率 / 已逾期」会随翻页变化。
   */
  const filters: TaskFilters = {
    includeArchived,
    status,
    assignee,
    orgFilter: org,
    keyword: url.searchParams.get("q") ?? undefined,
    from,
    to,
  };
  const paging = pagingOf(url.searchParams);
  const sort = sortOf(url.searchParams, sortableKeys(TASK_SORTABLE), DEFAULT_TASK_SORT);
  const taskId = url.searchParams.get("task");
  let selected: TaskRow | null = null;
  let selectedOrgId: string | null = null;
  let activity: ActivityRow[] = [];
  if (taskId) {
    const located = findTaskWithOrg(database, taskId);
    // 不存在、跨组织或无权查看：一律当作没这条任务，详情不展开（跨组织不返回 403，§4 不变式 1）
    if (located && assertOrgAccess(user, located.orgId) === null && canView(located.task, user)) {
      selected = located.task as unknown as TaskRow;
      selectedOrgId = located.orgId;
      const result = listActivity(user, taskId);
      activity = result.ok ? (result.data as unknown as ActivityRow[]) : [];
      // 打开任务即把该任务的通知标记为已读（与通知中心跳转的行为一致）
      markTaskNotificationsRead(user, taskId);
    }
  }
  return {
    user: user as Me,
    canManage,
    tasks: visiblePage(database, user, filters, paging, sort) as Paged<TaskRow>,
    stats: taskStats(database, user, filters, today),
    range,
    from,
    to,
    today,
    selected,
    selectedOrgId,
    activity,
    includeArchived,
    status: status ?? "all",
    assignee: assignee ?? "all",
    org: org ?? "",
    organizations: (user.role === "admin" ? listOrganizations(user) : []).map((item) => ({
      id: item.id,
      name: item.name,
      status: String(item.status),
    })) as OrgOption[],
    members: assigneeCandidates(user),
  };
}

/**
 * 任务写操作：全部转调 app/lib/task-service.server.ts（与 `/api/tasks*` 共用同一份实现）。
 * 页面只负责把 intent 映射到服务函数、并给出成功提示。批量动作逐条调用同一个服务函数，
 * 成功计数 + 失败原因汇总后再反馈——权限、组织边界、状态机仍由任务域把关。
 */
export async function action({ request }: { request: Request }): Promise<ActionResult> {
  const user = requireUserOrRedirect(request);
  const payload = await readPayload(request);
  const intent = String(payload.intent ?? "");
  const taskId = String(payload.taskId ?? "");
  const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : [];

  if (intent.startsWith("bulk-")) {
    if (!ids.length) return { error: "请先选择任务" };
    let succeeded = 0;
    const failures: string[] = [];
    for (const id of ids) {
      const result: ServiceResult<unknown> =
        intent === "bulk-archive" ? archiveTask(user, id) : intent === "bulk-restore" ? restoreTask(user, id) : deleteTask(user, id);
      if (result.ok) succeeded += 1;
      else failures.push(result.message);
    }
    if (!succeeded) return { error: failures[0] ?? "没有可处理的任务" };
    const verb = intent === "bulk-archive" ? "归档" : intent === "bulk-restore" ? "恢复" : "彻底删除";
    return { ok: true, notice: `已${verb} ${succeeded} 个任务${failures.length ? `，${failures.length} 个被跳过` : ""}` };
  }

  const result: ServiceResult<unknown> = (() => {
    switch (intent) {
      case "create":
        return createTask(user, payload);
      case "update":
        return updateTask(user, taskId, payload);
      case "progress":
        return reportProgress(user, taskId, { progress: payload.progress, note: payload.note ?? "" });
      case "submit-review":
        return submitReview(user, taskId, String(payload.note ?? "提交验收"));
      case "approve":
        return approveTask(user, taskId, String(payload.note ?? "验收通过"));
      case "return":
        return returnTask(user, taskId, { note: payload.note });
      case "archive":
        return archiveTask(user, taskId);
      case "restore":
        return restoreTask(user, taskId);
      case "delete":
        return deleteTask(user, taskId);
      case "comment":
        return addComment(user, taskId, payload);
      default:
        return { ok: false, code: "UNKNOWN", message: "未知操作", status: 400 };
    }
  })();

  return result.ok ? { ok: true, notice: NOTICE[intent] ?? "操作成功" } : { error: result.message };
}

/* ------------------------------------------------------------------ 页面 */

export default function TasksRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submit = useSubmit();
  const { modal, message } = AntdApp.useApp();
  const list = useListParams();
  const [createForm] = Form.useForm<TaskFormValues>();
  const [editForm] = Form.useForm<TaskFormValues>();
  const [reassignForm] = Form.useForm<ReassignFormValues>();
  const [createOpen, setCreateOpen] = useState(false);
  // 编辑 / 改派对象直接存整行数据（与 notes / todos / files 一致）：抽屉能立刻打开并回填，
  // 不必等详情抽屉那条 loader 往返；也避免「详情 + 表单」两个同侧抽屉同时挂在 DOM 上互相压层级。
  // 编辑与改派互斥（同一时刻只有一个非空），抽屉本身也拆成两个，职责单一。
  const [editingTask, setEditingTask] = useState<TaskRow | null>(null);
  const [reassigningTask, setReassigningTask] = useState<TaskRow | null>(null);
  // 企微导入抽屉：它产出的就是任务，所以入口挂在**本页页头**，不再单开一个导航页面
  const [importOpen, setImportOpen] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const { error } = useCrudFeedback(actionData, () => {
    setCreateOpen(false);
    setEditingTask(null);
    setReassigningTask(null);
    setSelectedKeys([]);
  });

  const me = data.user;
  const canManage = data.canManage;
  const isAdmin = me.role === "admin";
  const busy = navigation.state !== "idle" || revalidator.state !== "idle";
  const today = data.today;

  const keyword = list.get("q");
  const [draftKeyword, setDraftKeyword] = useState(keyword);
  useEffect(() => setDraftKeyword(keyword), [keyword]);

  // 搜索、筛选、排序、分页都在服务端：这里只渲染 loader 给的那一页，**不再在浏览器里过滤或排序**
  const rows = data.tasks.rows;
  const paging = useServerTable<TaskRow>(data.tasks);
  /**
   * 勾选只作用于**当前这一页**：分页之后客户端手里没有别的页的行，跨页勾选会让
   * 「批量归档选中的 3 个任务」这类动作失去判断依据（哪些已归档、哪些还在当前视图里）。
   * 于是列表参数一变就清空勾选；打开详情抽屉的 `?task=` 不是列表参数，不参与这个签名。
   */
  const listSignature = ["q", "status", "assignee", "org", "archived", "range", "from", "to", "page", "size", "sort", "order"]
    .map((key) => list.get(key))
    .join("|");
  useEffect(() => setSelectedKeys([]), [listSignature]);
  const selectedRows = useMemo(() => rows.filter((task) => selectedKeys.includes(task.id)), [rows, selectedKeys]);
  const archivedSelection = selectedRows.length > 0 && selectedRows.every((task) => Boolean(task.archivedAt));
  const activeSelection = selectedRows.filter((task) => !task.archivedAt);

  const post = (payload: Record<string, unknown>): void => {
    submit(payload as Parameters<typeof submit>[0], { method: "post", encType: "application/json" });
  };
  const openDetail = (task: TaskRow): void => list.patch({ task: task.id });
  const closeDetail = (): void => list.patch({ task: null });
  /**
   * 打开企微导入抽屉前先收起别的右侧抽屉（详情 / 编辑 / 改派）：
   * 同一时刻只挂一个右侧浮层，层级才可预期（见 CODE_STYLE §10.7 第 2 条）。
   */
  const openImport = (): void => {
    setEditingTask(null);
    setReassigningTask(null);
    if (list.get("task")) list.patch({ task: null });
    setImportOpen(true);
  };
  const filtered = Boolean(
    keyword || data.status !== "all" || data.assignee !== "all" || data.org || data.includeArchived || data.range !== "all",
  );
  const activeOrganizations = data.organizations.filter((org) => org.status === "active");
  /**
   * 编辑抽屉「所属组织」的候选：启用中的组织都可选，但**任务当前所属的组织**无论状态都要列进去——
   * 组织一旦解散，编辑这条任务时下拉里必须还能看到当前值（服务端只在「改到别的组织」时才校验组织是否启用）。
   */
  const editableOrganizations = useMemo(() => {
    const options = data.organizations.map((org) => ({
      value: org.id,
      label: org.status === "archived" ? `${org.name}（已解散）` : org.name,
    }));
    const current = editingTask?.orgId;
    if (current && !options.some((option) => option.value === current)) {
      options.unshift({ value: current, label: `${editingTask?.orgName ?? "当前组织"}（已解散）` });
    }
    return options;
  }, [data.organizations, editingTask]);
  /** 新建时的负责人候选：管理员按所选组织过滤（负责人必须属于任务所在组织） */
  const createOrgId = (Form.useWatch("orgId", createForm) as string | undefined) ?? "";
  const createAssigneePool = isAdmin
    ? data.members.filter((member) => member.role === "admin" || member.orgId === createOrgId)
    : data.members;
  const selectedTask = data.selected;
  // 改派的负责人候选：管理员按「任务所属组织」过滤（负责人必须属于任务所在组织）。
  // 用编辑 / 改派对象自己的 orgId，而不是详情那条记录的 orgId——抽屉一打开就是正确名单，不必等 loader。
  const formOrgId = editingTask?.orgId ?? reassigningTask?.orgId ?? data.selectedOrgId;
  const taskMembers = isAdmin ? data.members.filter((member) => member.role === "admin" || member.orgId === formOrgId) : data.members;

  const openEdit = (task: TaskRow): void => setEditingTask(task);
  const openReassign = (task: TaskRow): void => setReassigningTask(task);
  /**
   * 「所属组织」列只对管理员渲染（D-28 的合并视图要能看出每行属于哪个组织）。
   * 列头用与新建/编辑表单**逐字相同**的「所属组织」：同一个字段在列表与表单里只有一个说法（D-47）。
   */
  const orgColumn: NonNullable<TableProps<TaskRow>["columns"]> = [
    {
      title: "所属组织",
      dataIndex: "orgName",
      key: "orgName",
      width: 140,
      render: (_value, task) =>
        task.orgName ? <Tag color="blue">{task.orgName}</Tag> : <Typography.Text type="secondary">—</Typography.Text>,
    },
  ];

  const columns: TableProps<TaskRow>["columns"] = [
    {
      title: "任务",
      dataIndex: "title",
      key: "title",
      // 表头排序交给服务端（客户端比较器只能排当前这一页）：`sorter: true` 只负责画箭头，
      // 箭头状态与「点了排序」都由 useServerTable 受控（唯一真相是 URL 上的 ?sort=）
      sorter: true,
      sortOrder: paging.sortOrderOf("title"),
      render: (_value, task) => (
        // 这一列是表格里的「主内容列」：不写 width，吃掉剩余宽度（定宽布局会按比例分给它）。
        // 标题单行省略、说明两行省略，两者都带悬停全文——否则一条长说明会把整行撑高、把右边的列挤歪。
        <Space orientation="vertical" size={2} style={{ width: "100%" }}>
          <Flex align="center" gap={4} wrap style={{ width: "100%" }}>
            <Tooltip title={task.title.length > 20 ? task.title : ""}>
              <Button color="primary" variant="link" className="link-button" onClick={() => openDetail(task)}>
                {task.title}
              </Button>
            </Tooltip>
            <Tag color={PRIORITY_COLOR[task.priority] ?? "default"} variant="filled">
              {task.priority}
            </Tag>
            {task.isPrivate ? (
              <Tag color="purple" variant="filled">
                私密
              </Tag>
            ) : null}
            {isOverdue(task, today) ? (
              <Tag color="red" variant="filled">
                已逾期
              </Tag>
            ) : null}
            {task.archivedAt ? <Tag variant="filled">已归档</Tag> : null}
          </Flex>
          {task.description ? (
            // 说明是「副行」：单行省略 + 悬停全文（antd v6 的 `Text` 不再支持 rows，多行省略要用 Paragraph）
            <Typography.Text
              type="secondary"
              ellipsis={{ tooltip: task.description.length > 40 ? task.description : "" }}
              style={{ display: "block", maxWidth: "100%" }}
            >
              {task.description}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (_value, task) => (
        <Tag color={STATUS_COLOR[task.status] ?? "default"} variant="filled">
          {STATUS_LABEL[task.status] ?? task.status}
        </Tag>
      ),
    },
    {
      title: "负责人",
      dataIndex: "ownerName",
      key: "ownerName",
      width: 140,
      render: (_value, task) => task.ownerName ?? <Typography.Text type="secondary">未分配</Typography.Text>,
    },
    {
      title: "进度",
      dataIndex: "progress",
      key: "progress",
      width: 180,
      sorter: true,
      sortOrder: paging.sortOrderOf("progress"),
      render: (_value, task) => <Progress percent={task.progress} size="small" />,
    },
    {
      title: "截止日期",
      dataIndex: "dueDate",
      key: "dueDate",
      width: 130,
      sorter: true,
      sortOrder: paging.sortOrderOf("dueDate"),
      render: (_value, task) =>
        task.dueDate ? (
          <Typography.Text {...(isOverdue(task, today) ? { type: "danger" as const } : {})}>{task.dueDate}</Typography.Text>
        ) : (
          <Typography.Text type="secondary">未设置</Typography.Text>
        ),
    },
    {
      // 「更新时间范围」筛选器与默认排序真正作用的就是这一列（loader 里按 updated_at 过滤 + ORDER BY updated_at DESC）。
      // 以前列表只有「截止日期」列，筛选项落在用户看不见的字段上 —— 补上这一列，筛选字段与显示字段才对得上。
      title: "最近更新",
      dataIndex: "updatedAt",
      key: "updatedAt",
      width: 160,
      sorter: true,
      sortOrder: paging.sortOrderOf("updatedAt"),
      render: (_value, task) => (
        <Typography.Text type="secondary" title={dayjs(task.updatedAt).format("YYYY-MM-DD HH:mm")}>
          {dayjs(task.updatedAt).format("MM-DD HH:mm")}
        </Typography.Text>
      ),
    },
    ...(isAdmin ? orgColumn : []),
    {
      title: "操作",
      key: "actions",
      // 图标动作按钮每个约 36px（`size="small"` + `variant="text"`），最满的一行是
      // 详情 / 编辑 / 改派 / 提交验收 / 通过验收 / 退回修改 / 归档 = 7 个，留一点余量给换行
      width: canManage ? 300 : 120,
      align: "right",
      ellipsis: false,
      render: (_value, task) => {
        const isOwner = task.ownerId === me.id;
        const canReport = isOwner && !task.archivedAt && task.status !== "completed" && task.status !== "pending_review";
        const actions: RowAction[] = [
          {
            key: "detail",
            label: canReport ? "汇报进度" : "详情",
            icon: canReport ? <RiseOutlined /> : <EyeOutlined />,
            onClick: () => openDetail(task),
          },
        ];
        // 编辑 / 改派是**管理动作**：普通成员看不到（D-54 起成员能看到本组织全部非私密任务，
        // 这一列必须跟着收，否则一屏都是点不动的灰按钮）
        if (canManage) {
          actions.push({
            key: "edit",
            label: "编辑",
            icon: <EditOutlined />,
            disabled: Boolean(task.archivedAt),
            // 只开表单抽屉，不顺手把详情挂到 URL：编辑/改派是独立动作，不该顺带弹一次任务详情
            onClick: () => openEdit(task),
          });
          actions.push({
            key: "reassign",
            label: "改派",
            icon: <UserSwitchOutlined />,
            disabled: Boolean(task.archivedAt),
            onClick: () => openReassign(task),
          });
        }
        if (isOwner) {
          actions.push({
            key: "submit",
            label: "提交验收",
            icon: <SendOutlined />,
            disabled: Boolean(task.archivedAt) || task.status === "pending_review" || task.progress < 100,
            onClick: () =>
              confirmAction(modal, {
                title: "提交验收？",
                content: "提交后由管理员或组织管理者验收，期间不能再更新进度。",
                okText: "提交验收",
                onOk: () => post({ intent: "submit-review", taskId: task.id, note: "提交验收" }),
              }),
          });
        }
        if (canManage && task.status === "pending_review") {
          actions.push({
            key: "approve",
            label: "通过验收",
            icon: <CheckOutlined />,
            tone: "primary",
            onClick: () =>
              confirmAction(modal, {
                title: "确认通过验收？",
                content: "通过后任务状态变为「已完成」，进度锁定为 100%。",
                okText: "通过验收",
                onOk: () => post({ intent: "approve", taskId: task.id }),
              }),
          });
          actions.push({
            key: "return",
            label: "退回修改",
            icon: <RollbackOutlined />,
            onClick: () => {
              let reason = RETURN_NOTE_DEFAULT;
              modal.confirm({
                title: "退回修改",
                content: (
                  <Input.TextArea
                    rows={3}
                    defaultValue={RETURN_NOTE_DEFAULT}
                    maxLength={200}
                    onChange={(event) => (reason = event.target.value)}
                  />
                ),
                okText: "退回修改",
                cancelText: "取消",
                onOk: () => post({ intent: "return", taskId: task.id, note: reason }),
              });
            },
          });
        }
        if (canManage && !task.archivedAt) {
          actions.push({
            key: "archive",
            label: "归档任务",
            icon: <InboxOutlined />,
            onClick: () =>
              confirmAction(modal, {
                title: "归档该任务？",
                content: "归档后任务从列表隐藏（可勾选「显示归档」查看），之后可以恢复。",
                okText: "归档",
                onOk: () => post({ intent: "archive", taskId: task.id }),
              }),
          });
        }
        if (canManage && task.archivedAt) {
          actions.push({
            key: "restore",
            label: "恢复任务",
            icon: <UndoOutlined />,
            onClick: () => post({ intent: "restore", taskId: task.id }),
          });
          actions.push({
            key: "delete",
            label: "彻底删除",
            icon: <DeleteOutlined />,
            tone: "danger",
            onClick: () =>
              confirmDanger(modal, {
                title: `彻底删除「${task.title}」？`,
                content: "删除后连同评论与进度记录一并移除，无法恢复。",
                okText: "彻底删除",
                onOk: () => post({ intent: "delete", taskId: task.id }),
              }),
          });
        }
        return <RowActions actions={actions} disabled={busy} />;
      },
    },
  ];

  /**
   * 表格排版方案（自动省略 + 定宽排版）：`dataTable` 会补 `ellipsis` 并按列宽算出 `scroll.x`。
   * 用 `useMemo` 固定引用——`Table` 会因为每次都是新数组而重算列宽。
   */
  const table = useMemo(() => dataTable<TaskRow>({ columns, selectable: canManage }), [columns, canManage]);

  return (
    <Flex vertical gap="large" className="page-stack">
      <PageHeader
        title="任务进展"
        eyebrow="TASKS"
        help="本组织全部非私密任务对所有人可见；私密任务仅发布人、负责人与全局管理员可见。负责人只能汇报本人任务的进度。时间范围按最近更新时间筛选，统计与当前列表一致。企微导入的目标组织默认跟随下面的组织筛选器。"
        extra={
          <>
            <Button icon={<ImportOutlined />} onClick={openImport}>
              从企微导入
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => revalidator.revalidate()} loading={busy}>
              刷新
            </Button>
            <Button color="primary" variant="solid" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建任务
            </Button>
          </>
        }
      />

      {error ? <Alert type="error" showIcon title={error} /> : null}
      {list.get("task") && !selectedTask ? <Alert type="warning" showIcon title="该任务不存在，或你没有查看权限" /> : null}

      <Flex vertical gap="middle">
        <TableToolbar
          extra={
            <Typography.Text type="secondary">
              共 {data.tasks.total} 个任务{filtered ? "（已筛选）" : ""}
            </Typography.Text>
          }
        >
          {canManage ? (
            <>
              <Select
                aria-label="更新时间范围"
                value={data.range}
                options={[
                  { value: "all", label: "全部时间" },
                  { value: "week", label: "最近 7 天" },
                  { value: "month", label: "最近 30 天" },
                  { value: "custom", label: "自定义范围" },
                ]}
                style={{ width: 150 }}
                onChange={(value: string) => list.patch({ range: value === "all" ? null : value, from: null, to: null })}
              />
              {data.range === "custom" ? (
                <DatePicker.RangePicker
                  value={data.from && data.to ? [dayjs(data.from), dayjs(data.to)] : null}
                  style={{ maxWidth: "100%" }}
                  onChange={(values) =>
                    list.patch({ from: values?.[0]?.format("YYYY-MM-DD") ?? null, to: values?.[1]?.format("YYYY-MM-DD") ?? null })
                  }
                />
              ) : null}
            </>
          ) : null}
          <Input.Search
            allowClear
            placeholder="搜索任务标题或负责人"
            style={{ width: 240 }}
            value={draftKeyword}
            loading={busy}
            onChange={(event) => setDraftKeyword(event.target.value)}
            onSearch={(value) => list.patch({ q: value.trim() })}
          />
          <Select
            value={data.status}
            options={STATUS_OPTIONS}
            style={{ width: 140 }}
            onChange={(value: string) => list.patch({ status: value === "all" ? null : value })}
          />
          <Select
            value={data.assignee}
            style={{ width: 170 }}
            options={[
              { value: "all", label: "全部负责人" },
              { value: "mine", label: "我负责的" },
              { value: "unassigned", label: "未分配" },
              ...data.members.filter((member) => member.isActive).map((member) => ({ value: member.id, label: memberLabel(member) })),
            ]}
            onChange={(value: string) => list.patch({ assignee: value === "all" ? null : value })}
          />
          {isAdmin ? (
            <Select
              value={data.org || "all"}
              style={{ width: 180 }}
              options={[
                { value: "all", label: "全部组织" },
                ...data.organizations.map((org) => ({
                  value: org.id,
                  label: org.status === "archived" ? `${org.name}（已解散）` : org.name,
                })),
              ]}
              onChange={(value: string) => list.patch({ org: value === "all" ? null : value })}
            />
          ) : null}
          {canManage ? (
            <Checkbox checked={data.includeArchived} onChange={(event) => list.patch({ archived: event.target.checked ? "1" : null })}>
              显示归档
            </Checkbox>
          ) : null}
          {filtered ? (
            <Button color="default" variant="text" onClick={() => list.reset()}>
              重置
            </Button>
          ) : null}
        </TableToolbar>

        {canManage ? (
          <div className="task-summary" aria-label="任务统计">
            {/* 统计由服务端按同一套筛选条件算（页面手里只有一页，数 rows 会随翻页变化） */}
            <Statistic title="任务总数" value={data.stats.total} suffix="个" />
            <Statistic
              title="完成率"
              value={data.stats.total ? Math.round((data.stats.completed / data.stats.total) * 100) : 0}
              suffix="%"
            />
            <Statistic title="待验收" value={data.stats.pendingReview} suffix="个" />
            <Statistic title="已逾期" value={data.stats.overdue} suffix="个" styles={{ content: { color: "#cf1322" } }} />
          </div>
        ) : null}

        {canManage ? (
          <SelectionAlert count={selectedKeys.length} noun="个任务" onClear={() => setSelectedKeys([])}>
            {activeSelection.length ? (
              <Button
                size="small"
                onClick={() =>
                  confirmAction(modal, {
                    title: `归档选中的 ${activeSelection.length} 个任务？`,
                    content: "归档后从默认列表隐藏，可随时恢复。",
                    okText: "批量归档",
                    onOk: () => post({ intent: "bulk-archive", ids: activeSelection.map((task) => task.id) }),
                  })
                }
              >
                批量归档
              </Button>
            ) : null}
            {archivedSelection ? (
              <>
                <Button size="small" onClick={() => post({ intent: "bulk-restore", ids: selectedKeys })}>
                  批量恢复
                </Button>
                <Button
                  size="small"
                  color="danger"
                  variant="outlined"
                  onClick={() =>
                    confirmDanger(modal, {
                      title: `彻底删除选中的 ${selectedKeys.length} 个任务？`,
                      content: "删除后连同评论与进度记录一并移除，无法恢复。",
                      okText: "批量删除",
                      onOk: () => post({ intent: "bulk-delete", ids: selectedKeys }),
                    })
                  }
                >
                  批量删除
                </Button>
              </>
            ) : null}
          </SelectionAlert>
        ) : null}

        <Table<TaskRow>
          {...table}
          rowKey="id"
          size="middle"
          dataSource={rows}
          loading={busy}
          {...(canManage
            ? {
                rowSelection: {
                  selectedRowKeys: selectedKeys,
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
                    <Typography.Text strong>{filtered ? "没有符合条件的任务" : "暂无任务"}</Typography.Text>
                    <Typography.Text type="secondary">
                      {filtered ? "调整筛选条件，或重置后查看全部任务。" : "点击右上角「新建任务」派发第一条任务。"}
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

      {/* 表单抽屉（编辑 / 改派）开着时不挂详情抽屉：两个同侧抽屉叠在一起会互相盖住，也让层级变得不可预期 */}
      {selectedTask && !editingTask && !reassigningTask && !importOpen ? (
        <TaskDetailDrawer
          task={selectedTask}
          activity={data.activity}
          me={me}
          canManage={canManage}
          showOrg={isAdmin}
          busy={busy}
          onClose={closeDetail}
          onEdit={() => openEdit(selectedTask)}
          onReassign={() => openReassign(selectedTask)}
          onPost={post}
        />
      ) : null}

      <FormDrawer
        open={createOpen}
        title="新建任务"
        okText="创建任务"
        form={createForm}
        submitting={busy}
        error={error}
        width={620}
        initialValues={{
          priority: "P1",
          ownerId: "",
          // 与 /todos、/notes 一致：管理员建任务时的默认组织跟随页面上的组织筛选器（D-28 的接缝），
          // 否则在「贝塔组」筛选下新建，任务会落到第一个组织，建完就从当前列表里消失。
          orgId: data.org || activeOrganizations.at(0)?.id || "",
          isPrivate: false,
        }}
        onCancel={() => setCreateOpen(false)}
        onFinish={(values) => {
          const title = values.title?.trim();
          if (!title) return;
          post({
            intent: "create",
            title,
            description: values.description ?? "",
            priority: values.priority ?? "P1",
            ownerId: values.ownerId || "unassigned",
            dueDate: values.dueDate ? values.dueDate.format("YYYY-MM-DD") : null,
            isPrivate: Boolean(values.isPrivate),
            ...(isAdmin ? { orgId: values.orgId ?? "" } : {}),
          });
        }}
      >
        <Form.Item name="title" label="任务标题" rules={[{ required: true, message: "请输入任务标题" }]}>
          <Input placeholder="例如：整理 2026 秋季报价单" maxLength={120} />
        </Form.Item>
        <Form.Item name="description" label="任务说明">
          <Input.TextArea rows={3} maxLength={500} showCount placeholder="交付标准、背景信息（可选）" />
        </Form.Item>
        <Flex gap="middle" wrap>
          <Form.Item name="priority" label="优先级" style={{ minWidth: 160, flex: 1 }}>
            <Select options={PRIORITY_OPTIONS} />
          </Form.Item>
          <Form.Item name="dueDate" label="截止日期" style={{ minWidth: 160, flex: 1 }}>
            <DatePicker format="YYYY-MM-DD" style={{ width: "100%" }} placeholder="可选" />
          </Form.Item>
        </Flex>
        {isAdmin ? (
          <Form.Item name="orgId" label="所属组织" rules={[{ required: true, message: "请选择任务所属组织" }]}>
            <Select placeholder="请选择所属组织" options={activeOrganizations.map((org) => ({ value: org.id, label: org.name }))} />
          </Form.Item>
        ) : null}
        {canManage ? (
          <Flex gap="middle" wrap align="flex-end">
            <Form.Item name="ownerId" label="负责人" style={{ minWidth: 220, flex: 1 }}>
              <Select
                placeholder="未分配"
                showSearch={{ optionFilterProp: "label" }}
                options={[
                  { value: "", label: "未分配" },
                  ...createAssigneePool
                    .filter((member) => member.isActive)
                    .map((member) => ({ value: member.id, label: memberLabel(member) })),
                ]}
              />
            </Form.Item>
            <Form.Item name="isPrivate" label="私密任务" valuePropName="checked" tooltip="私密任务仅发布人、负责人与全局管理员可见">
              <Checkbox>仅发布人、负责人与全局管理员可见</Checkbox>
            </Form.Item>
          </Flex>
        ) : null}
      </FormDrawer>

      <FormDrawer
        open={editingTask !== null}
        title="编辑任务"
        form={editForm}
        submitting={busy}
        error={error}
        width={680}
        formKey={editingTask?.id ?? "none"}
        // 字段集与列表的列一一对应（D-47）：标题/说明/优先级/截止日期/所属组织/负责人/私密 都能在这里改，
        // 状态与进度由下面的「状态与进度」面板负责（它们是动作驱动的，不是自由字段）。
        initialValues={{
          title: editingTask?.title ?? "",
          description: editingTask?.description ?? "",
          priority: editingTask?.priority ?? "P1",
          dueDate: editingTask?.dueDate ? dayjs(editingTask.dueDate) : null,
          isPrivate: Boolean(editingTask?.isPrivate),
          ownerId: editingTask?.ownerId ?? "",
          orgId: editingTask?.orgId ?? "",
        }}
        onCancel={() => setEditingTask(null)}
        onFinish={(values) => {
          if (!editingTask) return;
          const title = values.title?.trim();
          if (!title) return;
          post({
            intent: "update",
            taskId: editingTask.id,
            title,
            description: values.description ?? "",
            priority: values.priority ?? editingTask.priority,
            dueDate: values.dueDate ? values.dueDate.format("YYYY-MM-DD") : null,
            isPrivate: Boolean(values.isPrivate),
            // 负责人：与列表的「负责人」列对应（改派抽屉仍在，是同一件事的快捷入口）
            ...(canManage ? { ownerId: values.ownerId || "unassigned" } : {}),
            // 所属组织：与列表的「组织」列对应，只有管理员能改（组织管理者提交了服务端也会拒）
            ...(isAdmin ? { orgId: values.orgId ?? "" } : {}),
          });
        }}
        afterForm={editingTask ? <TaskProgressPanel task={editingTask} me={me} canManage={canManage} busy={busy} onPost={post} /> : null}
      >
        <Form.Item name="title" label="任务标题" rules={[{ required: true, message: "请输入任务标题" }]}>
          <Input maxLength={120} />
        </Form.Item>
        <Form.Item name="description" label="任务说明">
          <Input.TextArea rows={3} maxLength={500} showCount />
        </Form.Item>
        <Flex gap="middle" wrap>
          <Form.Item name="priority" label="优先级" style={{ minWidth: 160, flex: 1 }}>
            <Select options={PRIORITY_OPTIONS} />
          </Form.Item>
          <Form.Item name="dueDate" label="截止日期" style={{ minWidth: 160, flex: 1 }}>
            <DatePicker format="YYYY-MM-DD" style={{ width: "100%" }} allowClear placeholder="未设置" />
          </Form.Item>
        </Flex>
        {isAdmin ? (
          <Form.Item
            name="orgId"
            label="所属组织"
            rules={[{ required: true, message: "请选择任务所属组织" }]}
            tooltip="只有管理员能改所属组织；换组织后负责人必须属于新组织，原组织的成员将不再看到该任务"
          >
            <Select options={editableOrganizations} />
          </Form.Item>
        ) : null}
        {canManage ? (
          <Form.Item name="ownerId" label="负责人" tooltip="直接改负责人等同于「改派」：会写入协作时间线，并通知原负责人与新负责人">
            <Select
              placeholder="未分配"
              showSearch={{ optionFilterProp: "label" }}
              options={[
                { value: "", label: "未分配" },
                ...taskMembers
                  // 已停用/已离开本组织的现任负责人也要显示出来，否则下拉里看不到当前值
                  .filter((member) => member.isActive || member.id === editingTask?.ownerId)
                  .map((member) => ({ value: member.id, label: memberLabel(member) })),
              ]}
            />
          </Form.Item>
        ) : null}
        <Form.Item
          name="isPrivate"
          label="私密任务"
          valuePropName="checked"
          tooltip="私密任务仅发布人、负责人与全局管理员可见；改这两项只限发布人或管理员"
        >
          <Checkbox>仅发布人、负责人与全局管理员可见</Checkbox>
        </Form.Item>
        {editingTask ? (
          <Descriptions
            size="small"
            column={2}
            items={[
              { key: "created", label: "创建时间", children: dayjs(editingTask.createdAt).format("YYYY-MM-DD HH:mm") },
              { key: "updated", label: "最近更新", children: dayjs(editingTask.updatedAt).format("YYYY-MM-DD HH:mm") },
            ]}
          />
        ) : null}
      </FormDrawer>

      {/* 改派单独一个抽屉：只改负责人，和服务端 updateTask 的「按 key 是否存在决定改不改 owner_id」一一对应 */}
      <FormDrawer
        open={reassigningTask !== null}
        title="改派负责人"
        okText="确认改派"
        form={reassignForm}
        submitting={busy}
        error={error}
        width={480}
        formKey={reassigningTask?.id ?? "none"}
        initialValues={{ ownerId: reassigningTask?.ownerId ?? "" }}
        onCancel={() => setReassigningTask(null)}
        onFinish={(values) => {
          if (!reassigningTask) return;
          // 只提交 ownerId：标题 / 说明 / 优先级 / 私密等字段由服务端回落到当前值，不会被这条请求改掉
          post({ intent: "update", taskId: reassigningTask.id, ownerId: values.ownerId || "unassigned" });
        }}
      >
        <Form.Item name="ownerId" label="负责人（改派会通知原负责人与新负责人）">
          <Select
            showSearch={{ optionFilterProp: "label" }}
            options={[
              { value: "", label: "未分配" },
              ...taskMembers.filter((member) => member.isActive).map((member) => ({ value: member.id, label: memberLabel(member) })),
            ]}
          />
        </Form.Item>
      </FormDrawer>

      {/*
        企微导入：写进的是任务，入口就在本页页头（不再单独占一个导航页面）。
        目标组织默认跟随页面上的组织筛选器（D-28 的接缝）；负责人候选与「新建任务」共用同一份 loader 名单；
        导入成功后关抽屉 + 提示 + revalidate，新任务当场出现在下面的列表里。
      */}
      <WecomImportDrawer
        open={importOpen}
        role={me.role}
        selfId={me.id}
        members={data.members}
        organizations={isAdmin ? activeOrganizations.map((org) => ({ id: org.id, name: org.name })) : []}
        defaultOrgId={isAdmin ? data.org || activeOrganizations.at(0)?.id || "" : ""}
        onClose={() => setImportOpen(false)}
        onImported={(created, skipped) => {
          setImportOpen(false);
          void message.success(`已从企微导入 ${created} 条任务${skipped ? `，跳过 ${skipped} 条疑似重复` : ""}`);
          void revalidator.revalidate();
        }}
      />
    </Flex>
  );
}

/* ------------------------------------------------------------------ 详情抽屉 */

/**
 * 任务详情抽屉：**只读展示 + 明确的动作按钮**。
 * 编辑 / 改派 / 验收 / 归档等写操作都从抽屉里触发对应的表单抽屉或确认框，抽屉本身不内嵌可编辑表单，
 * 避免「看着像详情、改了就提交」的误操作（旧实现把编辑表单直接铺在抽屉里）。
 */
function TaskDetailDrawer({
  task,
  activity,
  me,
  canManage,
  showOrg,
  busy,
  onClose,
  onEdit,
  onReassign,
  onPost,
}: {
  task: TaskRow;
  activity: ActivityRow[];
  me: Me;
  canManage: boolean;
  showOrg: boolean;
  busy: boolean;
  onClose: () => void;
  onEdit: () => void;
  onReassign: () => void;
  onPost: (payload: Record<string, unknown>) => void;
}): React.ReactElement {
  const { modal } = AntdApp.useApp();
  const today = dayjs().format("YYYY-MM-DD");

  const items: DescriptionsProps["items"] = [
    { key: "owner", label: "负责人", children: task.ownerName ?? "未分配" },
    {
      key: "status",
      label: "状态",
      children: (
        <Tag color={STATUS_COLOR[task.status] ?? "default"} variant="filled">
          {STATUS_LABEL[task.status] ?? task.status}
        </Tag>
      ),
    },
    {
      key: "priority",
      label: "优先级",
      children: (
        <Tag color={PRIORITY_COLOR[task.priority] ?? "default"} variant="filled">
          {task.priority}
        </Tag>
      ),
    },
    {
      key: "due",
      label: "截止日期",
      children: task.dueDate ? (
        <Typography.Text {...(isOverdue(task, today) ? { type: "danger" as const } : {})}>
          {task.dueDate}
          {isOverdue(task, today) ? "（已逾期）" : ""}
        </Typography.Text>
      ) : (
        "未设置"
      ),
    },
    { key: "created", label: "创建时间", children: dayjs(task.createdAt).format("YYYY-MM-DD HH:mm") },
    { key: "updated", label: "最近更新", children: dayjs(task.updatedAt).format("YYYY-MM-DD HH:mm") },
    ...(showOrg && task.orgName ? [{ key: "org", label: "所属组织", children: task.orgName, span: 2 }] : []),
    { key: "description", label: "任务说明", children: task.description || "—", span: 2 },
  ];

  return (
    <Drawer
      open
      placement="right"
      size={640}
      onClose={onClose}
      title={
        <Space orientation="vertical" size={0}>
          <Typography.Text type="secondary">任务详情</Typography.Text>
          <Typography.Text strong>{task.title}</Typography.Text>
        </Space>
      }
      extra={
        canManage && !task.archivedAt ? (
          <Space size="small">
            <Button icon={<EditOutlined />} onClick={onEdit} disabled={busy}>
              编辑
            </Button>
            <Button icon={<UserSwitchOutlined />} onClick={onReassign} disabled={busy}>
              改派
            </Button>
          </Space>
        ) : null
      }
    >
      <Flex vertical gap="middle" className="page-stack">
        {task.archivedAt ? <Alert type="warning" showIcon title="该任务已归档，恢复前不能更新进度或验收" /> : null}

        <Descriptions size="small" column={2} items={items} />

        {/* 状态与进度：与编辑抽屉共用同一个面板（列表「状态」「进度」两列在这两个抽屉里都有对应字段与入口） */}
        <TaskProgressPanel task={task} me={me} canManage={canManage} busy={busy} onPost={onPost} />

        {canManage ? (
          <Space wrap size="small">
            {task.archivedAt ? (
              <>
                <Button icon={<UndoOutlined />} disabled={busy} onClick={() => onPost({ intent: "restore", taskId: task.id })}>
                  恢复任务
                </Button>
                <Button
                  color="danger"
                  variant="outlined"
                  icon={<DeleteOutlined />}
                  disabled={busy}
                  onClick={() =>
                    confirmDanger(modal, {
                      title: `彻底删除「${task.title}」？`,
                      content: "删除后连同评论与进度记录一并移除，无法恢复。",
                      okText: "彻底删除",
                      onOk: () => onPost({ intent: "delete", taskId: task.id }),
                    })
                  }
                >
                  彻底删除
                </Button>
              </>
            ) : (
              <Button
                icon={<InboxOutlined />}
                disabled={busy}
                onClick={() =>
                  confirmAction(modal, {
                    title: "归档该任务？",
                    content: "归档后任务从列表隐藏（可勾选「显示归档」查看），之后可以恢复。",
                    okText: "归档",
                    onOk: () => onPost({ intent: "archive", taskId: task.id }),
                  })
                }
              >
                归档任务
              </Button>
            )}
          </Space>
        ) : null}

        <Card variant="outlined" size="small" title="协作时间线">
          {activity.length ? (
            <Timeline
              items={activity.map((item) => ({
                key: `${item.kind}-${item.id}`,
                title: dayjs(item.createdAt).format("YYYY-MM-DD HH:mm"),
                color: TIMELINE_COLOR[item.kind] ?? "blue",
                content: (
                  <Space orientation="vertical" size={2} className="list-block">
                    <Typography.Text strong>
                      {item.authorName ?? "系统"}
                      {EVENT_LABEL[item.kind] ? ` · ${EVENT_LABEL[item.kind]}` : ""}
                    </Typography.Text>
                    <Typography.Text>
                      {item.content}
                      {item.progress !== null ? `（${item.progress}%）` : ""}
                    </Typography.Text>
                  </Space>
                ),
              }))}
            />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无记录" />
          )}
        </Card>

        <CommentBox taskId={task.id} busy={busy} onPost={onPost} />
      </Flex>
    </Drawer>
  );
}

/**
 * 「状态与进度」面板：**详情抽屉与编辑抽屉共用同一份实现**（写操作只有一处，不会两套口径）。
 *
 * 为什么状态/进度不做成可自由填写的表单字段：它们不是元信息，而是被动作驱动的状态机——
 * 进度只能由负责人本人汇报（`reportProgress`），状态由进度与验收推导
 * （`submitReview` / `approveTask` / `returnTask`；`PATCH /api/tasks/:id` 明确拒绝 status/progress，见契约用例
 * `tasks.patch.managerA.reject-progress`）。因此这里把「当前值」只读展示，把**当前允许的流转**平铺成按钮：
 * 列表上能看到的「状态」「进度」两列，在 CRUD 抽屉里都能看到、并且都有合法的修改入口。
 */
function TaskProgressPanel({
  task,
  me,
  canManage,
  busy,
  onPost,
}: {
  task: TaskRow;
  me: Me;
  canManage: boolean;
  busy: boolean;
  onPost: (payload: Record<string, unknown>) => void;
}): React.ReactElement {
  const { modal } = AntdApp.useApp();
  const isOwner = task.ownerId === me.id;
  const canReport = isOwner && !task.archivedAt && task.status !== "completed" && task.status !== "pending_review";
  const pending = task.status === "pending_review";
  return (
    <>
      <Card variant="outlined" size="small" title="状态与进度">
        <Flex vertical gap="small">
          <Descriptions
            size="small"
            column={2}
            items={[
              {
                key: "status",
                label: "状态",
                children: (
                  <Tag color={STATUS_COLOR[task.status] ?? "default"} variant="filled">
                    {STATUS_LABEL[task.status] ?? task.status}
                  </Tag>
                ),
              },
              { key: "progress", label: "进度", children: `${task.progress}%` },
            ]}
          />
          <Progress percent={task.progress} status={task.status === "completed" ? "success" : "active"} />
          <Typography.Text type="secondary">
            状态由进度与验收驱动：负责人把进度汇报到 100% 后提交验收，管理员或组织管理者通过即完成。
          </Typography.Text>
          {pending ? (
            <Typography.Text type="secondary">
              {isOwner ? "你已提交验收，等待处理。如需继续完善，可联系管理员退回。" : "已提交验收，等待管理员或组织管理者处理。"}
            </Typography.Text>
          ) : null}
          {pending && canManage ? (
            <Space wrap size="small">
              <Button
                color="primary"
                variant="solid"
                icon={<CheckOutlined />}
                disabled={busy}
                onClick={() =>
                  confirmAction(modal, {
                    title: "确认通过验收？",
                    content: "通过后任务状态变为「已完成」，进度锁定为 100%。",
                    okText: "通过验收",
                    onOk: () => onPost({ intent: "approve", taskId: task.id }),
                  })
                }
              >
                通过验收
              </Button>
              <Button
                icon={<RollbackOutlined />}
                disabled={busy}
                onClick={() => {
                  let reason = RETURN_NOTE_DEFAULT;
                  modal.confirm({
                    title: "退回修改",
                    content: (
                      <Input.TextArea
                        rows={3}
                        defaultValue={RETURN_NOTE_DEFAULT}
                        maxLength={200}
                        onChange={(event) => (reason = event.target.value)}
                      />
                    ),
                    okText: "退回修改",
                    cancelText: "取消",
                    onOk: () => onPost({ intent: "return", taskId: task.id, note: reason }),
                  });
                }}
              >
                退回修改
              </Button>
            </Space>
          ) : null}
          {isOwner && !pending && task.status !== "completed" && !task.archivedAt ? (
            <Button
              icon={<SendOutlined />}
              disabled={busy || task.progress < 100}
              onClick={() =>
                confirmAction(modal, {
                  title: "提交验收？",
                  content: "提交后由管理员或组织管理者验收，期间不能再更新进度。",
                  okText: "提交验收",
                  onOk: () => onPost({ intent: "submit-review", taskId: task.id, note: "提交验收" }),
                })
              }
            >
              提交验收{task.progress < 100 ? "（需先到 100%）" : ""}
            </Button>
          ) : null}
        </Flex>
      </Card>

      {canReport ? <ProgressReporter task={task} busy={busy} onPost={onPost} /> : null}
    </>
  );
}

/** 进度汇报：只有负责人本人可见；滑杆 + 说明一起提交（服务端会写一条进度日志） */
function ProgressReporter({
  task,
  busy,
  onPost,
}: {
  task: TaskRow;
  busy: boolean;
  onPost: (payload: Record<string, unknown>) => void;
}): React.ReactElement {
  const [form] = Form.useForm<{ progress: number; note?: string }>();
  const progress = (Form.useWatch("progress", form) as number | undefined) ?? task.progress;
  const note = Form.useWatch("note", form) as string | undefined;
  return (
    <Card variant="outlined" size="small" title="汇报进度">
      <Form
        form={form}
        layout="vertical"
        initialValues={{ progress: task.progress, note: "" }}
        onFinish={(values: { progress?: number; note?: string }) => {
          const next = values.progress ?? task.progress;
          const trimmed = values.note?.trim() ?? "";
          if (next === task.progress && !trimmed) return;
          onPost({ intent: "progress", taskId: task.id, progress: next, ...(trimmed ? { note: trimmed } : {}) });
        }}
      >
        <Form.Item name="progress" label={`当前进度：${progress}%`} style={{ marginBottom: 12 }}>
          <Slider min={0} max={100} marks={{ 0: "0%", 50: "50%", 100: "100%" }} />
        </Form.Item>
        <Flex gap="small" align="flex-end" wrap>
          <Form.Item name="note" label="进展说明" style={{ flex: 1, minWidth: 220, marginBottom: 0 }}>
            <Input placeholder="可选：这一轮做了什么" maxLength={200} />
          </Form.Item>
          <Button
            color="primary"
            variant="solid"
            htmlType="submit"
            icon={<CheckOutlined />}
            disabled={busy || (progress === task.progress && !note?.trim())}
          >
            保存进度
          </Button>
        </Flex>
      </Form>
    </Card>
  );
}

/** 评论框：所有能看到任务的人都能留言，写进同一条协作时间线 */
function CommentBox({
  taskId,
  busy,
  onPost,
}: {
  taskId: string;
  busy: boolean;
  onPost: (payload: Record<string, unknown>) => void;
}): React.ReactElement {
  const [form] = Form.useForm<{ comment?: string }>();
  return (
    <Form
      form={form}
      onFinish={(values: { comment?: string }) => {
        const comment = values.comment?.trim();
        if (!comment || busy) return;
        onPost({ intent: "comment", taskId, content: comment });
        form.resetFields();
      }}
    >
      <Flex gap="small" align="center">
        <Form.Item name="comment" style={{ flex: 1, marginBottom: 0 }}>
          <Input placeholder="添加评论（会通知任务参与者）" maxLength={500} allowClear />
        </Form.Item>
        <Form.Item style={{ marginBottom: 0 }}>
          <Tooltip title="发送评论">
            <Button color="primary" variant="solid" htmlType="submit" icon={<SendOutlined />} disabled={busy} />
          </Tooltip>
        </Form.Item>
      </Flex>
    </Form>
  );
}

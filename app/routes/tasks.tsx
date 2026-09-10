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
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  type DescriptionsProps,
  type MenuProps,
  type TableProps,
} from "antd";
import {
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  InboxOutlined,
  PlusOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SendOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import type { UserRole } from "../../shared/types/domain";
import { confirmAction, confirmDanger, RowActions } from "../components/crud-actions";
import { useCrudFeedback, useListParams } from "../components/crud-hooks";
import { FormModal } from "../components/crud-modal";
import { SelectionAlert, TableToolbar } from "../components/crud-toolbar";
import { PageHeader } from "../components/page-header";
import { db, type User } from "../lib/db.server";
import { readPayload } from "../lib/form.server";
import { listAllAccounts, listMembers, listOrganizations } from "../lib/organization.server";
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
import { canManageTasks, canView, findTaskWithOrg, notifyOverdueTasks, visible } from "../lib/tasks.server";
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
type ActionResult = { ok: true; notice: string } | { error: string };

const STATUS_LABEL: Record<string, string> = { todo: "待办", in_progress: "进行中", pending_review: "待验收", completed: "已完成" };
const STATUS_COLOR: Record<string, string> = { todo: "default", in_progress: "processing", pending_review: "gold", completed: "green" };
const PRIORITY_COLOR: Record<string, string> = { P0: "red", P1: "gold", P2: "default" };
const EVENT_LABEL: Record<string, string> = {
  task_created: "创建",
  task_reassigned: "改派",
  task_submitted: "提交验收",
  task_approved: "验收通过",
  task_returned: "退回",
  task_archived: "归档",
  task_restored: "恢复",
};
const TIMELINE_COLOR: Record<string, string> = { task_approved: "green", task_returned: "red", task_archived: "gray" };
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

/** 多组织时用「姓名（管理员）」区分全局账号；同组织内只显示姓名 */
function memberLabel(member: Member): string {
  return member.orgId ? member.name : `${member.name}（管理员）`;
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
  const tasks = visible(database, user, includeArchived, status, assignee, org) as unknown as TaskRow[];
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
    tasks,
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
  const { modal } = AntdApp.useApp();
  const list = useListParams();
  const [createForm] = Form.useForm<TaskFormValues>();
  const [editForm] = Form.useForm<TaskFormValues>();
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const { error } = useCrudFeedback(actionData, () => {
    setCreateOpen(false);
    setEditOpen(false);
    setSelectedKeys([]);
  });

  const me = data.user;
  const canManage = data.canManage;
  const isAdmin = me.role === "admin";
  const busy = navigation.state !== "idle";
  const today = dayjs().format("YYYY-MM-DD");

  const keyword = list.get("q");
  const [draftKeyword, setDraftKeyword] = useState(keyword);
  useEffect(() => setDraftKeyword(keyword), [keyword]);

  const rows = useMemo(
    () => (keyword ? data.tasks.filter((task) => task.title.includes(keyword) || (task.ownerName ?? "").includes(keyword)) : data.tasks),
    [data.tasks, keyword],
  );
  const selectedRows = useMemo(() => rows.filter((task) => selectedKeys.includes(task.id)), [rows, selectedKeys]);
  const archivedSelection = selectedRows.length > 0 && selectedRows.every((task) => Boolean(task.archivedAt));
  const activeSelection = selectedRows.filter((task) => !task.archivedAt);

  const post = (payload: Record<string, unknown>): void => {
    submit(payload as Parameters<typeof submit>[0], { method: "post", encType: "application/json" });
  };
  const openDetail = (task: TaskRow): void => list.patch({ task: task.id });
  const closeDetail = (): void => list.patch({ task: null });
  const filtered = Boolean(keyword || data.status !== "all" || data.assignee !== "all" || data.org || data.includeArchived);
  const activeOrganizations = data.organizations.filter((org) => org.status === "active");
  /** 新建时的负责人候选：管理员按所选组织过滤（负责人必须属于任务所在组织） */
  const createOrgId = (Form.useWatch("orgId", createForm) as string | undefined) ?? "";
  const createAssigneePool = isAdmin
    ? data.members.filter((member) => member.role === "admin" || member.orgId === createOrgId)
    : data.members;
  const selectedTask = data.selected;
  const detailMembers = isAdmin
    ? data.members.filter((member) => member.role === "admin" || member.orgId === data.selectedOrgId)
    : data.members;

  const openEdit = (): void => setEditOpen(true);
  /** 组织列只对管理员渲染（D-28 的合并视图要能看出每行属于哪个组织） */
  const orgColumn: NonNullable<TableProps<TaskRow>["columns"]> = [
    {
      title: "组织",
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
      sorter: (a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"),
      render: (_value, task) => (
        <Space orientation="vertical" size={2} style={{ width: "100%" }}>
          <Space size={4} wrap>
            <Button color="primary" variant="link" className="link-button" onClick={() => openDetail(task)}>
              {task.title}
            </Button>
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
          </Space>
          {task.description ? (
            <Typography.Text type="secondary" ellipsis>
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
      filters: Object.entries(STATUS_LABEL).map(([value, text]) => ({ text, value })),
      onFilter: (value, task) => task.status === value,
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
      sorter: (a, b) => a.progress - b.progress,
      render: (_value, task) => <Progress percent={task.progress} size="small" />,
    },
    {
      title: "截止日期",
      dataIndex: "dueDate",
      key: "dueDate",
      width: 130,
      sorter: (a, b) => String(a.dueDate ?? "9999").localeCompare(String(b.dueDate ?? "9999")),
      render: (_value, task) =>
        task.dueDate ? (
          <Typography.Text {...(isOverdue(task, today) ? { type: "danger" as const } : {})}>{task.dueDate}</Typography.Text>
        ) : (
          <Typography.Text type="secondary">未设置</Typography.Text>
        ),
    },
    ...(isAdmin ? orgColumn : []),
    {
      title: "操作",
      key: "actions",
      width: 180,
      align: "right",
      render: (_value, task) => {
        const isOwner = task.ownerId === me.id;
        const canReport = isOwner && !task.archivedAt && task.status !== "completed" && task.status !== "pending_review";
        const items: MenuProps["items"] = [
          { key: "detail", label: "查看详情", onClick: () => openDetail(task) },
          {
            key: "edit",
            label: "编辑 / 改派",
            icon: <EditOutlined />,
            disabled: !canManage || Boolean(task.archivedAt),
            onClick: () => {
              openDetail(task);
              openEdit();
            },
          },
          ...(isOwner
            ? [
                {
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
                },
              ]
            : []),
          ...(canManage && task.status === "pending_review"
            ? [
                {
                  key: "approve",
                  label: "通过验收",
                  icon: <CheckOutlined />,
                  onClick: () =>
                    confirmAction(modal, {
                      title: "确认通过验收？",
                      content: "通过后任务状态变为「已完成」，进度锁定为 100%。",
                      okText: "通过验收",
                      onOk: () => post({ intent: "approve", taskId: task.id }),
                    }),
                },
                {
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
                },
              ]
            : []),
          { type: "divider" },
          ...(canManage && !task.archivedAt
            ? [
                {
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
                },
              ]
            : []),
          ...(canManage && task.archivedAt
            ? [
                {
                  key: "restore",
                  label: "恢复任务",
                  icon: <UndoOutlined />,
                  onClick: () => post({ intent: "restore", taskId: task.id }),
                },
                {
                  key: "delete",
                  label: "彻底删除",
                  danger: true,
                  icon: <DeleteOutlined />,
                  onClick: () =>
                    confirmDanger(modal, {
                      title: `彻底删除「${task.title}」？`,
                      content: "删除后连同评论与进度记录一并移除，无法恢复。",
                      okText: "彻底删除",
                      onOk: () => post({ intent: "delete", taskId: task.id }),
                    }),
                },
              ]
            : []),
        ];
        return (
          <RowActions
            extra={
              <Button size="small" color="default" variant="text" onClick={() => openDetail(task)}>
                {canReport ? "汇报进度" : "详情"}
              </Button>
            }
            items={items}
            disabled={busy}
          />
        );
      },
    },
  ];

  return (
    <Flex vertical gap="large" className="page-stack">
      <PageHeader
        title="任务进展"
        description="分配任务，跟进进度与验收。"
        extra={
          <>
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

      <Card variant="outlined">
        <Flex vertical gap="middle">
          <TableToolbar
            extra={
              <Typography.Text type="secondary">
                共 {rows.length} 个任务{filtered ? "（已筛选）" : ""}
              </Typography.Text>
            }
          >
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
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={rows}
            loading={busy}
            scroll={{ x: isAdmin ? 1180 : 1040 }}
            {...(canManage
              ? {
                  rowSelection: {
                    selectedRowKeys: selectedKeys,
                    preserveSelectedRowKeys: true,
                    onChange: (keys: React.Key[]) => setSelectedKeys(keys),
                  },
                }
              : {})}
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
      </Card>

      {selectedTask ? (
        <TaskDetailDrawer
          task={selectedTask}
          activity={data.activity}
          me={me}
          canManage={canManage}
          showOrg={isAdmin}
          busy={busy}
          onClose={closeDetail}
          onEdit={openEdit}
          onPost={post}
        />
      ) : null}

      <FormModal
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
          orgId: activeOrganizations.at(0)?.id ?? "",
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
            <Form.Item name="isPrivate" label="私密任务" valuePropName="checked" tooltip="私密任务只有创建者本人与管理员可见">
              <Checkbox>仅创建者与管理员可见</Checkbox>
            </Form.Item>
          </Flex>
        ) : null}
      </FormModal>

      <FormModal
        open={editOpen && selectedTask !== null}
        title="编辑任务"
        form={editForm}
        submitting={busy}
        error={error}
        width={620}
        formKey={selectedTask?.id ?? "none"}
        initialValues={{
          title: selectedTask?.title ?? "",
          description: selectedTask?.description ?? "",
          priority: selectedTask?.priority ?? "P1",
          ownerId: selectedTask?.ownerId ?? "",
          dueDate: selectedTask?.dueDate ? dayjs(selectedTask.dueDate) : null,
          isPrivate: Boolean(selectedTask?.isPrivate),
        }}
        onCancel={() => setEditOpen(false)}
        onFinish={(values) => {
          if (!selectedTask) return;
          const title = values.title?.trim();
          if (!title) return;
          post({
            intent: "update",
            taskId: selectedTask.id,
            title,
            description: values.description ?? "",
            priority: values.priority ?? selectedTask.priority,
            ownerId: values.ownerId || "unassigned",
            dueDate: values.dueDate ? values.dueDate.format("YYYY-MM-DD") : null,
            isPrivate: Boolean(values.isPrivate),
          });
        }}
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
        <Form.Item name="ownerId" label="负责人（改派会通知双方）">
          <Select
            showSearch={{ optionFilterProp: "label" }}
            options={[
              { value: "", label: "未分配" },
              ...detailMembers.filter((member) => member.isActive).map((member) => ({ value: member.id, label: memberLabel(member) })),
            ]}
          />
        </Form.Item>
        <Form.Item name="isPrivate" label="私密任务" valuePropName="checked" tooltip="私密任务只有创建者本人与管理员可见">
          <Checkbox>仅创建者与管理员可见</Checkbox>
        </Form.Item>
      </FormModal>
    </Flex>
  );
}

/* ------------------------------------------------------------------ 详情抽屉 */

/**
 * 任务详情抽屉：**只读展示 + 明确的动作按钮**。
 * 编辑、验收、归档等写操作都从抽屉里触发对应的弹窗/确认，抽屉本身不内嵌可编辑表单，
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
  onPost: (payload: Record<string, unknown>) => void;
}): React.ReactElement {
  const { modal } = AntdApp.useApp();
  const today = dayjs().format("YYYY-MM-DD");
  const isOwner = task.ownerId === me.id;
  const canReport = isOwner && !task.archivedAt && task.status !== "completed" && task.status !== "pending_review";

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
          <Button icon={<EditOutlined />} onClick={onEdit} disabled={busy}>
            编辑
          </Button>
        ) : null
      }
    >
      <Flex vertical gap="middle" className="page-stack">
        {task.archivedAt ? <Alert type="warning" showIcon title="该任务已归档，恢复前不能更新进度或验收" /> : null}

        <Descriptions size="small" column={2} items={items} />

        <Card variant="outlined" size="small" title="完成进度">
          <Flex vertical gap="small">
            <Progress percent={task.progress} status={task.status === "completed" ? "success" : "active"} />
            {task.status === "pending_review" ? (
              <Typography.Text type="secondary">已提交验收，等待管理员或组织管理者处理。</Typography.Text>
            ) : null}
          </Flex>
        </Card>

        {canReport ? <ProgressReporter task={task} busy={busy} onPost={onPost} /> : null}

        {(canManage && task.status === "pending_review") || (isOwner && task.status === "pending_review") ? (
          <Card variant="outlined" size="small" title="验收处理">
            <Space wrap size="small">
              {isOwner ? (
                <Typography.Text type="secondary">你已提交验收，等待处理。如需继续完善，可联系管理员退回。</Typography.Text>
              ) : null}
              {canManage ? (
                <>
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
                </>
              ) : null}
            </Space>
          </Card>
        ) : null}

        {isOwner && task.status !== "pending_review" && task.status !== "completed" && !task.archivedAt ? (
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

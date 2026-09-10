import type React from "react";
import { useActionData, useLoaderData, useNavigation, useSearchParams, useSubmit } from "react-router";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Drawer,
  Empty,
  Form,
  Input,
  Listy,
  Popconfirm,
  Progress,
  Select,
  Slider,
  Space,
  Tag,
  Timeline,
  Typography,
} from "antd";
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { UserRole } from "../../shared/types/domain";
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

const labels: Record<string, string> = { todo: "待办", in_progress: "进行中", pending_review: "待验收", completed: "已完成" };
const eventLabels: Record<string, string> = {
  task_created: "创建",
  task_reassigned: "改派",
  task_submitted: "提交验收",
  task_approved: "验收通过",
  task_returned: "退回",
  task_archived: "归档",
  task_restored: "恢复",
};
const timelineColors: Record<string, string> = { task_approved: "green", task_returned: "red", task_archived: "gray" };
const priorityOptions = [
  { value: "P0", label: "P0" },
  { value: "P1", label: "P1" },
  { value: "P2", label: "P2" },
];
const statusOptions = [
  { value: "all", label: "全部状态" },
  { value: "todo", label: "待办" },
  { value: "in_progress", label: "进行中" },
  { value: "pending_review", label: "待验收" },
  { value: "completed", label: "已完成" },
];
const RETURN_NOTE_DEFAULT = "请补充完成情况后重新提交";

type TaskRowView = {
  id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  progress: number;
  dueDate: string | null;
  ownerId: string | null;
  ownerName?: string;
  archivedAt: string | null;
  isPrivate: boolean;
  /** 组织归属（toTaskView 新增字段）：管理员合并视图里显示每行属于哪个组织（D-28） */
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
 * - admin：全部账号（跨组织，界面上按组织筛选，服务端仍要求负责人属于任务所在组织）；
 * - manager：本组织成员，另加全局管理员（管理员可以当负责人）；
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
  const tasks = visible(database, user, includeArchived, status, assignee, org) as unknown as TaskRowView[];
  const taskId = url.searchParams.get("task");
  let selected: TaskRowView | null = null;
  let selectedOrgId: string | null = null;
  let activity: ActivityRow[] = [];
  if (taskId) {
    const located = findTaskWithOrg(database, taskId);
    // 不存在、跨组织或无权查看：一律当作没这条任务，详情不展开（跨组织不返回 403，§4 不变式 1）
    if (located && assertOrgAccess(user, located.orgId) === null && canView(located.task, user)) {
      selected = located.task as unknown as TaskRowView;
      selectedOrgId = located.orgId;
      const result = listActivity(user, taskId);
      activity = result.ok ? (result.data as unknown as ActivityRow[]) : [];
      // 打开任务即把该任务的通知标记为已读（旧 UI 在打开详情时做同一件事）
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

function toActionResult(result: ServiceResult<unknown>): { error: string } | { ok: true } {
  return result.ok ? { ok: true } : { error: result.message };
}

export async function action({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  const payload = await readPayload(request);
  const intent = String(payload.intent ?? "");
  const taskId = String(payload.taskId ?? "");
  switch (intent) {
    case "create":
      return toActionResult(createTask(user, payload));
    case "update":
      return toActionResult(updateTask(user, taskId, payload));
    case "progress":
      return toActionResult(reportProgress(user, taskId, { progress: payload.progress, note: payload.note ?? "" }));
    case "submit-review":
      return toActionResult(submitReview(user, taskId, String(payload.note ?? "提交验收")));
    case "approve":
      return toActionResult(approveTask(user, taskId, String(payload.note ?? "验收通过")));
    case "return":
      return toActionResult(returnTask(user, taskId, { note: payload.note }));
    case "archive":
      return toActionResult(archiveTask(user, taskId));
    case "restore":
      return toActionResult(restoreTask(user, taskId));
    case "delete":
      return toActionResult(deleteTask(user, taskId));
    case "comment":
      return toActionResult(addComment(user, taskId, payload));
    default:
      return { error: "未知操作" };
  }
}

export default function TasksRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const [params, setParams] = useSearchParams();
  const error = actionData && "error" in actionData ? actionData.error : "";
  const me = data.user;
  const canManage = data.canManage;
  const isAdmin = me.role === "admin";
  const busy = navigation.state !== "idle";
  const selected = data.selected;
  const [createForm] = Form.useForm();
  /** 管理员建任务要先选组织（管理员不隶属组织），负责人候选按所选组织过滤 */
  const createOrgId = (Form.useWatch("orgId", createForm) as string | undefined) ?? "";
  const createAssigneePool = isAdmin
    ? data.members.filter((member) => member.role === "admin" || member.orgId === createOrgId)
    : data.members;

  const updateParams = (changes: Record<string, string | null>): void => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  const activeOrganizations = data.organizations.filter((org) => org.status === "active");

  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <Space orientation="vertical" size={0}>
        <Typography.Text type="secondary">WORK</Typography.Text>
        <Typography.Title level={3} className="page-title">
          任务进展
        </Typography.Title>
        <Typography.Text type="secondary">派发、进度、验收和沟通都保留在同一条时间线中。</Typography.Text>
      </Space>

      <Form
        form={createForm}
        layout="inline"
        className="quick-add"
        initialValues={{ priority: "P1", ownerId: "", orgId: activeOrganizations[0]?.id ?? "" }}
        onFinish={(values: { title?: string; priority?: string; ownerId?: string; orgId?: string }) => {
          const title = values.title?.trim();
          if (!title || busy) return;
          submit(
            {
              intent: "create",
              title,
              priority: values.priority ?? "P1",
              ownerId: values.ownerId || "unassigned",
              ...(isAdmin ? { orgId: values.orgId ?? "" } : {}),
            },
            { method: "post", encType: "application/json" },
          );
        }}
      >
        <Form.Item name="title" className="quick-add-item">
          <Input placeholder="新任务标题" allowClear />
        </Form.Item>
        <Form.Item name="priority">
          <Select options={priorityOptions} style={{ width: 88 }} />
        </Form.Item>
        {isAdmin && (
          <Form.Item name="orgId">
            <Select
              placeholder="选择组织"
              style={{ width: 160 }}
              options={activeOrganizations.map((org) => ({ value: org.id, label: org.name }))}
            />
          </Form.Item>
        )}
        {canManage && (
          <Form.Item name="ownerId">
            <AssigneeSelect members={createAssigneePool} />
          </Form.Item>
        )}
        <Form.Item>
          <Button color="primary" variant="solid" htmlType="submit" icon={<PlusOutlined />} disabled={busy}>
            创建任务
          </Button>
        </Form.Item>
      </Form>

      <Space wrap size="small">
        <Select
          value={data.status}
          onChange={(value: string) => updateParams({ status: value === "all" ? null : value })}
          options={statusOptions}
          style={{ width: 140 }}
        />
        <Select
          value={data.assignee}
          onChange={(value: string) => updateParams({ assignee: value === "all" ? null : value })}
          style={{ width: 160 }}
          options={[
            { value: "all", label: "全部负责人" },
            { value: "mine", label: "我的任务" },
            { value: "unassigned", label: "未分配" },
            ...data.members.filter((member) => member.isActive).map((member) => ({ value: member.id, label: memberLabel(member) })),
          ]}
        />
        {isAdmin && (
          <Select
            value={data.org || "all"}
            onChange={(value: string) => updateParams({ org: value === "all" ? null : value })}
            style={{ width: 180 }}
            options={[
              { value: "all", label: "全部组织" },
              ...data.organizations.map((org) => ({
                value: org.id,
                label: org.status === "archived" ? `${org.name}（已解散）` : org.name,
              })),
            ]}
          />
        )}
        {canManage && (
          <Checkbox checked={data.includeArchived} onChange={(event) => updateParams({ archived: event.target.checked ? "1" : null })}>
            显示归档
          </Checkbox>
        )}
      </Space>

      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={() => updateParams({})}>
              重试
            </Button>
          }
        />
      )}

      {data.tasks.length ? (
        <Listy
          items={data.tasks}
          rowKey="id"
          itemRender={(task) => <TaskRow task={task} showOrg={isAdmin} onOpen={() => updateParams({ task: task.id })} />}
        />
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Space orientation="vertical" size={2}>
              <Typography.Text strong>没有符合条件的任务</Typography.Text>
              <Typography.Text type="secondary">调整筛选条件，或先创建一条任务。</Typography.Text>
            </Space>
          }
        />
      )}

      {selected && (
        <TaskDetail
          task={selected}
          activity={data.activity}
          members={isAdmin ? data.members.filter((member) => member.role === "admin" || member.orgId === data.selectedOrgId) : data.members}
          me={me}
          canManage={canManage}
          showOrg={isAdmin}
          busy={busy}
          onClose={() => updateParams({ task: null })}
        />
      )}
    </Space>
  );
}

/** 多组织时用「组织 · 姓名」区分同名账号（同一组织内只显示姓名） */
function memberLabel(member: Member): string {
  return member.orgId ? member.name : `${member.name}（管理员）`;
}

function AssigneeSelect({
  value,
  members,
  onChange,
}: {
  value?: string;
  members: Member[];
  onChange?: (value: string) => void;
}): React.ReactElement {
  return (
    <Select
      value={value ?? ""}
      onChange={(next: string) => onChange?.(next)}
      style={{ width: 160 }}
      options={[
        { value: "", label: "未分配" },
        ...members.filter((member) => member.isActive).map((member) => ({ value: member.id, label: memberLabel(member) })),
      ]}
    />
  );
}

/** 列表行：`showOrg` 只对管理员打开（D-28 的合并视图要能看出每行属于哪个组织） */
function TaskRow({ task, showOrg, onOpen }: { task: TaskRowView; showOrg: boolean; onOpen: () => void }): React.ReactElement {
  const overdue = Boolean(task.dueDate && task.dueDate < new Date().toISOString().slice(0, 10) && task.status !== "completed");
  return (
    <Space align="center" size="middle" className="list-row">
      <Button variant="text" color="default" onClick={onOpen} style={{ flex: 1, height: "auto", padding: "4px 0", textAlign: "left" }}>
        <Space orientation="vertical" size={2} className="list-block">
          <Typography.Text strong>{task.title}</Typography.Text>
          <Space size={4} wrap>
            <Typography.Text type="secondary">
              {task.ownerName ?? "未分配"} · {task.priority} · {labels[task.status] ?? task.status}
            </Typography.Text>
            {showOrg && task.orgName && <Tag color="blue">{task.orgName}</Tag>}
            {overdue && <Tag color="red">已逾期</Tag>}
            {task.archivedAt && <Tag>已归档</Tag>}
            {task.isPrivate && <Tag color="purple">私密</Tag>}
          </Space>
          <Progress percent={task.progress} size="small" showInfo={false} />
        </Space>
      </Button>
      <Typography.Text strong>{task.progress}%</Typography.Text>
    </Space>
  );
}

function TaskDetail({
  task,
  activity,
  members,
  me,
  canManage,
  showOrg,
  busy,
  onClose,
}: {
  task: TaskRowView;
  activity: ActivityRow[];
  members: Member[];
  me: Me;
  canManage: boolean;
  showOrg: boolean;
  busy: boolean;
  onClose: () => void;
}): React.ReactElement {
  const { modal } = AntdApp.useApp();
  const submit = useSubmit();
  const actionData = useActionData<typeof action>();
  const error = actionData && "error" in actionData ? actionData.error : "";
  const canProgress = task.ownerId === me.id && !task.archivedAt && task.status !== "completed" && task.status !== "pending_review";
  const post = (payload: Record<string, unknown>): void => {
    submit(payload as Parameters<typeof submit>[0], { method: "post", encType: "application/json" });
  };

  return (
    <Drawer
      open
      placement="right"
      size={560}
      onClose={onClose}
      title={
        <Space orientation="vertical" size={0}>
          <Typography.Text type="secondary">TASK DETAIL</Typography.Text>
          <Typography.Text strong>{task.title}</Typography.Text>
        </Space>
      }
    >
      <Space orientation="vertical" size="middle" className="page-stack">
        {error && <Alert type="error" showIcon title={error} />}

        {canManage && !task.archivedAt && (
          <Form
            layout="vertical"
            initialValues={{
              title: task.title,
              description: task.description,
              priority: task.priority,
              ownerId: task.ownerId ?? "",
              dueDate: task.dueDate ? dayjs(task.dueDate) : null,
            }}
            onFinish={(values: {
              title?: string;
              description?: string;
              priority?: string;
              ownerId?: string;
              dueDate?: dayjs.Dayjs | null;
            }) => {
              const title = values.title?.trim();
              if (!title) return;
              post({
                intent: "update",
                taskId: task.id,
                title,
                description: values.description ?? "",
                priority: values.priority ?? task.priority,
                ownerId: values.ownerId || "unassigned",
                dueDate: values.dueDate ? values.dueDate.format("YYYY-MM-DD") : null,
              });
            }}
          >
            <Card
              variant="outlined"
              title="任务信息与改派"
              extra={
                <Button color="primary" variant="solid" htmlType="submit" disabled={busy}>
                  保存并改派
                </Button>
              }
            >
              <Space orientation="vertical" size="small" className="page-stack">
                <Form.Item name="title" noStyle>
                  <Input placeholder="任务标题" />
                </Form.Item>
                <Form.Item name="description" noStyle>
                  <Input.TextArea placeholder="任务说明" rows={3} />
                </Form.Item>
                <Space wrap size="small">
                  <Form.Item name="priority" noStyle>
                    <Select options={priorityOptions} style={{ width: 88 }} />
                  </Form.Item>
                  <Form.Item name="dueDate" noStyle>
                    <DatePicker format="YYYY-MM-DD" placeholder="截止日期" />
                  </Form.Item>
                  <Form.Item name="ownerId" noStyle>
                    <AssigneeSelect members={members} />
                  </Form.Item>
                </Space>
              </Space>
            </Card>
          </Form>
        )}

        <Space orientation="vertical" size={2}>
          <Space size={4} wrap>
            {showOrg && task.orgName && <Tag color="blue">{task.orgName}</Tag>}
            <Typography.Text type="secondary">
              负责人：{task.ownerName ?? "未分配"} · {task.priority} · {labels[task.status] ?? task.status}
              {task.dueDate ? ` · 截止 ${task.dueDate}` : ""}
            </Typography.Text>
          </Space>
          <Space align="center" size="small">
            <Typography.Text strong>{task.progress}%</Typography.Text>
            <Progress percent={task.progress} size="small" showInfo={false} style={{ width: 240 }} />
          </Space>
        </Space>

        {canProgress && <ProgressForm task={task} busy={busy} onPost={post} />}

        {task.status === "pending_review" && canManage && (
          <Space wrap size="small">
            <Button
              color="primary"
              variant="solid"
              disabled={busy}
              onClick={() =>
                modal.confirm({
                  title: "确认通过验收吗？",
                  okText: "通过验收",
                  cancelText: "取消",
                  onOk: () => post({ intent: "approve", taskId: task.id }),
                })
              }
            >
              通过验收
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                let reason = RETURN_NOTE_DEFAULT;
                modal.confirm({
                  title: "退回说明",
                  okText: "退回修改",
                  cancelText: "取消",
                  content: (
                    <Input.TextArea defaultValue={RETURN_NOTE_DEFAULT} onChange={(event) => (reason = event.target.value)} rows={3} />
                  ),
                  onOk: () => post({ intent: "return", taskId: task.id, note: reason }),
                });
              }}
            >
              退回修改
            </Button>
          </Space>
        )}

        {canManage && (
          <Space wrap size="small">
            {task.archivedAt ? (
              <>
                <Button icon={<ReloadOutlined />} disabled={busy} onClick={() => post({ intent: "restore", taskId: task.id })}>
                  恢复任务
                </Button>
                <Popconfirm
                  title="彻底删除后无法恢复，继续吗？"
                  okText="彻底删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => post({ intent: "delete", taskId: task.id })}
                >
                  <Button color="danger" variant="outlined" disabled={busy} icon={<DeleteOutlined />}>
                    彻底删除
                  </Button>
                </Popconfirm>
              </>
            ) : (
              <Popconfirm
                title="归档后可恢复，确定吗？"
                okText="归档"
                cancelText="取消"
                onConfirm={() => post({ intent: "archive", taskId: task.id })}
              >
                <Button color="danger" variant="outlined" disabled={busy}>
                  归档任务
                </Button>
              </Popconfirm>
            )}
          </Space>
        )}

        <Card variant="outlined" title="协作时间线">
          {activity.length ? (
            <Timeline
              items={activity.map((item) => ({
                key: `${item.kind}-${item.id}`,
                title: new Date(item.createdAt).toLocaleString(),
                color: timelineColors[item.kind] ?? "blue",
                content: (
                  <Space orientation="vertical" size={2} className="list-block">
                    <Typography.Text strong>
                      {item.authorName ?? "系统"}
                      {eventLabels[item.kind] ? ` · ${eventLabels[item.kind]}` : ""}
                    </Typography.Text>
                    <Typography.Text>
                      {item.content}
                      {item.progress !== null && `（${item.progress}%）`}
                    </Typography.Text>
                  </Space>
                ),
              }))}
            />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无记录" />
          )}
        </Card>

        <Form
          layout="inline"
          className="quick-add"
          onFinish={(values: { comment?: string }) => {
            const comment = values.comment?.trim();
            if (!comment || busy) return;
            post({ intent: "comment", taskId: task.id, content: comment });
          }}
        >
          <Form.Item name="comment" className="quick-add-item">
            <Input placeholder="添加评论" allowClear />
          </Form.Item>
          <Form.Item>
            <Button color="primary" variant="solid" htmlType="submit" disabled={busy}>
              发送
            </Button>
          </Form.Item>
        </Form>
      </Space>
    </Drawer>
  );
}

function ProgressForm({
  task,
  busy,
  onPost,
}: {
  task: TaskRowView;
  busy: boolean;
  onPost: (payload: Record<string, unknown>) => void;
}): React.ReactElement {
  const [form] = Form.useForm<{ progress: number; note?: string }>();
  const progress = (Form.useWatch("progress", form) as number | undefined) ?? task.progress;
  const note = Form.useWatch("note", form) as string | undefined;
  return (
    <Form
      form={form}
      initialValues={{ progress: task.progress, note: "" }}
      onFinish={(values: { progress?: number; note?: string }) => {
        const next = values.progress ?? task.progress;
        const trimmed = values.note?.trim() ?? "";
        if (next === task.progress && !trimmed) return;
        onPost({ intent: "progress", taskId: task.id, progress: next, ...(trimmed ? { note: trimmed } : {}) });
      }}
    >
      <Card variant="outlined" title="汇报进度">
        <Space orientation="vertical" size="small" className="page-stack">
          <Form.Item name="progress" noStyle>
            <Slider min={0} max={100} />
          </Form.Item>
          <Space wrap size="small">
            <Form.Item name="note" noStyle>
              <Input placeholder="可选：进展说明" style={{ width: 240 }} />
            </Form.Item>
            <Button htmlType="submit" disabled={busy || (progress === task.progress && !note?.trim())}>
              保存 {progress}%
            </Button>
          </Space>
        </Space>
      </Card>
    </Form>
  );
}

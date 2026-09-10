import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
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
import type { Note, Task, Todo, UserRole } from "../../../shared/types/domain";
import {
  addTaskComment,
  approveTask,
  archiveTask,
  createNote,
  createTask,
  createTodo,
  deleteNote,
  deleteTask,
  deleteTodo,
  getMe,
  getNotes,
  getTaskActivity,
  getTasks,
  getTodos,
  getUsers,
  markNotificationsRead,
  postTaskProgress,
  restoreTask,
  returnTask,
  updateTask,
  updateTodo,
  type ActivityItem,
  type Collaborator,
} from "../services/apiClient";

const labels: Record<Task["status"], string> = { todo: "待办", in_progress: "进行中", pending_review: "待验收", completed: "已完成" };
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
const priorityOptions: Array<{ value: Task["priority"]; label: string }> = [
  { value: "P0", label: "P0" },
  { value: "P1", label: "P1" },
  { value: "P2", label: "P2" },
];
const statusOptions: Array<{ value: string; label: string }> = [
  { value: "all", label: "全部状态" },
  ...(Object.entries(labels) as Array<[Task["status"], string]>).map(([value, label]) => ({ value, label })),
];
const RETURN_NOTE_DEFAULT = "请补充完成情况后重新提交";
type Me = { id: string; role: UserRole };

export function TasksPage(): React.ReactElement {
  const { modal } = AntdApp.useApp();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<Collaborator[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState("all");
  const [assignee, setAssignee] = useState("all");
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<{ title?: string; priority?: Task["priority"]; ownerId?: string }>();
  const titleValue = Form.useWatch("title", form);
  const [params, setParams] = useSearchParams();
  const load = (): void => {
    setLoading(true);
    void Promise.all([getTasks({ includeArchived: archived }), getMe()])
      .then(async ([items, current]) => {
        setTasks(items);
        const nextMe = { id: current.user.id, role: current.user.role };
        setMe(nextMe);
        if (nextMe.role === "owner") setMembers(await getUsers());
        const id = params.get("task");
        if (id) {
          const found = items.find((item) => item.id === id);
          if (found) {
            setSelected(found);
            void markNotificationsRead({ taskId: id });
          }
          params.delete("task");
          setParams(params, { replace: true });
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "任务加载失败"))
      .finally(() => setLoading(false));
  };
  useEffect(load, [archived, params]);
  const filtered = useMemo(
    () =>
      tasks.filter(
        (task) =>
          (status === "all" || task.status === status) &&
          (assignee === "all" ||
            (assignee === "mine"
              ? task.ownerId === me?.id
              : assignee === "unassigned"
                ? task.ownerId === null
                : task.ownerId === assignee)),
      ),
    [tasks, status, assignee, me],
  );
  const create = (values: { title?: string; priority?: Task["priority"]; ownerId?: string }): void => {
    const title = values.title?.trim();
    if (!title || busy) return;
    setBusy(true);
    void createTask({ title, priority: values.priority ?? "P1", ownerId: values.ownerId || "unassigned" })
      .then((task) => {
        setTasks((items) => [task, ...items]);
        form.setFieldValue("title", "");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "创建失败"))
      .finally(() => setBusy(false));
  };
  if (loading)
    return (
      <Space orientation="vertical" size="large" className="page-stack">
        <Typography.Text type="secondary">正在加载任务…</Typography.Text>
      </Space>
    );
  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <Space orientation="vertical" size={0}>
        <Typography.Text type="secondary">WORK</Typography.Text>
        <Typography.Title level={3} className="page-title">
          任务进展
        </Typography.Title>
        <Typography.Text type="secondary">派发、进度、验收和沟通都保留在同一条时间线中。</Typography.Text>
      </Space>

      <Form form={form} layout="inline" onFinish={create} className="quick-add" initialValues={{ priority: "P1", ownerId: "" }}>
        <Form.Item name="title" className="quick-add-item">
          <Input placeholder="新任务标题" allowClear />
        </Form.Item>
        <Form.Item name="priority">
          <Select options={priorityOptions} style={{ width: 88 }} />
        </Form.Item>
        {me?.role === "owner" && (
          <Form.Item name="ownerId">
            <AssigneeSelect members={members} />
          </Form.Item>
        )}
        <Form.Item>
          <Button color="primary" variant="solid" htmlType="submit" icon={<PlusOutlined />} disabled={!titleValue?.trim() || busy}>
            {busy ? "创建中…" : "创建任务"}
          </Button>
        </Form.Item>
      </Form>

      <Space wrap size="small">
        <Select value={status} onChange={(value: string) => setStatus(value)} options={statusOptions} style={{ width: 140 }} />
        <Select
          value={assignee}
          onChange={(value: string) => setAssignee(value)}
          style={{ width: 160 }}
          options={[
            { value: "all", label: "全部负责人" },
            { value: "mine", label: "我的任务" },
            { value: "unassigned", label: "未分配" },
            ...(me?.role === "owner" ? members.filter((m) => m.role !== "viewer").map((m) => ({ value: m.id, label: m.name })) : []),
          ]}
        />
        {me?.role === "owner" && (
          <Checkbox checked={archived} onChange={(e) => setArchived(e.target.checked)}>
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
            <Button size="small" icon={<ReloadOutlined />} onClick={load}>
              重试
            </Button>
          }
        />
      )}

      {filtered.length ? (
        <Listy
          items={filtered}
          rowKey="id"
          itemRender={(task) => (
            <TaskRow
              task={task}
              onOpen={() => {
                setSelected(task);
                void markNotificationsRead({ taskId: task.id });
              }}
            />
          )}
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
          me={me}
          members={members}
          onClose={() => setSelected(null)}
          onChanged={(updated) => {
            setTasks((items) => items.map((item) => (item.id === updated.id ? updated : item)));
            setSelected(updated);
          }}
          onRemoved={(id) => {
            setTasks((items) => items.filter((item) => item.id !== id));
            setSelected(null);
          }}
          onConfirm={(options) => modal.confirm(options)}
        />
      )}
    </Space>
  );
}

function AssigneeSelect({
  value,
  members,
  onChange,
}: {
  value?: string;
  members: Collaborator[];
  onChange?: (value: string) => void;
}): React.ReactElement {
  return (
    <Select
      value={value ?? ""}
      onChange={(next: string) => onChange?.(next)}
      style={{ width: 140 }}
      options={[
        { value: "", label: "未分配" },
        { value: "owner", label: "主人" },
        ...members.filter((m) => m.role === "assistant" && m.isActive).map((m) => ({ value: m.id, label: m.name })),
      ]}
    />
  );
}

function TaskRow({ task, onOpen }: { task: Task; onOpen: () => void }): React.ReactElement {
  const overdue = Boolean(task.dueDate && task.dueDate < new Date().toISOString().slice(0, 10) && task.status !== "completed");
  return (
    <Space align="center" size="middle" className="list-row">
      <Button variant="text" color="default" onClick={onOpen} style={{ flex: 1, height: "auto", padding: "4px 0", textAlign: "left" }}>
        <Space orientation="vertical" size={2} className="list-block">
          <Typography.Text strong>{task.title}</Typography.Text>
          <Space size={4} wrap>
            <Typography.Text type="secondary">
              {task.ownerName ?? "未分配"} · {task.priority} · {labels[task.status]}
            </Typography.Text>
            {overdue && <Tag color="red">已逾期</Tag>}
            {task.archivedAt && <Tag>已归档</Tag>}
          </Space>
          <Progress percent={task.progress} size="small" showInfo={false} />
        </Space>
      </Button>
      <Typography.Text strong>{task.progress}%</Typography.Text>
    </Space>
  );
}

type ConfirmOptions = Parameters<ReturnType<typeof AntdApp.useApp>["modal"]["confirm"]>[0];

function TaskDetail({
  task,
  me,
  members,
  onClose,
  onChanged,
  onRemoved,
  onConfirm,
}: {
  task: Task;
  me: Me | null;
  members: Collaborator[];
  onClose: () => void;
  onChanged: (task: Task) => void;
  onRemoved: (id: string) => void;
  onConfirm: (options: ConfirmOptions) => void;
}): React.ReactElement {
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [note, setNote] = useState("");
  const [comment, setComment] = useState("");
  const [progress, setProgress] = useState(task.progress);
  const [ownerId, setOwnerId] = useState(task.ownerId ?? "");
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [priority, setPriority] = useState(task.priority);
  const [dueDate, setDueDate] = useState(task.dueDate ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const owner = me?.role === "owner";
  const canProgress = task.ownerId === me?.id && !task.archivedAt && task.status !== "completed" && task.status !== "pending_review";
  const load = (): void => {
    void getTaskActivity(task.id)
      .then(setActivity)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "时间线加载失败"));
  };
  useEffect(load, [task.id, task.updatedAt]);
  const run = (fn: () => Promise<Task>): void => {
    if (busy) return;
    setBusy(true);
    setError("");
    void fn()
      .then((updated) => {
        onChanged(updated);
        load();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "操作失败"))
      .finally(() => setBusy(false));
  };
  const remove = (fn: () => Promise<null>, failure: string): void => {
    setBusy(true);
    void fn()
      .then(() => onRemoved(task.id))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : failure))
      .finally(() => setBusy(false));
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

        {owner && !task.archivedAt && (
          <Card
            variant="outlined"
            title="任务信息与改派"
            extra={
              <Button
                color="primary"
                variant="solid"
                disabled={busy || !title.trim()}
                onClick={() =>
                  run(() =>
                    updateTask(task.id, {
                      title: title.trim(),
                      description,
                      priority,
                      dueDate: dueDate || null,
                      ownerId: ownerId || "unassigned",
                    }),
                  )
                }
              >
                保存并改派
              </Button>
            }
          >
            <Space orientation="vertical" size="small" className="page-stack">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="任务标题" />
              <Input.TextArea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="任务说明" rows={3} />
              <Space wrap size="small">
                <Select
                  value={priority}
                  onChange={(value: Task["priority"]) => setPriority(value)}
                  options={priorityOptions}
                  style={{ width: 88 }}
                />
                <DatePicker
                  format="YYYY-MM-DD"
                  placeholder="截止日期"
                  {...(dueDate ? { value: dayjs(dueDate) } : {})}
                  onChange={(date) => setDueDate(date ? date.format("YYYY-MM-DD") : "")}
                />
                <AssigneeSelect value={ownerId} members={members} onChange={setOwnerId} />
              </Space>
            </Space>
          </Card>
        )}

        <Space orientation="vertical" size={2}>
          <Typography.Text type="secondary">
            负责人：{task.ownerName ?? "未分配"} · {task.priority} · {labels[task.status]}
            {task.dueDate ? ` · 截止 ${task.dueDate}` : ""}
          </Typography.Text>
          <Space align="center" size="small">
            <Typography.Text strong>{task.progress}%</Typography.Text>
            <Progress percent={task.progress} size="small" showInfo={false} style={{ width: 240 }} />
          </Space>
        </Space>

        {canProgress && (
          <Card variant="outlined" title="汇报进度">
            <Space orientation="vertical" size="small" className="page-stack">
              <Slider min={0} max={100} value={progress} onChange={setProgress} />
              <Space wrap size="small">
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选：进展说明" style={{ width: 240 }} />
                <Button
                  disabled={busy || (progress === task.progress && !note.trim())}
                  onClick={() => run(() => postTaskProgress(task.id, { progress, ...(note.trim() ? { note: note.trim() } : {}) }))}
                >
                  保存 {progress}%
                </Button>
              </Space>
            </Space>
          </Card>
        )}

        {task.status === "pending_review" && owner && (
          <Space wrap size="small">
            <Button
              color="primary"
              variant="solid"
              disabled={busy}
              onClick={() =>
                onConfirm({
                  title: "确认通过验收吗？",
                  okText: "通过验收",
                  cancelText: "取消",
                  onOk: () => run(() => approveTask(task.id)),
                })
              }
            >
              通过验收
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                let reason = RETURN_NOTE_DEFAULT;
                onConfirm({
                  title: "退回说明",
                  okText: "退回修改",
                  cancelText: "取消",
                  content: <Input.TextArea defaultValue={RETURN_NOTE_DEFAULT} onChange={(e) => (reason = e.target.value)} rows={3} />,
                  onOk: () => run(() => returnTask(task.id, reason)),
                });
              }}
            >
              退回修改
            </Button>
          </Space>
        )}

        {owner && (
          <Space wrap size="small">
            {task.archivedAt ? (
              <>
                <Button icon={<ReloadOutlined />} onClick={() => run(() => restoreTask(task.id))}>
                  恢复任务
                </Button>
                <Button
                  color="danger"
                  variant="outlined"
                  disabled={busy}
                  onClick={() =>
                    onConfirm({
                      title: "彻底删除后无法恢复，继续吗？",
                      okText: "彻底删除",
                      cancelText: "取消",
                      okButtonProps: { danger: true },
                      onOk: () => remove(() => deleteTask(task.id), "删除失败"),
                    })
                  }
                >
                  彻底删除
                </Button>
              </>
            ) : (
              <Button
                color="danger"
                variant="outlined"
                disabled={busy}
                onClick={() =>
                  onConfirm({
                    title: "归档后可恢复，确定吗？",
                    okText: "归档",
                    cancelText: "取消",
                    onOk: () => remove(() => archiveTask(task.id), "归档失败"),
                  })
                }
              >
                归档任务
              </Button>
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
          onFinish={() => {
            if (!comment.trim() || busy) return;
            setBusy(true);
            void addTaskComment(task.id, comment.trim())
              .then(() => {
                setComment("");
                load();
              })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : "评论失败"))
              .finally(() => setBusy(false));
          }}
        >
          <Form.Item className="quick-add-item">
            <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="添加评论" allowClear />
          </Form.Item>
          <Form.Item>
            <Button color="primary" variant="solid" htmlType="submit" disabled={!comment.trim() || busy}>
              发送
            </Button>
          </Form.Item>
        </Form>
      </Space>
    </Drawer>
  );
}

export function TodosPage(): React.ReactElement {
  const [items, setItems] = useState<Todo[]>([]);
  const [error, setError] = useState("");
  const [form] = Form.useForm<{ content?: string }>();
  const contentValue = Form.useWatch("content", form);
  const [busy, setBusy] = useState(false);
  const load = (): void => {
    void getTodos()
      .then(setItems)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "加载失败"));
  };
  useEffect(load, []);
  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <Space orientation="vertical" size={0}>
        <Typography.Text type="secondary">TODAY</Typography.Text>
        <Typography.Title level={3} className="page-title">
          待办清单
        </Typography.Title>
      </Space>

      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={load}>
              重试
            </Button>
          }
        />
      )}

      <Form
        form={form}
        layout="inline"
        className="quick-add"
        onFinish={(values: { content?: string }) => {
          const content = values.content?.trim();
          if (!content || busy) return;
          setBusy(true);
          void createTodo({ content, todoDate: new Date().toISOString().slice(0, 10) })
            .then((item) => {
              setItems((all) => [item, ...all]);
              form.resetFields();
            })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : "添加失败"))
            .finally(() => setBusy(false));
        }}
      >
        <Form.Item name="content" className="quick-add-item">
          <Input placeholder="添加一条今日待办" allowClear />
        </Form.Item>
        <Form.Item>
          <Button color="primary" variant="solid" htmlType="submit" icon={<PlusOutlined />} disabled={!contentValue?.trim() || busy}>
            添加
          </Button>
        </Form.Item>
      </Form>

      {items.length ? (
        <Listy
          items={items}
          rowKey="id"
          itemRender={(item) => (
            <Space align="center" size="middle" className="list-row">
              <Checkbox
                checked={item.isCompleted}
                onChange={(e) =>
                  void updateTodo(item.id, { isCompleted: e.target.checked }).then((updated) =>
                    setItems((all) => all.map((x) => (x.id === updated.id ? updated : x))),
                  )
                }
              >
                <Typography.Text delete={item.isCompleted} {...(item.isCompleted ? { type: "secondary" as const } : {})}>
                  {item.content}
                </Typography.Text>
              </Checkbox>
              <Popconfirm
                title="确定删除吗？"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => void deleteTodo(item.id).then(() => setItems((all) => all.filter((x) => x.id !== item.id)))}
              >
                <Button color="danger" variant="text" icon={<DeleteOutlined />} aria-label="删除待办" />
              </Popconfirm>
            </Space>
          )}
        />
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Space orientation="vertical" size={2}>
              <Typography.Text strong>暂无待办</Typography.Text>
              <Typography.Text type="secondary">添加一条今天要完成的事情。</Typography.Text>
            </Space>
          }
        />
      )}
    </Space>
  );
}

export function NotesPage(): React.ReactElement {
  const [items, setItems] = useState<Note[]>([]);
  const [error, setError] = useState("");
  const [form] = Form.useForm<{ content?: string }>();
  const contentValue = Form.useWatch("content", form);
  const [busy, setBusy] = useState(false);
  const load = (): void => {
    void getNotes()
      .then(setItems)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "加载失败"));
  };
  useEffect(load, []);
  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <Space orientation="vertical" size={0}>
        <Typography.Text type="secondary">CAPTURE</Typography.Text>
        <Typography.Title level={3} className="page-title">
          随手记
        </Typography.Title>
      </Space>

      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={load}>
              重试
            </Button>
          }
        />
      )}

      <Form
        form={form}
        className="page-stack"
        onFinish={(values: { content?: string }) => {
          const content = values.content?.trim();
          if (!content || busy) return;
          setBusy(true);
          void createNote({ content })
            .then((item) => {
              setItems((all) => [item, ...all]);
              form.resetFields();
            })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : "保存失败"))
            .finally(() => setBusy(false));
        }}
      >
        <Form.Item name="content" className="quick-add-item">
          <Input.TextArea placeholder="记录想法、会议要点或临时事项" rows={3} allowClear />
        </Form.Item>
        <Form.Item>
          <Button color="primary" variant="solid" htmlType="submit" disabled={!contentValue?.trim() || busy}>
            保存记录
          </Button>
        </Form.Item>
      </Form>

      {items.length ? (
        <Listy
          items={items}
          rowKey="id"
          itemRender={(item) => (
            <Space align="start" size="middle" className="list-row">
              <Typography.Paragraph style={{ margin: 0, flex: 1 }}>{item.content}</Typography.Paragraph>
              <Popconfirm
                title="确定删除吗？"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => void deleteNote(item.id).then(() => setItems((all) => all.filter((x) => x.id !== item.id)))}
              >
                <Button color="danger" variant="text" icon={<DeleteOutlined />} aria-label="删除随手记" />
              </Popconfirm>
            </Space>
          )}
        />
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Space orientation="vertical" size={2}>
              <Typography.Text strong>暂无随手记</Typography.Text>
              <Typography.Text type="secondary">记录会议要点或临时想法。</Typography.Text>
            </Space>
          }
        />
      )}
    </Space>
  );
}

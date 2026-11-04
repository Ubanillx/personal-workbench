import type React from "react";
import { useMemo, useState } from "react";
import { useActionData, useLoaderData, useNavigate, useNavigation, useSubmit } from "react-router";
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Flex,
  Form,
  Input,
  Modal,
  Popover,
  Select,
  Space,
  Tooltip,
  Typography,
} from "antd";
import { LeftOutlined, PlusOutlined, RightOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { db } from "../lib/db.server";
import { dimensionTones, type DimensionTone } from "../lib/dimension-tones";
import { readPayload } from "../lib/form.server";
import { listOrganizations, taskAssigneeCandidates } from "../lib/organization.server";
import { createTask } from "../lib/task-service.server";
import { listTaskDimensions, personalTaskStates } from "../lib/task-dimensions.server";
import { visible } from "../lib/tasks.server";
import { listTodos } from "../lib/todos.server";
import { requireUserOrRedirect } from "../lib/ui.server";
import { useCrudFeedback } from "../components/crud-hooks";
import { PageHeader } from "../components/page-header";

/* ------------------------------------------------------------------ 类型与常量 */

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/u;
const STATUS_LABEL: Record<string, string> = { todo: "待办", in_progress: "进行中", pending_review: "待验收", completed: "已完成" };
/** 待办与任务用色区分；任务沿用维度配色（与任务看板一致） */
const TODO_TONE: DimensionTone = { background: "#e6fffb", color: "#08979c" };
const EVENT_LIMIT = 3;

type CalendarTask = { id: string; title: string; dueDate: string | null; priority: string; status: string; ownerName?: string };
type CalendarTodo = { id: string; content: string; todoDate: string | null; isCompleted: boolean };
type CalendarEvent = {
  date: string;
  kind: "task" | "todo";
  id: string;
  title: string;
  hint: string;
  done: boolean;
  tone: DimensionTone;
};
type CreateValues = { title: string; priority: string; dueDate: Dayjs; orgId?: string; ownerId?: string };
type ActionResult = { ok: true; notice: string } | { error: string };

/* ------------------------------------------------------------------ loader / action */

export async function loader({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  const url = new URL(request.url);
  const requested = url.searchParams.get("month") ?? "";
  const monthStart = (MONTH_PATTERN.test(requested) ? dayjs(`${requested}-01`) : dayjs()).startOf("month");
  // 月视图固定 6 行：从当月 1 日所在周的周日开始，覆盖 42 天（相邻月的日期也带事件）
  const gridStart = monthStart.subtract(monthStart.day(), "day");
  const from = gridStart.format("YYYY-MM-DD");
  const to = gridStart.add(41, "day").format("YYYY-MM-DD");

  const database = db();
  const tasks = visible(database, user, false, undefined, undefined, null, { dueFrom: from, dueTo: to }) as CalendarTask[];
  const states = personalTaskStates(
    user,
    tasks.map((task) => task.id),
  );
  const dimensions = listTaskDimensions(user);
  const tones = dimensionTones(dimensions.map((item) => item.id));
  const fallbackTone = tones.unclassified ?? { background: "#f5f5f5", color: "#595959" };

  const events: CalendarEvent[] = [];
  for (const task of tasks) {
    // 截止日期为空的任务不进日历（SQL 已按日期范围过滤，这里只是类型收窄）
    if (!task.dueDate) continue;
    const primary = dimensions.find((item) => states[task.id]?.dimensionIds.includes(item.id));
    events.push({
      date: task.dueDate,
      kind: "task",
      id: task.id,
      title: task.title,
      hint: `${STATUS_LABEL[task.status] ?? task.status} · ${task.ownerName ?? "未分配"} · ${task.priority}`,
      done: task.status === "completed",
      tone: (primary && tones[primary.id]) || fallbackTone,
    });
  }
  for (const todo of listTodos(user) as unknown as CalendarTodo[]) {
    if (!todo.todoDate || todo.todoDate < from || todo.todoDate > to) continue;
    events.push({
      date: todo.todoDate,
      kind: "todo",
      id: todo.id,
      title: todo.content,
      hint: todo.isCompleted ? "待办 · 已完成" : "待办",
      done: todo.isCompleted,
      tone: TODO_TONE,
    });
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || Number(a.kind === "todo") - Number(b.kind === "todo"));

  const organizations = user.role === "admin" ? listOrganizations(user).filter((item) => item.status === "active") : [];
  return {
    me: { id: user.id, name: user.name, role: user.role, orgId: user.orgId },
    month: monthStart.format("YYYY-MM"),
    today: dayjs().format("YYYY-MM-DD"),
    gridStart: from,
    events,
    canCreate: user.role === "admin" ? organizations.length > 0 : Boolean(user.orgId),
    organizations: organizations.map((item) => ({ id: item.id, name: item.name })),
    members: taskAssigneeCandidates(user),
  };
}

export async function action({ request }: { request: Request }): Promise<ActionResult> {
  const user = requireUserOrRedirect(request);
  const payload = await readPayload(request);
  if (String(payload.intent ?? "") !== "create") return { error: "未知操作" };
  const result = createTask(user, payload);
  return result.ok ? { ok: true, notice: "任务已创建" } : { error: result.message };
}

/* ------------------------------------------------------------------ 页面 */

export default function CalendarRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const submit = useSubmit();
  const [createDate, setCreateDate] = useState<string | null>(null);
  const [form] = Form.useForm<CreateValues>();
  const { error } = useCrudFeedback(actionData, () => setCreateDate(null));
  const busy = navigation.state !== "idle";

  const month = dayjs(`${data.month}-01`);
  const isAdmin = data.me.role === "admin";
  const canPickOwner = data.me.role !== "member";
  const watchedOrg = Form.useWatch("orgId", form);

  const days = useMemo(
    () =>
      Array.from({ length: 42 }, (_, index) => {
        const date = dayjs(data.gridStart).add(index, "day");
        return { key: date.format("YYYY-MM-DD"), date, inMonth: date.month() === month.month() };
      }),
    [data.gridStart, month],
  );
  const eventsByDate = useMemo(() => {
    const grouped = new Map<string, CalendarEvent[]>();
    for (const event of data.events) {
      const list = grouped.get(event.date) ?? [];
      list.push(event);
      grouped.set(event.date, list);
    }
    return grouped;
  }, [data.events]);

  const goMonth = (delta: number): void => {
    void navigate(`/calendar?month=${month.add(delta, "month").format("YYYY-MM")}`);
  };
  const goToday = (): void => {
    void navigate(`/calendar?month=${dayjs().format("YYYY-MM")}`);
  };
  const openCreate = (date: string): void => {
    if (data.canCreate) setCreateDate(date);
  };
  const openEvent = (event: CalendarEvent): void => {
    void navigate(event.kind === "task" ? `/tasks?task=${event.id}` : "/todos");
  };
  const memberLabel = (member: { name: string; role: string }): string =>
    member.role === "admin" ? `${member.name}（管理员）` : member.name;

  const ownerOptions = useMemo(() => {
    const pool = isAdmin ? data.members.filter((member) => member.role === "admin" || member.orgId === watchedOrg) : data.members;
    return pool.filter((member) => member.isActive).map((member) => ({ value: member.id, label: memberLabel(member) }));
  }, [data.members, isAdmin, watchedOrg]);

  const initialCreateValues = (): CreateValues => {
    const orgId = isAdmin ? data.organizations[0]?.id : undefined;
    const ownerId = isAdmin
      ? data.members.find((member) => member.isActive && member.orgId === orgId && member.role !== "admin")?.id
      : data.me.id;
    return {
      title: "",
      priority: "P1",
      dueDate: dayjs(createDate ?? data.today),
      ...(orgId ? { orgId } : {}),
      ...(ownerId ? { ownerId } : {}),
    };
  };

  const onCreate = (values: CreateValues): void => {
    submit(
      {
        intent: "create",
        title: values.title,
        priority: values.priority,
        dueDate: values.dueDate.format("YYYY-MM-DD"),
        ...(isAdmin && values.orgId ? { orgId: values.orgId } : {}),
        ...(canPickOwner && values.ownerId ? { ownerId: values.ownerId } : {}),
      },
      { method: "post", encType: "application/json" },
    );
  };

  const renderEvent = (event: CalendarEvent): React.ReactElement => (
    <Tooltip key={`${event.kind}-${event.id}`} title={`${event.title} · ${event.hint}`} mouseEnterDelay={0.4}>
      <button
        type="button"
        className={event.done ? "calendar-event is-done" : "calendar-event"}
        style={event.tone}
        onClick={(clickEvent) => {
          clickEvent.stopPropagation();
          openEvent(event);
        }}
      >
        <span className="calendar-event-dot" style={{ background: event.tone.color }} aria-hidden="true" />
        <span className="calendar-event-title">{event.title}</span>
      </button>
    </Tooltip>
  );

  return (
    <Flex vertical gap="large" className="page-stack">
      <PageHeader
        title="日历"
        eyebrow="CALENDAR"
        description="按截止日期查看任务与待办，点击日期空白处可直接新建任务。"
        help="任务按截止日期落在日历上，颜色跟随个人维度（与任务看板一致）；待办按计划日期显示为青色条目。权限沿用任务与待办的可见范围：普通成员只看到自己发布或负责的任务，待办只有本人可见。点击任务打开任务详情，点击待办进入待办清单。"
        extra={
          <Button
            color="primary"
            variant="solid"
            icon={<PlusOutlined />}
            onClick={() => openCreate(data.today)}
            disabled={!data.canCreate}
          >
            新建任务
          </Button>
        }
      />

      {error ? <Alert type="error" showIcon title={error} /> : null}

      <Card variant="outlined" styles={{ body: { padding: 0 } }}>
        <div className="calendar-toolbar">
          <Space size="small" align="center">
            <Button icon={<LeftOutlined />} aria-label="上个月" onClick={() => goMonth(-1)} />
            <Button icon={<RightOutlined />} aria-label="下个月" onClick={() => goMonth(1)} />
            <Typography.Title level={4} className="calendar-month">
              {month.format("YYYY年M月")}
            </Typography.Title>
            <Button onClick={goToday}>今天</Button>
          </Space>
          <Space size="middle" align="center" wrap>
            <span className="calendar-legend">
              <i className="calendar-dot" aria-hidden="true" />
              任务
            </span>
            <span className="calendar-legend">
              <i className="calendar-dot calendar-dot-todo" aria-hidden="true" />
              待办
            </span>
            <DatePicker
              picker="month"
              allowClear={false}
              value={month}
              onChange={(value: Dayjs | null) => {
                if (value) navigate(`/calendar?month=${value.format("YYYY-MM")}`);
              }}
            />
          </Space>
        </div>

        <div className="calendar-scroll">
          <div className="calendar-weekdays">
            {WEEKDAYS.map((label) => (
              <div key={label} className="calendar-weekday">
                {label}
              </div>
            ))}
          </div>
          <div className="calendar-grid">
            {days.map((day) => {
              const dayEvents = eventsByDate.get(day.key) ?? [];
              const shown = dayEvents.slice(0, EVENT_LIMIT);
              const rest = dayEvents.slice(EVENT_LIMIT);
              return (
                <div
                  key={day.key}
                  className={[
                    "calendar-cell",
                    day.inMonth ? "" : "is-outside",
                    data.canCreate ? "is-clickable" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => openCreate(day.key)}
                  {...(data.canCreate ? { title: "点击新建任务" } : {})}
                >
                  <div className="calendar-day-head">
                    <span className={day.key === data.today ? "calendar-day-num is-today" : "calendar-day-num"}>
                      {day.date.date()}
                    </span>
                  </div>
                  <div className="calendar-events">
                    {shown.map(renderEvent)}
                    {rest.length ? (
                      <Popover
                        trigger="click"
                        placement="bottomLeft"
                        content={
                          <div className="calendar-popover-list">
                            {dayEvents.map((event) => (
                              <button
                                key={`${event.kind}-${event.id}`}
                                type="button"
                                className={event.done ? "calendar-event is-done" : "calendar-event"}
                                style={event.tone}
                                onClick={() => openEvent(event)}
                              >
                                <span className="calendar-event-dot" style={{ background: event.tone.color }} aria-hidden="true" />
                                <span className="calendar-event-title">{event.title}</span>
                              </button>
                            ))}
                          </div>
                        }
                      >
                        <button type="button" className="calendar-more" onClick={(clickEvent) => clickEvent.stopPropagation()}>
                          +{rest.length} 更多
                        </button>
                      </Popover>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      {createDate ? (
        <Modal
          open
          title={`新建任务 · ${dayjs(createDate).format("M月D日")}`}
          okText="创建任务"
          cancelText="取消"
          confirmLoading={busy}
          onCancel={() => setCreateDate(null)}
          onOk={() => form.submit()}
          okButtonProps={{ disabled: !data.canCreate }}
        >
          {!data.canCreate ? (
            <Alert type="warning" showIcon title="当前账号没有可归属的组织，暂时不能新建任务" style={{ marginBottom: 16 }} />
          ) : null}
          <Form form={form} layout="vertical" initialValues={initialCreateValues()} onFinish={onCreate}>
            <Form.Item name="title" label="任务标题" rules={[{ required: true, whitespace: true, message: "请输入任务标题" }]}>
              <Input maxLength={240} placeholder="这条任务要做什么" autoFocus />
            </Form.Item>
            <Flex gap="middle" wrap>
              <Form.Item name="priority" label="优先级" style={{ flex: 1, minWidth: 140 }}>
                <Select
                  options={[
                    { value: "P0", label: "P0 · 阻断" },
                    { value: "P1", label: "P1 · 重要" },
                    { value: "P2", label: "P2 · 一般" },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name="dueDate"
                label="截止日期"
                rules={[{ required: true, message: "请选择截止日期" }]}
                style={{ flex: 1, minWidth: 160 }}
              >
                <DatePicker style={{ width: "100%" }} />
              </Form.Item>
            </Flex>
            {isAdmin ? (
              <Form.Item name="orgId" label="所属组织" rules={[{ required: true, message: "请选择所属组织" }]}>
                <Select
                  options={data.organizations.map((item) => ({ value: item.id, label: item.name }))}
                  placeholder="选择组织"
                  onChange={(orgId: string) => {
                    const nextOwner = data.members.find(
                      (member) => member.isActive && member.orgId === orgId && member.role !== "admin",
                    )?.id;
                    form.setFieldValue("ownerId", nextOwner ?? undefined);
                  }}
                />
              </Form.Item>
            ) : null}
            {canPickOwner ? (
              <Form.Item name="ownerId" label="负责人" rules={[{ required: true, message: "请选择负责人" }]}>
                <Select showSearch={{ optionFilterProp: "label" }} options={ownerOptions} placeholder="选择负责人" />
              </Form.Item>
            ) : null}
          </Form>
        </Modal>
      ) : null}
    </Flex>
  );
}

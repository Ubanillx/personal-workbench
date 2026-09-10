import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
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
type Me = { id: string; role: UserRole };

export function TasksPage(): React.ReactElement {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<Collaborator[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("P1");
  const [ownerId, setOwnerId] = useState("");
  const [status, setStatus] = useState("all");
  const [assignee, setAssignee] = useState("all");
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
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
  const create = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    void createTask({ title: title.trim(), priority, ownerId: ownerId || "unassigned" })
      .then((task) => {
        setTasks((items) => [task, ...items]);
        setTitle("");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "创建失败"))
      .finally(() => setBusy(false));
  };
  if (loading)
    return (
      <section className="page-section">
        <div className="loading-inline">正在加载任务…</div>
      </section>
    );
  return (
    <section className="page-section">
      <div className="eyebrow">WORK</div>
      <h1>任务进展</h1>
      <p className="page-subtitle">派发、进度、验收和沟通都保留在同一条时间线中。</p>
      <form className="create-row" onSubmit={create}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="新任务标题" />
        <select value={priority} onChange={(e) => setPriority(e.target.value as Task["priority"])}>
          <option>P0</option>
          <option>P1</option>
          <option>P2</option>
        </select>
        {me?.role === "owner" && <AssigneeSelect value={ownerId} members={members} onChange={setOwnerId} />}
        <button disabled={!title.trim() || busy}>{busy ? "创建中…" : "创建任务"}</button>
      </form>
      <div className="filter-row">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">全部状态</option>
          {Object.entries(labels).map(([key, value]) => (
            <option key={key} value={key}>
              {value}
            </option>
          ))}
        </select>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="all">全部负责人</option>
          <option value="mine">我的任务</option>
          <option value="unassigned">未分配</option>
          {me?.role === "owner" &&
            members
              .filter((m) => m.role !== "viewer")
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
        </select>
        {me?.role === "owner" && (
          <label>
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> 显示归档
          </label>
        )}
      </div>
      {error && (
        <div className="error-panel">
          {error}
          <button className="secondary" onClick={load}>
            重试
          </button>
        </div>
      )}
      <div className="collection">
        {filtered.length ? (
          filtered.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onOpen={() => {
                setSelected(task);
                void markNotificationsRead({ taskId: task.id });
              }}
            />
          ))
        ) : (
          <div className="empty-panel">
            <strong>没有符合条件的任务</strong>
            <p>调整筛选条件，或先创建一条任务。</p>
          </div>
        )}
      </div>
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
        />
      )}
    </section>
  );
}

function AssigneeSelect({
  value,
  members,
  onChange,
}: {
  value: string;
  members: Collaborator[];
  onChange: (value: string) => void;
}): React.ReactElement {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">未分配</option>
      <option value="owner">主人</option>
      {members
        .filter((m) => m.role === "assistant" && m.isActive)
        .map((m) => (
          <option value={m.id} key={m.id}>
            {m.name}
          </option>
        ))}
    </select>
  );
}
function TaskCard({ task, onOpen }: { task: Task; onOpen: () => void }): React.ReactElement {
  const overdue = Boolean(task.dueDate && task.dueDate < new Date().toISOString().slice(0, 10) && task.status !== "completed");
  return (
    <article className={`item-card task-item ${overdue ? "overdue-card" : ""}`}>
      <button className="task-main" onClick={onOpen}>
        <strong>{task.title}</strong>
        <p>
          {task.ownerName ?? "未分配"} · {task.priority} · {labels[task.status]}
          {overdue ? " · 已逾期" : ""}
          {task.archivedAt ? " · 已归档" : ""}
        </p>
        <div className="progress-track">
          <span style={{ width: `${task.progress}%` }} />
        </div>
      </button>
      <span>{task.progress}%</span>
    </article>
  );
}

function TaskDetail({
  task,
  me,
  members,
  onClose,
  onChanged,
  onRemoved,
}: {
  task: Task;
  me: Me | null;
  members: Collaborator[];
  onClose: () => void;
  onChanged: (task: Task) => void;
  onRemoved: (id: string) => void;
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
  return (
    <div className="detail-backdrop" role="dialog" aria-modal="true">
      <aside className="detail-panel">
        <div className="detail-head">
          <div>
            <div className="eyebrow">TASK DETAIL</div>
            <h2>{task.title}</h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            ×
          </button>
        </div>
        {error && <div className="error-panel">{error}</div>}
        {owner && !task.archivedAt && (
          <section className="task-edit">
            <h3>任务信息与改派</h3>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="任务说明" />
            <div className="form-grid">
              <select value={priority} onChange={(e) => setPriority(e.target.value as Task["priority"])}>
                <option>P0</option>
                <option>P1</option>
                <option>P2</option>
              </select>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              <AssigneeSelect value={ownerId} members={members} onChange={setOwnerId} />
            </div>
            <button
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
            </button>
          </section>
        )}
        <p className="detail-meta">
          负责人：{task.ownerName ?? "未分配"} · {task.priority} · {labels[task.status]}
          {task.dueDate ? ` · 截止 ${task.dueDate}` : ""}
        </p>
        <div className="detail-progress">
          <strong>{task.progress}%</strong>
          <div className="progress-track">
            <span style={{ width: `${task.progress}%` }} />
          </div>
        </div>
        {canProgress && (
          <div className="progress-editor">
            <input type="range" min="0" max="100" value={progress} onChange={(e) => setProgress(Number(e.target.value))} />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选：进展说明" />
            <button
              disabled={busy || (progress === task.progress && !note.trim())}
              onClick={() => run(() => postTaskProgress(task.id, { progress, ...(note.trim() ? { note: note.trim() } : {}) }))}
            >
              保存 {progress}%
            </button>
          </div>
        )}
        {task.status === "pending_review" && owner && (
          <div className="review-actions">
            <button disabled={busy} onClick={() => window.confirm("确认通过验收吗？") && run(() => approveTask(task.id))}>
              通过验收
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                const reason = window.prompt("退回说明", "请补充完成情况后重新提交");
                if (reason !== null) run(() => returnTask(task.id, reason));
              }}
            >
              退回修改
            </button>
          </div>
        )}
        {owner && (
          <div className="owner-actions">
            {task.archivedAt ? (
              <>
                <button className="secondary" onClick={() => run(() => restoreTask(task.id))}>
                  恢复任务
                </button>
                <button
                  className="danger-button"
                  onClick={() => {
                    if (window.confirm("彻底删除后无法恢复，继续吗？")) {
                      setBusy(true);
                      void deleteTask(task.id)
                        .then(() => onRemoved(task.id))
                        .catch((e: unknown) => setError(e instanceof Error ? e.message : "删除失败"))
                        .finally(() => setBusy(false));
                    }
                  }}
                >
                  彻底删除
                </button>
              </>
            ) : (
              <button
                className="danger-button"
                onClick={() => {
                  if (window.confirm("归档后可恢复，确定吗？")) {
                    setBusy(true);
                    void archiveTask(task.id)
                      .then(() => onRemoved(task.id))
                      .catch((e: unknown) => setError(e instanceof Error ? e.message : "归档失败"))
                      .finally(() => setBusy(false));
                  }
                }}
              >
                归档任务
              </button>
            )}
          </div>
        )}
        <h3>协作时间线</h3>
        <div className="activity-list">
          {activity.length ? (
            activity.map((item) => (
              <div className="activity-item" key={`${item.kind}-${item.id}`}>
                <strong>
                  {item.authorName ?? "系统"}
                  {eventLabels[item.kind] ? ` · ${eventLabels[item.kind]}` : ""}
                </strong>
                <small>{new Date(item.createdAt).toLocaleString()}</small>
                <p>
                  {item.content}
                  {item.progress !== null && `（${item.progress}%）`}
                </p>
              </div>
            ))
          ) : (
            <p className="muted">暂无记录</p>
          )}
        </div>
        <form
          className="comment-form"
          onSubmit={(e) => {
            e.preventDefault();
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
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="添加评论" />
          <button disabled={!comment.trim() || busy}>发送</button>
        </form>
      </aside>
    </div>
  );
}

export function TodosPage(): React.ReactElement {
  const [items, setItems] = useState<Todo[]>([]);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const load = (): void => {
    void getTodos()
      .then(setItems)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "加载失败"));
  };
  useEffect(load, []);
  return (
    <section className="page-section">
      <div className="eyebrow">TODAY</div>
      <h1>待办清单</h1>
      {error ? (
        <div className="error-panel">
          {error}
          <button className="secondary" onClick={load}>
            重试
          </button>
        </div>
      ) : (
        <>
          <form
            className="create-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!value.trim()) return;
              void createTodo({ content: value.trim(), todoDate: new Date().toISOString().slice(0, 10) }).then((item) => {
                setItems((all) => [item, ...all]);
                setValue("");
              });
            }}
          >
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="添加一条今日待办" />
            <button disabled={!value.trim()}>添加</button>
          </form>
          <div className="collection">
            {items.length ? (
              items.map((item) => (
                <article className="item-card" key={item.id}>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={item.isCompleted}
                      onChange={(e) =>
                        void updateTodo(item.id, { isCompleted: e.target.checked }).then((updated) =>
                          setItems((all) => all.map((x) => (x.id === updated.id ? updated : x))),
                        )
                      }
                    />
                    <span className={item.isCompleted ? "completed" : ""}>{item.content}</span>
                  </label>
                  <button
                    className="icon-button danger"
                    onClick={() =>
                      window.confirm("确定删除吗？") &&
                      void deleteTodo(item.id).then(() => setItems((all) => all.filter((x) => x.id !== item.id)))
                    }
                  >
                    ×
                  </button>
                </article>
              ))
            ) : (
              <div className="empty-panel">
                <strong>暂无待办</strong>
                <p>添加一条今天要完成的事情。</p>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
export function NotesPage(): React.ReactElement {
  const [items, setItems] = useState<Note[]>([]);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const load = (): void => {
    void getNotes()
      .then(setItems)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "加载失败"));
  };
  useEffect(load, []);
  return (
    <section className="page-section">
      <div className="eyebrow">CAPTURE</div>
      <h1>随手记</h1>
      {error ? (
        <div className="error-panel">
          {error}
          <button className="secondary" onClick={load}>
            重试
          </button>
        </div>
      ) : (
        <>
          <form
            className="note-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!value.trim()) return;
              void createNote({ content: value.trim() }).then((item) => {
                setItems((all) => [item, ...all]);
                setValue("");
              });
            }}
          >
            <textarea value={value} onChange={(e) => setValue(e.target.value)} placeholder="记录想法、会议要点或临时事项" />
            <button disabled={!value.trim()}>保存记录</button>
          </form>
          <div className="collection">
            {items.length ? (
              items.map((item) => (
                <article className="note-card" key={item.id}>
                  <p>{item.content}</p>
                  <button
                    className="icon-button danger"
                    onClick={() =>
                      window.confirm("确定删除吗？") &&
                      void deleteNote(item.id).then(() => setItems((all) => all.filter((x) => x.id !== item.id)))
                    }
                  >
                    ×
                  </button>
                </article>
              ))
            ) : (
              <div className="empty-panel">
                <strong>暂无随手记</strong>
                <p>记录会议要点或临时想法。</p>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

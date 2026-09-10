import type React from "react";
import { useEffect, useState } from "react";
import { getDashboard, type DashboardData, createTodo } from "../services/apiClient";

export function DashboardPage(): React.ReactElement {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [detail, setDetail] = useState("正在读取工作台数据");
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    let active = true;
    void getDashboard()
      .then((next) => {
        if (active) {
          setStatus("ready");
          setDetail(`已连接，当前用户：${next.user.name}`);
          setData(next);
        }
      })
      .catch(() => {
        if (active) {
          setStatus("error");
          setDetail("暂时无法连接 Node API");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="page-section">
      <div className="eyebrow">PERSONAL WORKBENCH</div>
      <h1>个人工作台</h1>
      <p className="page-subtitle">任务、待办和随手记已接入 SQLite。</p>
      <div className={`status-panel status-${status}`}>
        <span className="status-dot" aria-hidden="true" />
        <div>
          <strong>工作台状态</strong>
          <p>{detail}</p>
        </div>
      </div>
      {data && (
        <div className="dashboard-grid">
          <div className="stat-card">
            <strong>{data.stats.activeTasks}</strong>
            <span>进行中任务</span>
          </div>
          <div className="stat-card">
            <strong>{data.stats.pendingTodos}</strong>
            <span>待办</span>
          </div>
          <div className="stat-card">
            <strong>{data.stats.notes}</strong>
            <span>随手记</span>
          </div>
          <div className="data-panel">
            <h2>最近任务</h2>
            {data.tasks.slice(0, 6).map((task) => (
              <div className="data-row" key={task.id}>
                <span>{task.title}</span>
                <small>{task.progress}%</small>
              </div>
            ))}
          </div>
          <div className="data-panel">
            <h2>待办清单</h2>
            <TodoQuickList
              todos={data.todos}
              onCreated={(todo) =>
                setData((current) =>
                  current
                    ? {
                        ...current,
                        todos: [todo, ...current.todos],
                        stats: { ...current.stats, pendingTodos: current.stats.pendingTodos + 1 },
                      }
                    : current,
                )
              }
            />
          </div>
        </div>
      )}
    </section>
  );
}

function TodoQuickList({
  todos,
  onCreated,
}: {
  todos: DashboardData["todos"];
  onCreated: (todo: DashboardData["todos"][number]) => void;
}): React.ReactElement {
  const [value, setValue] = useState("");
  return (
    <div>
      <form
        className="quick-todo"
        onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim()) return;
          void createTodo({ content: value.trim(), todoDate: new Date().toISOString().slice(0, 10) }).then((todo) => {
            onCreated(todo);
            setValue("");
          });
        }}
      >
        <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="添加今日待办" />
        <button type="submit">添加</button>
      </form>
      {todos.slice(0, 5).map((todo) => (
        <div className="data-row" key={todo.id}>
          <span className={todo.isCompleted ? "completed" : ""}>{todo.content}</span>
          <small>{todo.isCompleted ? "已完成" : "待处理"}</small>
        </div>
      ))}
    </div>
  );
}

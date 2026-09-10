import type React from "react";
import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { DashboardPage } from "./pages/DashboardPage";
import { NotesPage, TasksPage, TodosPage } from "./pages/WorkbenchPages";
import { AccessPage, CollaborationPage, FilesPage, InboxPage, ReviewPage } from "./pages/MorePages";
import { ReportsPage } from "./pages/ReportsPage";
import { access, getMe, getNotifications, markNotificationsRead, type Notification } from "./services/apiClient";

const pages = [
  ["/", "每日概览"],
  ["/tasks", "任务进展"],
  ["/todos", "待办清单"],
  ["/notes", "随手记"],
  ["/inbox", "企微收件箱"],
  ["/reports", "周报/总结"],
  ["/collaboration", "协作管理"],
  ["/files", "重要文件"],
  ["/review", "回顾统计"],
] as const;

export function App(): React.ReactElement {
  const developmentPreview = typeof window !== "undefined" && window.location.port === "5173";
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [user, setUser] = useState<{ id: string; name: string; role: "owner" | "assistant" | "viewer" } | null>(null);
  const [token, setToken] = useState("");
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const refreshNotifications = () => {
    if (!user) return;
    void getNotifications(true)
      .then(setNotifications)
      .catch(() => undefined);
  };
  useEffect(() => {
    void getMe()
      .then((result) => {
        setUser(result.user);
        setAuthenticated(true);
      })
      .catch(() => setAuthenticated(false));
  }, []);
  useEffect(() => {
    if (!user) return;
    refreshNotifications();
    const timer = window.setInterval(refreshNotifications, 30000);
    return () => window.clearInterval(timer);
  }, [user]);
  if (authenticated === null) return <div className="loading-screen">正在连接工作台…</div>;
  if (!authenticated || !user)
    return (
      <AccessScreen
        developmentPreview={developmentPreview}
        token={token}
        setToken={setToken}
        onAccess={(nextUser) => {
          setUser(nextUser);
          setAuthenticated(true);
        }}
      />
    );
  const visiblePages = pages.filter(
    ([to]) =>
      user.role === "owner" ||
      (user.role === "assistant" && (to === "/" || to === "/tasks" || to === "/inbox" || to === "/reports")) ||
      (user.role === "viewer" && (to === "/" || to === "/tasks")),
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark">台</div>
        <div className="brand-copy">
          <strong>个人工作台</strong>
          <span>Web 版基础架构</span>
        </div>
        <nav className="nav-list" aria-label="主导航">
          {visiblePages.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === "/"}>
              {label}
            </NavLink>
          ))}
          <NavLink to="/access">访问验证</NavLink>
          <NotificationIndicator
            notifications={notifications}
            onRead={(id) => {
              void markNotificationsRead({ ids: [id] }).then(refreshNotifications);
            }}
          />
        </nav>
      </aside>
      <main className="main-content">
        {developmentPreview && (
          <div className="development-banner">
            开发预览仅供本机调试。日常操作请使用正式地址 <code>http://127.0.0.1:17500</code>。
          </div>
        )}
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/todos" element={<TodosPage />} />
          <Route path="/notes" element={<NotesPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/collaboration" element={<CollaborationPage />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/access" element={<AccessPage onLogout={() => setAuthenticated(false)} />} />
        </Routes>
      </main>
    </div>
  );
}

function NotificationIndicator({
  notifications,
  onRead,
}: {
  notifications: Notification[];
  onRead: (id: string) => void;
}): React.ReactElement {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  return (
    <div className="notification-wrap">
      <button className="notification-indicator" onClick={() => setOpen((value) => !value)}>
        通知 {notifications.length ? <span>{notifications.length}</span> : null}
      </button>
      {open && (
        <div className="notification-popover">
          <strong>最近提醒</strong>
          {notifications.length ? (
            notifications.slice(0, 8).map((item) => (
              <button
                className="notification-item"
                key={item.id}
                onClick={() => {
                  setOpen(false);
                  onRead(item.id);
                  if (item.reportId) navigate("/reports");
                  else if (item.taskId) navigate(`/tasks?task=${item.taskId}`);
                }}
              >
                {item.title}
                <small>{item.message}</small>
              </button>
            ))
          ) : (
            <p className="muted">暂无未读通知</p>
          )}
        </div>
      )}
    </div>
  );
}

function AccessScreen({
  developmentPreview,
  token,
  setToken,
  onAccess,
}: {
  developmentPreview: boolean;
  token: string;
  setToken: (value: string) => void;
  onAccess: (user: { id: string; name: string; role: "owner" | "assistant" | "viewer" }) => void;
}): React.ReactElement {
  const [error, setError] = useState("");
  return (
    <main className="access-screen">
      <section className="access-panel">
        <div className="brand-mark">台</div>
        <h1>访问个人工作台</h1>
        {developmentPreview && (
          <p className="development-banner">
            当前是开发预览。日常请使用 <code>http://127.0.0.1:17500</code>。
          </p>
        )}
        <p>请输入主人或协作者的访问令牌。</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setError("");
            void access(token)
              .then((result) => onAccess(result.user))
              .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "令牌无效"));
          }}
        >
          <input autoFocus value={token} onChange={(event) => setToken(event.target.value)} placeholder="访问令牌" />
          <button type="submit" disabled={!token.trim()}>
            进入工作台
          </button>
        </form>
        {error && <p className="error-text">{error}</p>}
      </section>
    </main>
  );
}

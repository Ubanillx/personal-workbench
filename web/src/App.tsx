import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  Alert,
  App as AntdApp,
  Avatar,
  Badge,
  Button,
  Card,
  Dropdown,
  Empty,
  Form,
  Input,
  Layout,
  Menu,
  Space,
  Spin,
  Tag,
  Typography,
  type MenuProps,
} from "antd";
import {
  BarChartOutlined,
  BellOutlined,
  CheckSquareOutlined,
  DashboardOutlined,
  EditOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  InboxOutlined,
  LockOutlined,
  LogoutOutlined,
  TeamOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { DashboardPage } from "./pages/DashboardPage";
import { NotesPage, TasksPage, TodosPage } from "./pages/WorkbenchPages";
import { AccessPage, CollaborationPage, FilesPage, InboxPage, ReviewPage } from "./pages/MorePages";
import { ReportsPage } from "./pages/ReportsPage";
import { access, getMe, getNotifications, logout, markNotificationsRead, type Notification } from "./services/apiClient";

type SessionUser = { id: string; name: string; role: "owner" | "assistant" | "viewer" };

/** 导航项：路径、标题、图标、可见角色（owner 全部可见） */
const pages: Array<{ to: string; label: string; icon: React.ReactNode; roles: Array<SessionUser["role"]> }> = [
  { to: "/", label: "每日概览", icon: <DashboardOutlined />, roles: ["owner", "assistant", "viewer"] },
  { to: "/tasks", label: "任务进展", icon: <CheckSquareOutlined />, roles: ["owner", "assistant", "viewer"] },
  { to: "/todos", label: "待办清单", icon: <UnorderedListOutlined />, roles: ["owner"] },
  { to: "/notes", label: "随手记", icon: <EditOutlined />, roles: ["owner"] },
  { to: "/inbox", label: "企微收件箱", icon: <InboxOutlined />, roles: ["owner", "assistant"] },
  { to: "/reports", label: "周报/总结", icon: <FileTextOutlined />, roles: ["owner", "assistant"] },
  { to: "/collaboration", label: "协作管理", icon: <TeamOutlined />, roles: ["owner"] },
  { to: "/files", label: "重要文件", icon: <FolderOpenOutlined />, roles: ["owner"] },
  { to: "/review", label: "回顾统计", icon: <BarChartOutlined />, roles: ["owner"] },
];

const roleLabel: Record<SessionUser["role"], string> = { owner: "主人", assistant: "助理", viewer: "查看者" };
const roleColor: Record<SessionUser["role"], string> = { owner: "blue", assistant: "green", viewer: "default" };

export function App(): React.ReactElement {
  const developmentPreview = typeof window !== "undefined" && window.location.port === "5173";
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    void getMe()
      .then((result) => {
        setUser(result.user);
        setAuthenticated(true);
      })
      .catch(() => setAuthenticated(false));
  }, []);

  if (authenticated === null) {
    return (
      <div className="center-screen">
        <Spin size="large" />
        <Typography.Text type="secondary">正在连接工作台…</Typography.Text>
      </div>
    );
  }
  if (!authenticated || !user) {
    return <AccessScreen developmentPreview={developmentPreview} onAccess={setUser} />;
  }
  return (
    <WorkbenchShell
      user={user}
      developmentPreview={developmentPreview}
      onLogout={() => {
        setUser(null);
        setAuthenticated(false);
      }}
    />
  );
}

function WorkbenchShell({
  user,
  developmentPreview,
  onLogout,
}: {
  user: SessionUser;
  developmentPreview: boolean;
  onLogout: () => void;
}): React.ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const { modal } = AntdApp.useApp();
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const refreshNotifications = (): void => {
    void getNotifications(true)
      .then(setNotifications)
      .catch(() => undefined);
  };
  useEffect(() => {
    refreshNotifications();
    const timer = window.setInterval(refreshNotifications, 30000);
    return () => window.clearInterval(timer);
  }, []);

  const visiblePages = pages.filter((page) => page.roles.includes(user.role));
  const menuItems: MenuProps["items"] = visiblePages.map((page) => ({
    key: page.to,
    icon: page.icon,
    label: page.label,
  }));
  const selectedKey = visiblePages.find((page) => page.to === location.pathname)?.to ?? location.pathname;

  const notificationItems: MenuProps["items"] = notifications.length
    ? notifications.slice(0, 8).map((item) => ({
        key: item.id,
        label: (
          <div className="notification-entry">
            <Typography.Text strong>{item.title}</Typography.Text>
            <Typography.Text type="secondary" className="notification-message">
              {item.message}
            </Typography.Text>
          </div>
        ),
        onClick: () => {
          void markNotificationsRead({ ids: [item.id] }).then(refreshNotifications);
          if (item.reportId) navigate("/reports");
          else if (item.taskId) navigate(`/tasks?task=${item.taskId}`);
        },
      }))
    : [{ key: "empty", disabled: true, label: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无未读通知" /> }];

  return (
    <Layout className="app-shell">
      <Layout.Sider theme="light" width={228} className="app-sider" breakpoint="lg" collapsedWidth={0}>
        <div className="brand">
          <Avatar shape="square" size={36} className="brand-avatar">
            台
          </Avatar>
          <div className="brand-copy">
            <Typography.Text strong>个人工作台</Typography.Text>
            <Typography.Text type="secondary" className="brand-sub">
              Node 全栈版
            </Typography.Text>
          </div>
        </div>
        <Menu mode="inline" items={menuItems} selectedKeys={[selectedKey]} onClick={({ key }) => navigate(key)} className="app-menu" />
      </Layout.Sider>

      <Layout>
        <Layout.Header className="app-header">
          <Space size="middle" align="center">
            {developmentPreview && <Tag color="orange">开发预览</Tag>}
          </Space>
          <Space size="middle" align="center">
            <Dropdown menu={{ items: notificationItems }} trigger={["click"]} placement="bottomRight">
              <Badge count={notifications.length} size="small" offset={[-2, 2]}>
                <Button variant="text" icon={<BellOutlined />} aria-label="通知" />
              </Badge>
            </Dropdown>
            <Space size="small" align="center">
              <Avatar size="small" className="brand-avatar">
                {user.name.slice(0, 1)}
              </Avatar>
              <Typography.Text>{user.name}</Typography.Text>
              <Tag color={roleColor[user.role]}>{roleLabel[user.role]}</Tag>
            </Space>
            <Button
              variant="text"
              icon={<LogoutOutlined />}
              onClick={() =>
                modal.confirm({
                  title: "退出当前账户？",
                  content: "退出后需要重新输入访问令牌。",
                  okText: "退出",
                  cancelText: "取消",
                  onOk: () => {
                    void logout()
                      .catch(() => undefined)
                      .finally(onLogout);
                  },
                })
              }
            >
              退出
            </Button>
          </Space>
        </Layout.Header>

        <Layout.Content className="app-content">
          {developmentPreview && (
            <Alert
              type="warning"
              showIcon
              closable
              className="dev-banner"
              title="开发预览仅供本机调试"
              description={
                <>
                  日常操作请使用正式地址 <Typography.Text code>http://127.0.0.1:17500</Typography.Text>。
                </>
              }
            />
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
            <Route path="/access" element={<AccessPage onLogout={onLogout} />} />
          </Routes>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}

function AccessScreen({
  developmentPreview,
  onAccess,
}: {
  developmentPreview: boolean;
  onAccess: (user: SessionUser) => void;
}): React.ReactElement {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigation = useNavigate();
  const menuItems = useMemo(() => [{ key: "hint", disabled: true, label: "输入令牌后进入工作台" }], []);

  return (
    <div className="center-screen">
      <Card className="access-card">
        <Space orientation="vertical" size="large" className="access-stack">
          <Space orientation="vertical" size={4} align="center" className="access-brand">
            <Avatar shape="square" size={48} className="brand-avatar">
              台
            </Avatar>
            <Typography.Title level={4} className="access-title">
              访问个人工作台
            </Typography.Title>
            <Typography.Text type="secondary">请输入主人或协作者的访问令牌</Typography.Text>
          </Space>
          {developmentPreview && (
            <Alert
              type="warning"
              showIcon
              title="当前是开发预览"
              description={
                <>
                  日常请使用 <Typography.Text code>http://127.0.0.1:17500</Typography.Text>。
                </>
              }
            />
          )}
          <Form
            layout="vertical"
            onFinish={() => {
              setError("");
              setBusy(true);
              void access(token)
                .then((result) => onAccess(result.user))
                .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "令牌无效"))
                .finally(() => setBusy(false));
            }}
          >
            <Form.Item label="访问令牌" {...(error ? { validateStatus: "error" as const, help: error } : {})}>
              <Input
                autoFocus
                prefix={<LockOutlined />}
                value={token}
                placeholder="访问令牌"
                onChange={(event) => setToken(event.target.value)}
              />
            </Form.Item>
            <Button color="primary" variant="solid" htmlType="submit" block loading={busy} disabled={!token.trim()}>
              进入工作台
            </Button>
          </Form>
          <Menu items={menuItems} selectable={false} className="access-hint" />
          <Button variant="link" onClick={() => navigation("/access")}>
            已登录其它账户？前往访问验证页
          </Button>
        </Space>
      </Card>
    </div>
  );
}

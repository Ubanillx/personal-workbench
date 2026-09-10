import type React from "react";
import { Links, Meta, NavLink, Outlet, Scripts, ScrollRestoration, useLoaderData, useLocation, useNavigate } from "react-router";
import {
  App as AntdApp,
  Avatar,
  Badge,
  Button,
  ConfigProvider,
  Dropdown,
  Empty,
  Layout as AntdLayout,
  Menu,
  Space,
  Tag,
  Typography,
  type MenuProps,
  type ThemeConfig,
} from "antd";
import zhCN from "antd/locale/zh_CN";
import {
  BarChartOutlined,
  BellOutlined,
  CheckSquareOutlined,
  DashboardOutlined,
  EditOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  InboxOutlined,
  LogoutOutlined,
  TeamOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { db, rows } from "./lib/db.server";
import { currentUser } from "./lib/ui.server";
import "./styles/layout.css";

dayjs.locale("zh-cn");

/** 沿用旧版手写样式的品牌色（#185fa5），其余交给 antd 默认体系 */
const workbenchTheme: ThemeConfig = {
  token: { colorPrimary: "#185fa5", colorInfo: "#185fa5", borderRadius: 6, fontSize: 14, controlHeight: 34 },
  components: {
    Layout: { headerBg: "#ffffff", siderBg: "#ffffff", bodyBg: "#f5f7fa" },
    Menu: { itemBg: "transparent", itemSelectedBg: "#e7f1fb", itemSelectedColor: "#185fa5" },
  },
};

type NavItem = { to: string; label: string; icon: React.ReactNode; roles: Array<"owner" | "assistant" | "viewer"> };

const NAV: NavItem[] = [
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

/** Phase 3 逐页迁移：只有已迁移的路径出现在导航里，避免点了 404 */
const MIGRATED_PATHS = new Set(["/"]);

const ROLE_LABEL = { owner: "主人", assistant: "助理", viewer: "查看者" } as const;
const ROLE_COLOR: Record<"owner" | "assistant" | "viewer", string> = { owner: "blue", assistant: "green", viewer: "default" };

type SessionUser = { id: string; name: string; role: "owner" | "assistant" | "viewer"; isActive: boolean };
type UnreadNotification = { id: string; taskId: string | null; reportId: string | null; title: string; message: string };

export async function loader({ request }: { request: Request }) {
  const user = currentUser(request);
  if (!user) return { user: null, notifications: [] as UnreadNotification[] };
  const unread = rows<UnreadNotification>(
    db(),
    "SELECT id,task_id AS taskId,report_id AS reportId,event_type AS eventType,title,message,created_at AS createdAt FROM notifications WHERE recipient_id=? AND is_read=0 ORDER BY created_at DESC",
    user.id,
  );
  return { user: user as SessionUser, notifications: unread };
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#f5f7fa" />
        <title>个人工作台</title>
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  const { user, notifications } = useLoaderData<typeof loader>();
  return (
    <ConfigProvider locale={zhCN} theme={workbenchTheme} componentSize="medium">
      <AntdApp>{user ? <AuthenticatedShell user={user} notifications={notifications} /> : <Outlet />}</AntdApp>
    </ConfigProvider>
  );
}

function AuthenticatedShell({ user, notifications }: { user: SessionUser; notifications: UnreadNotification[] }): React.ReactElement {
  const location = useLocation();
  const navigate = useNavigate();

  const items: MenuProps["items"] = NAV.filter((item) => item.roles.includes(user.role) && MIGRATED_PATHS.has(item.to)).map((item) => ({
    key: item.to,
    icon: item.icon,
    label: item.label,
  }));

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
          void fetch("/api/notifications/read", {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ ids: [item.id] }),
          }).then(() => {
            if (item.reportId) navigate("/reports");
            else if (item.taskId) navigate(`/tasks?task=${item.taskId}`);
            else navigate(".");
          });
        },
      }))
    : [
        {
          key: "empty",
          disabled: true,
          label: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无未读通知" />,
        },
      ];

  const selected = NAV.find((item) => item.to === location.pathname)?.to ?? location.pathname;

  return (
    <AntdLayout className="app-shell">
      <AntdLayout.Sider theme="light" width={228} className="app-sider" breakpoint="lg" collapsedWidth={0}>
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
        <Menu mode="inline" items={items} selectedKeys={[selected]} onClick={({ key }) => navigate(key)} className="app-menu" />
      </AntdLayout.Sider>
      <AntdLayout>
        <AntdLayout.Header className="app-header">
          <Space size="middle" align="center">
            <NavLink to="/" style={{ color: "inherit" }}>
              <Typography.Text strong>每日概览</Typography.Text>
            </NavLink>
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
              <Tag color={ROLE_COLOR[user.role]}>{ROLE_LABEL[user.role]}</Tag>
            </Space>
            <form method="post" action="/logout">
              <Button variant="text" icon={<LogoutOutlined />} htmlType="submit">
                退出
              </Button>
            </form>
          </Space>
        </AntdLayout.Header>
        <AntdLayout.Content className="app-content">
          <Outlet />
        </AntdLayout.Content>
      </AntdLayout>
    </AntdLayout>
  );
}

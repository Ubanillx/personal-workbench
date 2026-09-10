import type React from "react";
import { useState } from "react";
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
  ApartmentOutlined,
  BarChartOutlined,
  BellOutlined,
  CheckSquareOutlined,
  DashboardOutlined,
  EditOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  InboxOutlined,
  LogoutOutlined,
  MenuOutlined,
  SettingOutlined,
  TeamOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { db, rows } from "./lib/db.server";
import { currentUser } from "./lib/ui.server";
import "./styles/layout.css";

dayjs.locale("zh-cn");

/**
 * 主题基线：品牌色沿用旧版手写样式的 #185fa5，其余按 Ant Design v6 的设计语言取值——
 * 控件高 32px、基础圆角 6px、浮层（卡片/弹窗）圆角 8px、表格表头 #fafafa，
 * 一律通过 Design Token 表达，不覆盖 antd 内部类名（见 docs/harness/CODE_STYLE.md §10.5）。
 */
const workbenchTheme: ThemeConfig = {
  token: {
    colorPrimary: "#185fa5",
    colorInfo: "#185fa5",
    borderRadius: 6,
    borderRadiusLG: 8,
    fontSize: 14,
    controlHeight: 32,
  },
  components: {
    Layout: { headerBg: "#ffffff", siderBg: "#ffffff", bodyBg: "#f5f7fa", headerHeight: 56, headerPadding: "0 16px" },
    Menu: { itemBg: "transparent", itemSelectedBg: "#e7f1fb", itemSelectedColor: "#185fa5", itemBorderRadius: 6, itemMarginInline: 8 },
    Table: { headerBg: "#fafafa", headerColor: "#1f1f1f", cellPaddingBlock: 12, cellPaddingInline: 16 },
    Card: { headerFontSize: 15 },
    Modal: { titleFontSize: 16 },
  },
};

type NavItem = { to: string; label: string; icon: React.ReactNode; roles: Array<"admin" | "manager" | "member"> };

const NAV: NavItem[] = [
  { to: "/", label: "每日概览", icon: <DashboardOutlined />, roles: ["admin", "manager", "member"] },
  { to: "/tasks", label: "任务进展", icon: <CheckSquareOutlined />, roles: ["admin", "manager", "member"] },
  { to: "/todos", label: "待办清单", icon: <UnorderedListOutlined />, roles: ["admin", "manager", "member"] },
  { to: "/notes", label: "随手记", icon: <EditOutlined />, roles: ["admin", "manager", "member"] },
  { to: "/inbox", label: "企微收件箱", icon: <InboxOutlined />, roles: ["admin", "manager", "member"] },
  { to: "/reports", label: "周报/总结", icon: <FileTextOutlined />, roles: ["admin", "manager", "member"] },
  { to: "/collaboration", label: "协作管理", icon: <TeamOutlined />, roles: ["admin", "manager"] },
  { to: "/organization", label: "组织管理", icon: <ApartmentOutlined />, roles: ["admin", "manager"] },
  { to: "/admin", label: "全局管理", icon: <SettingOutlined />, roles: ["admin"] },
  { to: "/files", label: "重要文件", icon: <FolderOpenOutlined />, roles: ["admin", "manager"] },
  { to: "/review", label: "回顾统计", icon: <BarChartOutlined />, roles: ["admin", "manager"] },
];

/** 尚未加入组织的人只能看「组织与申请」页（D-34），导航也只剩这一项 */
const NAV_JOIN_ONLY: NavItem = { to: "/join", label: "组织与申请", icon: <ApartmentOutlined />, roles: ["admin", "manager", "member"] };

/** 已实现的路径；未实现的路径不出现在导航里，避免点了 404 */
const MIGRATED_PATHS = new Set([
  "/",
  "/join",
  "/organization",
  "/admin",
  "/tasks",
  "/todos",
  "/notes",
  "/inbox",
  "/reports",
  "/collaboration",
  "/files",
  "/review",
]);

const ROLE_LABEL = { admin: "管理员", manager: "组织管理者", member: "普通用户" } as const;
const ROLE_COLOR: Record<"admin" | "manager" | "member", string> = { admin: "blue", manager: "green", member: "default" };

type SessionUser = {
  id: string;
  username: string;
  email: string;
  name: string;
  role: "admin" | "manager" | "member";
  orgId: string | null;
  orgName: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
};
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
  const [mobile, setMobile] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const navItems = user.role === "admin" || user.orgId ? NAV : [NAV_JOIN_ONLY];
  const items: MenuProps["items"] = navItems
    .filter((item) => item.roles.includes(user.role) && MIGRATED_PATHS.has(item.to))
    .map((item) => ({
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
      <AntdLayout.Sider
        theme="light"
        width={228}
        className="app-sider"
        breakpoint="lg"
        collapsedWidth={0}
        collapsed={collapsed}
        trigger={null}
        onBreakpoint={(broken) => {
          setMobile(broken);
          setCollapsed(broken);
        }}
      >
        <div className="brand">
          <Avatar shape="square" size={36} className="brand-avatar">
            台
          </Avatar>
          <div className="brand-copy">
            <Typography.Text strong>个人工作台</Typography.Text>
          </div>
        </div>
        <Menu
          mode="inline"
          items={items}
          selectedKeys={[selected]}
          onClick={({ key }) => {
            navigate(key);
            if (mobile) setCollapsed(true);
          }}
          className="app-menu"
        />
      </AntdLayout.Sider>
      <AntdLayout>
        <AntdLayout.Header className="app-header">
          <Space size="middle" align="center">
            {mobile ? (
              <Button
                color="default"
                variant="text"
                icon={<MenuOutlined />}
                aria-label={collapsed ? "展开导航" : "收起导航"}
                aria-expanded={!collapsed}
                onClick={() => setCollapsed(!collapsed)}
              />
            ) : null}
            <NavLink to="/" style={{ color: "inherit" }}>
              <Typography.Text strong>每日概览</Typography.Text>
            </NavLink>
          </Space>
          <Space size="small" align="center" className="header-actions">
            <Dropdown menu={{ items: notificationItems }} trigger={["click"]} placement="bottomRight">
              <Badge count={notifications.length} size="small" offset={[-2, 2]}>
                <Button color="default" variant="text" icon={<BellOutlined />} aria-label="通知" />
              </Badge>
            </Dropdown>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  { key: "password", label: "修改密码", onClick: () => navigate("/password") },
                  { key: "join", label: "组织与申请", onClick: () => navigate("/join") },
                ],
              }}
            >
              <Button color="default" variant="text" aria-label="账号菜单">
                <Avatar size="small" className="brand-avatar">
                  {user.name.slice(0, 1)}
                </Avatar>
                <span className="account-name">{user.name}</span>
              </Button>
            </Dropdown>
            <span className="account-details">
              <Tag color={ROLE_COLOR[user.role]}>{ROLE_LABEL[user.role]}</Tag>
              {user.orgName ? <Tag>{user.orgName}</Tag> : null}
            </span>
            <form method="post" action="/logout">
              <Button color="default" variant="text" icon={<LogoutOutlined />} htmlType="submit">
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

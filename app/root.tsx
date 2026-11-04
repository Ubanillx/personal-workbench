import type React from "react";
import { useState } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData, useLocation, useNavigate } from "react-router";
import {
  App as AntdApp,
  Avatar,
  Button,
  ConfigProvider,
  Dropdown,
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
  CalendarOutlined,
  CheckSquareOutlined,
  DashboardOutlined,
  EditOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  LogoutOutlined,
  MenuOutlined,
  SettingOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import type { Notification } from "../shared/types/domain";
import { BrandLogo, brandLogoUrl } from "./components/brand-logo";
import { NotificationBell } from "./components/notification-bell";
import { db } from "./lib/db.server";
import { listNotifications } from "./lib/notifications.server";
import { currentUser } from "./lib/ui.server";
import "./styles/layout.css";
// 表格排版基线的兜底层（裁剪 / 收缩）：`dataTable()` 的配套样式，全站所有表格共用
import "./styles/table-layout.css";

dayjs.locale("zh-cn");

/**
 * 主题基线（03 靛蓝）：主色 #4053a8，页面底色 #eef0f7，其余按 Ant Design v6 的设计语言取值——
 * 控件高 36px（小型控件 32px）、基础圆角 6px、浮层（卡片/弹窗）圆角 8px、表格表头 #f1f3fa，
 * 一律通过 Design Token 表达，不覆盖 antd 内部类名（见 docs/harness/CODE_STYLE.md §10.5）。
 */
const workbenchTheme: ThemeConfig = {
  token: {
    colorPrimary: "#4053a8",
    colorPrimaryHover: "#5064bd",
    colorPrimaryActive: "#33438c",
    colorPrimaryText: "#33438c",
    colorPrimaryTextHover: "#5064bd",
    colorPrimaryTextActive: "#2a3775",
    colorPrimaryBg: "#e9edf9",
    colorPrimaryBgHover: "#dde4f6",
    colorPrimaryBorder: "#c3cdec",
    colorPrimaryBorderHover: "#a5b4e0",
    colorInfo: "#4053a8",
    colorInfoBg: "#e9edf9",
    colorInfoBorder: "#c3cdec",
    colorInfoText: "#33438c",
    colorLink: "#4053a8",
    colorLinkHover: "#5064bd",
    colorLinkActive: "#33438c",
    colorText: "#232838",
    colorTextHeading: "#232838",
    colorTextSecondary: "#5c6478",
    colorTextTertiary: "#7c8497",
    colorTextQuaternary: "#9aa2b3",
    colorTextLabel: "#5c6478",
    colorTextDescription: "#5c6478",
    colorTextPlaceholder: "#9aa2b3",
    colorTextDisabled: "#c0c6d4",
    colorBgLayout: "#eef0f7",
    colorBgContainer: "#ffffff",
    colorBgElevated: "#ffffff",
    colorBgContainerDisabled: "#e9edf5",
    colorBorder: "#dde2ee",
    colorBorderSecondary: "#e7ebf4",
    colorSplit: "#e7ebf4",
    colorFillContent: "#eef0f7",
    colorFillContentHover: "#e7eaf4",
    colorFillAlter: "#f4f6fb",
    colorFillSecondary: "#e9edf5",
    colorFillTertiary: "#eef0f7",
    colorFillQuaternary: "#f8f9fc",
    borderRadius: 6,
    borderRadiusLG: 8,
    // 大屏工作台采用略宽松的点击基线，避免按钮和表单控件显得过小。
    fontSize: 15,
    controlHeight: 36,
    controlHeightSM: 32,
    controlHeightLG: 40,
  },
  components: {
    Layout: { headerBg: "#f8f9fc", siderBg: "#f8f9fc", bodyBg: "#eef0f7", headerHeight: 60, headerPadding: "0 20px" },
    Menu: {
      itemBg: "transparent",
      itemSelectedBg: "#e9edf9",
      itemSelectedColor: "#4053a8",
      itemBorderRadius: 6,
      itemMarginInline: 8,
      itemHeight: 44,
    },
    Table: {
      headerBg: "#f1f3fa",
      headerColor: "#232838",
      headerSplitColor: "#dde2ee",
      borderColor: "#dde2ee",
      rowHoverBg: "#f6f8fd",
      cellPaddingBlock: 12,
      cellPaddingInline: 16,
    },
    Card: { headerFontSize: 15 },
    Modal: { titleFontSize: 16 },
  },
};

type NavItem = { to: string; label: string; icon: React.ReactNode; roles: Array<"admin" | "manager" | "member"> };

const NAV: NavItem[] = [
  { to: "/", label: "每日概览", icon: <DashboardOutlined />, roles: ["admin", "manager", "member"] },
  // 「任务进展」页内含企微导入（页头抽屉），因此不再单独列出企微收件箱这一页
  { to: "/tasks", label: "任务进展", icon: <CheckSquareOutlined />, roles: ["admin", "manager", "member"] },
  { to: "/calendar", label: "日历", icon: <CalendarOutlined />, roles: ["admin", "manager", "member"] },
  { to: "/todos", label: "待办清单", icon: <UnorderedListOutlined />, roles: ["admin", "manager", "member"] },
  { to: "/notes", label: "随手记", icon: <EditOutlined />, roles: ["admin", "manager", "member"] },
  { to: "/reports", label: "周报/总结", icon: <FileTextOutlined />, roles: ["admin", "manager", "member"] },
  { to: "/settings", label: "设置", icon: <SettingOutlined />, roles: ["admin", "manager"] },
  { to: "/files", label: "重要文件", icon: <FolderOpenOutlined />, roles: ["admin", "manager"] },
];

/** 已实现的路径；未实现的路径不出现在导航里，避免点了 404 */
const MIGRATED_PATHS = new Set(["/", "/join", "/settings", "/tasks", "/calendar", "/todos", "/notes", "/reports", "/files", "/review"]);

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

export async function loader({ request }: { request: Request }) {
  const user = currentUser(request);
  if (!user) return { user: null, notifications: [] as Notification[] };
  const unread = listNotifications(db(), user, true);
  return { user: user as SessionUser, notifications: unread };
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#eef0f7" />
        <link rel="icon" type="image/png" href={brandLogoUrl} />
        <link rel="apple-touch-icon" href={brandLogoUrl} />
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
  // 未入组的普通账号只能待在 /join（或强制改密 /password），用全屏页而不是带侧栏的工作台壳
  const inWorkbench = Boolean(user && (user.role === "admin" || user.orgId));
  return (
    <ConfigProvider locale={zhCN} theme={workbenchTheme} componentSize="medium">
      <AntdApp>{inWorkbench && user ? <AuthenticatedShell user={user} notifications={notifications} /> : <Outlet />}</AntdApp>
    </ConfigProvider>
  );
}

function AuthenticatedShell({ user, notifications }: { user: SessionUser; notifications: Notification[] }): React.ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const [mobile, setMobile] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const items: MenuProps["items"] = NAV.filter((item) => item.roles.includes(user.role) && MIGRATED_PATHS.has(item.to)).map((item) => ({
    key: item.to,
    icon: item.icon,
    label: item.label,
  }));

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
          <BrandLogo height={28} />
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
      <AntdLayout className="app-body">
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
          </Space>
          <Space size="small" align="center" className="header-actions">
            <NotificationBell initial={notifications} />
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

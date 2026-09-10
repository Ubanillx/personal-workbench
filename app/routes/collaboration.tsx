import type React from "react";
import { useLoaderData, useRevalidator } from "react-router";
import { Alert, Button, Card, Descriptions, Empty, Flex, Space, Table, Tag, Typography, type TableProps } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { OrganizationStatus, UserRole } from "../../shared/types/domain";
import { accessInfoPayload } from "../lib/access.server";
import { listAllAccounts, listJoinRequests, listMembers, listOrganizations } from "../lib/organization.server";
import { requireManagerOrRedirect } from "../lib/ui.server";

/**
 * 协作管理页 —— 原「成员管理 + 长期令牌」，令牌登录已整体退役（`access_tokens` 表已删），
 * 页面新定位是**只读的协作入口**（docs/harness/ACCOUNTS_AND_ORGS.md §8）：
 *
 * - 组织管理者 / 管理员：本组织信息 + 成员只读概览 + 待审批数量 + 去 `/organization` 办理；
 * - 管理员（全局角色，不隶属组织）：全部组织概览 + 全部账号概览 + 局域网访问地址（仅管理员可见）；
 * - 未加入组织的账号：本页门禁会先送到 `/join`（D-34），页面不再处理这种视角。
 *
 * 成员与申请的规则都在 `app/lib/organization.server.ts`，本页只读，不提供任何写操作。
 */

const ROLE_LABEL: Record<UserRole, string> = { admin: "管理员", manager: "组织管理者", member: "普通用户" };
const STATUS_LABEL: Record<OrganizationStatus, string> = { active: "正常", archived: "已解散" };
const STATUS_COLOR: Record<OrganizationStatus, string> = { active: "green", archived: "default" };

type MemberRow = {
  id: string;
  username: string;
  email: string;
  name: string;
  role: UserRole;
  orgId: string | null;
  orgName: string | null;
  isActive: number;
};

export async function loader({ request }: { request: Request }) {
  const user = requireManagerOrRedirect(request);
  const isAdmin = user.role === "admin";
  const organizations = listOrganizations(user);
  // 组织管理者固定看自己的组织；管理员没有组织，改为看全部组织的概览
  const current = user.orgId ? (organizations.find((org) => org.id === user.orgId) ?? null) : null;
  const members = user.orgId ? (listMembers(user.orgId) as unknown as MemberRow[]) : [];
  const accounts = isAdmin ? (listAllAccounts() as unknown as MemberRow[]) : [];
  const pending = user.orgId ? listJoinRequests(user, { orgId: user.orgId, status: "pending" }) : [];

  return {
    me: { id: user.id, name: user.name, username: user.username, role: user.role, orgId: user.orgId, orgName: user.orgName },
    isAdmin,
    organizations,
    current,
    members,
    accounts,
    pendingCount: pending.length,
    access: isAdmin ? accessInfoPayload() : null,
  };
}

export default function CollaborationRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const memberColumns: TableProps<MemberRow>["columns"] = [
    { title: "姓名", dataIndex: "name", key: "name", render: (_value, member) => <Typography.Text strong>{member.name}</Typography.Text> },
    {
      title: "用户名",
      dataIndex: "username",
      key: "username",
      render: (_value, member) => <Typography.Text code>{member.username}</Typography.Text>,
    },
    { title: "邮箱", dataIndex: "email", key: "email" },
    {
      title: "角色",
      dataIndex: "role",
      key: "role",
      render: (_value, member) => (
        <Tag color={member.role === "manager" ? "green" : "default"} variant="filled">
          {ROLE_LABEL[member.role]}
        </Tag>
      ),
    },
    {
      title: "状态",
      dataIndex: "isActive",
      key: "isActive",
      render: (_value, member) => (
        <Tag color={member.isActive === 1 ? "green" : "default"} variant="filled">
          {member.isActive === 1 ? "启用中" : "已停用"}
        </Tag>
      ),
    },
  ];

  const orgColumns: TableProps<(typeof data.organizations)[number]>["columns"] = [
    { title: "组织名称", dataIndex: "name", key: "name", render: (_value, org) => <Typography.Text strong>{org.name}</Typography.Text> },
    { title: "说明", dataIndex: "description", key: "description", render: (_value, org) => org.description || "—" },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      render: (_value, org) => (
        <Tag color={STATUS_COLOR[org.status]} variant="filled">
          {STATUS_LABEL[org.status]}
        </Tag>
      ),
    },
    { title: "成员", dataIndex: "memberCount", key: "memberCount", render: (_value, org) => `${org.memberCount ?? 0} 人` },
    {
      title: "创建时间",
      dataIndex: "createdAt",
      key: "createdAt",
      render: (_value, org) => dayjs(org.createdAt).format("YYYY-MM-DD HH:mm"),
    },
  ];

  const accountColumns: TableProps<MemberRow>["columns"] = [
    {
      title: "姓名",
      dataIndex: "name",
      key: "name",
      render: (_value, account) => <Typography.Text strong>{account.name}</Typography.Text>,
    },
    {
      title: "用户名",
      dataIndex: "username",
      key: "username",
      render: (_value, account) => <Typography.Text code>{account.username}</Typography.Text>,
    },
    {
      title: "所属组织",
      dataIndex: "orgName",
      key: "orgName",
      render: (_value, account) => account.orgName ?? <Typography.Text type="secondary">未加入</Typography.Text>,
    },
    {
      title: "角色",
      dataIndex: "role",
      key: "role",
      render: (_value, account) => (
        <Tag color={account.role === "admin" ? "blue" : account.role === "manager" ? "green" : "default"} variant="filled">
          {ROLE_LABEL[account.role]}
        </Tag>
      ),
    },
    {
      title: "状态",
      dataIndex: "isActive",
      key: "isActive",
      render: (_value, account) => (
        <Tag color={account.isActive === 1 ? "green" : "default"} variant="filled">
          {account.isActive === 1 ? "启用中" : "已停用"}
        </Tag>
      ),
    },
  ];

  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <div>
        <Typography.Text type="secondary">COLLABORATION</Typography.Text>
        <Typography.Title level={3} className="page-title">
          协作管理
        </Typography.Title>
        <Typography.Text type="secondary">
          这里是协作概览：旧的令牌登录已经取消（access_tokens 表已删除），成员与组织的增删改统一在「组织管理」页办理，本页只做只读展示。
        </Typography.Text>
      </div>

      <Alert
        type="info"
        showIcon
        title={
          data.isAdmin
            ? `当前身份：管理员（全局角色，不隶属组织）· ${data.me.name}`
            : `当前身份：${ROLE_LABEL[data.me.role]} · ${data.me.name} · 组织「${data.current?.name ?? data.me.orgName ?? "未加入"}」`
        }
        description={
          data.isAdmin
            ? "管理员可以查看全部组织与账号，创建/解散/恢复组织在「全局管理」页，成员与申请在「组织管理」页。"
            : "你可以查看本组织成员；审批申请、停用账号、调整角色、拉人入组都在「组织管理」页。密码由本人在登录后自助修改，忘记密码需在本机用 CLI 重置。"
        }
        action={
          <Button icon={<ReloadOutlined />} onClick={() => void revalidator.revalidate()}>
            刷新
          </Button>
        }
      />

      {data.current ? (
        <Card
          variant="outlined"
          title="我的组织"
          extra={
            <Tag color={STATUS_COLOR[data.current.status]} variant="filled">
              {STATUS_LABEL[data.current.status]}
            </Tag>
          }
        >
          <Space orientation="vertical" size="middle" className="page-stack">
            <Descriptions
              column={2}
              items={[
                { key: "name", label: "组织名称", children: data.current.name },
                { key: "role", label: "我的角色", children: ROLE_LABEL[data.me.role] },
                { key: "count", label: "成员人数", children: `${data.members.length} 人` },
                { key: "pending", label: "待审批申请", children: `${data.pendingCount} 条` },
                { key: "description", label: "组织说明", children: data.current.description || "—", span: 2 },
              ]}
            />

            <Flex gap="small" wrap>
              <Button color="primary" variant="solid" href="/organization">
                去组织管理页
              </Button>
              <Button href="/join">查看我的申请</Button>
            </Flex>

            {data.members.length ? (
              <Table<MemberRow> rowKey="id" columns={memberColumns} dataSource={data.members} pagination={false} />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本组织还没有成员" />
            )}
          </Space>
        </Card>
      ) : (
        <Card variant="outlined" title="组织概览">
          <Space orientation="vertical" size="middle" className="page-stack">
            <Typography.Text type="secondary">管理员不隶属任何组织，这里是全部组织的只读概览。</Typography.Text>
            {data.organizations.length ? (
              <Table rowKey="id" columns={orgColumns} dataSource={data.organizations} pagination={false} />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有任何组织" />
            )}
            <Flex gap="small" wrap>
              <Button color="primary" variant="solid" href="/organization">
                去组织管理页
              </Button>
              <Button href="/admin">去全局管理页</Button>
            </Flex>
          </Space>
        </Card>
      )}

      {data.access && (
        <Card variant="outlined" title="局域网访问地址（仅管理员可见）">
          <Space orientation="vertical" size="small" className="list-block">
            <Flex align="center" gap="small" wrap>
              <Typography.Text type="secondary">本机</Typography.Text>
              <Typography.Text code copyable={{ text: data.access.localUrl }}>
                {data.access.localUrl}
              </Typography.Text>
            </Flex>
            {data.access.lanUrls.length ? (
              data.access.lanUrls.map((url) => (
                <Flex key={url} align="center" gap="small" wrap>
                  <Typography.Text type="secondary">局域网</Typography.Text>
                  <Typography.Text code copyable={{ text: url }}>
                    {url}
                  </Typography.Text>
                </Flex>
              ))
            ) : (
              <Typography.Text type="secondary">
                未检测到局域网地址：需要以 <Typography.Text code>npm run start:lan</Typography.Text>（HOST=0.0.0.0）启动才会显示。
              </Typography.Text>
            )}
            <Typography.Text type="secondary">{data.access.warning}</Typography.Text>
          </Space>
        </Card>
      )}

      {data.isAdmin && (
        <Card variant="outlined" title="账号概览">
          <Space orientation="vertical" size="small" className="list-block">
            <Typography.Text type="secondary">
              全部账号（含管理员与未加入组织的账号）。账号密码只能在本机用 <Typography.Text code>npm run user:passwd</Typography.Text>{" "}
              重置。
            </Typography.Text>
            <Table<MemberRow>
              rowKey="id"
              columns={accountColumns}
              dataSource={data.accounts}
              pagination={{ pageSize: 20, showSizeChanger: false }}
            />
          </Space>
        </Card>
      )}
    </Space>
  );
}

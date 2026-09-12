import type React from "react";
import { useEffect } from "react";
import { redirect, useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  type TableProps,
} from "antd";
import { LogoutOutlined, PlusOutlined, UndoOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { JoinRequestKind, JoinRequestStatus, OrganizationStatus, UserRole } from "../../shared/types/domain";
import { BrandLogo } from "../components/brand-logo";
import { IconActionButton, RowActions } from "../components/crud-actions";
import { PageHeader } from "../components/page-header";
import { appConfig } from "../lib/context.server";
import { readPayload } from "../lib/form.server";
import {
  cancelJoinRequest,
  createJoinRequest,
  createLeaveRequest,
  listJoinRequests,
  listMembers,
  listOrganizations,
  type OrgFailure,
} from "../lib/organization.server";
import { requireAuth } from "../lib/session.server";

/**
 * 入组页 —— 未加入组织的账号**唯一**能访问的页面（D-34）。
 *
 * 组织与申请的规则全部在 app/lib/organization.server.ts 里，本页 loader/action 直接调函数
 * （不绕自己的 HTTP API），避免规则出现两份实现。
 * 三种视角：无组织用户（全屏入组，无工作台侧栏）、已有组织用户（组织信息 + 成员 + 申请退出）、
 * 管理员（全局角色，不隶属任何组织，只看组织总览）。
 */

const ROLE_LABEL: Record<UserRole, string> = { admin: "管理员", manager: "组织管理者", member: "普通用户" };
const KIND_LABEL: Record<JoinRequestKind, string> = { join: "申请加入", leave: "申请退出", invite: "被加入" };
const STATUS_LABEL: Record<JoinRequestStatus, string> = {
  pending: "待审批",
  approved: "已通过",
  rejected: "已拒绝",
  cancelled: "已撤回/作废",
};
const STATUS_COLOR: Record<JoinRequestStatus, string> = {
  pending: "gold",
  approved: "green",
  rejected: "red",
  cancelled: "default",
};

type OrgRow = {
  id: string;
  name: string;
  description: string;
  status: OrganizationStatus;
  memberCount: number;
};
type RequestRow = {
  id: string;
  kind: JoinRequestKind;
  orgName: string;
  status: JoinRequestStatus;
  message: string;
  createdAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string;
};
type MemberRow = { id: string; name: string; username: string; role: UserRole; isActive: boolean };

function loginUrl(request: Request): string {
  const url = new URL(request.url);
  return `/login?redirectTo=${encodeURIComponent(`${url.pathname}${url.search}`)}`;
}

function textField(data: unknown, key: string): string {
  if (data && typeof data === "object" && key in data) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/** OrgFailure 里的响应已经带好了 code/message，这里只把文案取出来给页面显示 */
async function failureMessage(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return payload?.error?.message ?? "操作失败，请稍后重试";
}

export async function loader({ request }: { request: Request }) {
  const auth = requireAuth(request, appConfig().sessionCookieName, { skipPasswordGate: true });
  if (!auth.ok) throw redirect(loginUrl(request));
  const user = auth.user;
  // 改密是所有操作的前置条件，这里不再往外跳，避免 /join ⇄ /password 相互重定向
  if (user.mustChangePassword) throw redirect("/password");

  const organizations: OrgRow[] = listOrganizations(user).map((org) => ({
    id: org.id,
    name: org.name,
    description: org.description,
    status: org.status,
    memberCount: org.memberCount ?? 0,
  }));
  // 本页只展示「我自己」的申请：管理员与组织管理者从各自范围能看到的条数更多，这里统一按 user_id 过滤
  const requests: RequestRow[] = listJoinRequests(user)
    .filter((item) => item.userId === user.id)
    .slice(0, 20)
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      orgName: item.orgName ?? "—",
      status: item.status,
      message: item.message,
      createdAt: item.createdAt,
      decidedAt: item.decidedAt,
      decidedByName: item.decidedByName,
      decisionNote: item.decisionNote,
    }));
  // 成员名单只给组织管理者看，与 GET /api/organizations/:id/members 的权限保持一致
  const members: MemberRow[] =
    user.orgId && user.role === "manager"
      ? listMembers(user.orgId).map((row) => ({
          id: String(row.id),
          name: String(row.name),
          username: String(row.username ?? ""),
          role: String(row.role) as UserRole,
          isActive: Number(row.isActive) === 1,
        }))
      : [];

  return {
    user: { name: user.name, username: user.username, role: user.role, orgId: user.orgId, orgName: user.orgName },
    organizations,
    requests,
    members,
    orgMemberCount: organizations.find((org) => org.id === user.orgId)?.memberCount ?? 0,
  };
}

export async function action({ request }: { request: Request }): Promise<{ error: string } | { notice: string }> {
  const auth = requireAuth(request, appConfig().sessionCookieName, { skipPasswordGate: true });
  if (!auth.ok) throw redirect(loginUrl(request));
  const user = auth.user;
  if (user.mustChangePassword) throw redirect("/password");

  const payload = await readPayload(request);
  const intent = String(payload.intent ?? "");
  const message = payload.message;
  let result: { ok: true } | OrgFailure;
  if (intent === "join") result = createJoinRequest(user, String(payload.orgId ?? ""), message);
  else if (intent === "leave") result = createLeaveRequest(user, message);
  else if (intent === "cancel") result = cancelJoinRequest(user, String(payload.id ?? ""));
  else return { error: "未知操作" };

  if (!result.ok) return { error: await failureMessage(result.response) };
  if (intent === "cancel") return { notice: "申请已撤回" };
  if (intent === "leave") return { notice: "退出申请已提交，请等待管理者审批" };
  return { notice: "申请已提交，请等待管理者审批" };
}

export default function JoinRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const { message } = AntdApp.useApp();
  const busy = navigation.state !== "idle";
  const error = textField(actionData, "error");
  const notice = textField(actionData, "notice");

  useEffect(() => {
    if (notice) void message.success(notice);
    if (error) void message.error(error);
  }, [notice, error, message]);

  const pending = data.requests.find((item) => item.status === "pending") ?? null;
  const hasOrg = Boolean(data.user.orgId);
  const canJoin = !hasOrg && data.user.role !== "admin";
  const selectableOrgs = data.organizations.filter((org) => org.status === "active");

  const orgColumns: TableProps<OrgRow>["columns"] = [
    { title: "组织", dataIndex: "name", key: "name", render: (_value, org) => <Typography.Text strong>{org.name}</Typography.Text> },
    { title: "简介", dataIndex: "description", key: "description", render: (_value, org) => org.description || "—" },
    { title: "成员", dataIndex: "memberCount", key: "memberCount", render: (_value, org) => `${org.memberCount} 人` },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      render: (_value, org) => (
        <Tag color={org.status === "active" ? "green" : "default"} variant="filled">
          {org.status === "active" ? "正常" : "已解散"}
        </Tag>
      ),
    },
  ];

  const requestColumns: TableProps<RequestRow>["columns"] = [
    { title: "组织", dataIndex: "orgName", key: "orgName" },
    { title: "类型", dataIndex: "kind", key: "kind", render: (_value, row) => KIND_LABEL[row.kind] },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      render: (_value, row) => (
        <Tag color={STATUS_COLOR[row.status]} variant="filled">
          {STATUS_LABEL[row.status]}
        </Tag>
      ),
    },
    {
      title: "提交时间",
      dataIndex: "createdAt",
      key: "createdAt",
      render: (_value, row) => dayjs(row.createdAt).format("YYYY-MM-DD HH:mm"),
    },
    {
      title: "处理结果",
      key: "decision",
      render: (_value, row) =>
        row.decidedAt
          ? `${row.decidedByName ?? "管理者"} · ${dayjs(row.decidedAt).format("MM-DD HH:mm")}${row.decisionNote ? ` · ${row.decisionNote}` : ""}`
          : "—",
    },
    {
      title: "操作",
      key: "actions",
      width: 120,
      align: "right",
      render: (_value, row) =>
        row.status === "pending" ? (
          <RowActions
            actions={[
              {
                key: "cancel",
                label: "撤回",
                render: (
                  <Popconfirm
                    title="撤回这条申请？"
                    okText="撤回"
                    cancelText="取消"
                    onConfirm={() => submit({ intent: "cancel", id: row.id }, { method: "post", encType: "application/json" })}
                  >
                    <IconActionButton label="撤回" icon={<UndoOutlined />} tone="danger" disabled={busy} />
                  </Popconfirm>
                ),
              },
            ]}
          />
        ) : null,
    },
  ];

  const memberColumns: TableProps<MemberRow>["columns"] = [
    { title: "姓名", dataIndex: "name", key: "name" },
    {
      title: "用户名",
      dataIndex: "username",
      key: "username",
      render: (_value, row) => <Typography.Text code>{row.username}</Typography.Text>,
    },
    { title: "角色", dataIndex: "role", key: "role", render: (_value, row) => ROLE_LABEL[row.role] },
    {
      title: "状态",
      dataIndex: "isActive",
      key: "isActive",
      render: (_value, row) => (
        <Tag color={row.isActive ? "green" : "default"} variant="filled">
          {row.isActive ? "启用中" : "已停用"}
        </Tag>
      ),
    },
  ];

  const orgTable = <Table<OrgRow> rowKey="id" columns={orgColumns} dataSource={data.organizations} pagination={false} />;
  const requestTable = data.requests.length ? (
    <Table<RequestRow> rowKey="id" columns={requestColumns} dataSource={data.requests} pagination={false} />
  ) : (
    <Typography.Text type="secondary">还没有申请记录。</Typography.Text>
  );
  const pendingAlert = pending ? (
    <Alert
      type="info"
      showIcon
      title={`已向「${pending.orgName}」提交${KIND_LABEL[pending.kind]}，正在等待审批`}
      description="同一时间只能有一条待处理申请。可以继续等待，或在下方撤回后改选其他组织。"
    />
  ) : null;
  const joinForm = canJoin ? (
    <Card variant="outlined" title="申请加入组织">
      <Form
        layout="vertical"
        disabled={Boolean(pending)}
        onFinish={(values: { orgId?: string; message?: string }) => {
          if (!values.orgId || busy) return;
          submit({ intent: "join", orgId: values.orgId, message: values.message ?? "" }, { method: "post", encType: "application/json" });
        }}
      >
        <Form.Item name="orgId" label="组织" rules={[{ required: true, message: "请选择要加入的组织" }]}>
          <Select
            placeholder="请选择要加入的组织"
            options={selectableOrgs.map((org) => ({ value: org.id, label: `${org.name}（${org.memberCount} 人）` }))}
          />
        </Form.Item>
        <Form.Item name="message" label="申请说明（选填）">
          <Input.TextArea rows={3} maxLength={200} showCount placeholder="简单介绍一下自己，方便管理者审批" />
        </Form.Item>
        <Button color="primary" variant="solid" htmlType="submit" icon={<PlusOutlined />} loading={busy} block>
          提交申请
        </Button>
      </Form>
    </Card>
  ) : null;

  // 未入组用户没有工作台壳，本页单独做成全屏入组页
  if (canJoin) {
    return (
      <div className="join-screen">
        <Space orientation="vertical" size="large" className="join-panel">
          <Space orientation="vertical" size={8} align="center" className="join-brand">
            <BrandLogo height={40} />
            <Typography.Title level={4} className="access-title">
              加入组织
            </Typography.Title>
            <Typography.Text type="secondary">你好，{data.user.name}。选择一个组织提交申请，管理者通过后即可使用工作台。</Typography.Text>
          </Space>
          {error ? <Alert type="error" showIcon title={error} /> : null}
          {pendingAlert}
          {joinForm}
          <Card variant="outlined" title="组织列表">
            <Table<OrgRow>
              rowKey="id"
              columns={orgColumns}
              dataSource={data.organizations}
              pagination={false}
              scroll={{ x: "max-content" }}
            />
          </Card>
          <Card variant="outlined" title="我的申请">
            {data.requests.length ? (
              <Table<RequestRow>
                rowKey="id"
                columns={requestColumns}
                dataSource={data.requests}
                pagination={false}
                scroll={{ x: "max-content" }}
              />
            ) : (
              <Typography.Text type="secondary">还没有申请记录。</Typography.Text>
            )}
          </Card>
          <div className="join-brand">
            <form method="post" action="/logout">
              <Button color="default" variant="text" htmlType="submit" icon={<LogoutOutlined />}>
                退出登录
              </Button>
            </form>
          </div>
        </Space>
      </div>
    );
  }

  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <PageHeader
        title="组织与申请"
        eyebrow="ORGANIZATION"
        description={hasOrg ? `你属于「${data.user.orgName || ""}」，当前角色是${ROLE_LABEL[data.user.role]}。` : undefined}
      />
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {pendingAlert}
      {hasOrg ? (
        <Card variant="outlined" title="我的组织">
          <Space orientation="vertical" size="middle" className="list-block">
            <Descriptions
              column={2}
              items={[
                { key: "name", label: "组织名称", children: data.user.orgName || "—" },
                { key: "role", label: "我的角色", children: ROLE_LABEL[data.user.role] },
                { key: "count", label: "成员人数", children: `${data.orgMemberCount} 人` },
                { key: "account", label: "我的账号", children: data.user.username },
              ]}
            />
            {data.members.length > 0 ? (
              <Table<MemberRow> rowKey="id" columns={memberColumns} dataSource={data.members} pagination={false} />
            ) : null}
          </Space>
        </Card>
      ) : null}
      {hasOrg ? (
        <Card variant="outlined" title="申请退出组织">
          <Space orientation="vertical" size="middle" className="list-block">
            <Typography.Text type="secondary">退出需要管理者批准。批准后会回到未加入状态，之后可以再申请其他组织。</Typography.Text>
            <Form
              layout="vertical"
              disabled={Boolean(pending)}
              onFinish={(values: { message?: string }) => {
                if (busy) return;
                submit({ intent: "leave", message: values.message ?? "" }, { method: "post", encType: "application/json" });
              }}
            >
              <Form.Item name="message" label="退出原因（选填）">
                <Input.TextArea rows={3} maxLength={200} showCount placeholder="例如：换到别的组织 / 暂时不需要协助" />
              </Form.Item>
              <Button color="danger" variant="solid" htmlType="submit" icon={<LogoutOutlined />} loading={busy}>
                提交退出申请
              </Button>
            </Form>
          </Space>
        </Card>
      ) : null}
      {data.user.role === "admin" ? (
        <Alert type="info" showIcon title="管理员是全局角色" description="可直接在「设置」里管理组织和账号，不必申请加入某个组织。" />
      ) : null}
      <Card variant="outlined" title="组织列表">
        {orgTable}
      </Card>
      <Card variant="outlined" title="我的申请">
        {requestTable}
      </Card>
    </Space>
  );
}

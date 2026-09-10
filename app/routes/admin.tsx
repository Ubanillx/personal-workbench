import type React from "react";
import { useEffect } from "react";
import { useActionData, useLoaderData, useNavigation, useRevalidator, useSearchParams, useSubmit } from "react-router";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Empty,
  Flex,
  Form as AntdForm,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  type TableProps,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { Organization, OrganizationStatus, UserRole } from "../../shared/types/domain";
import { readPayload } from "../lib/form.server";
import {
  archiveOrganization,
  createOrganization,
  listAllAccounts,
  listOrganizations,
  restoreOrganization,
  type OrgFailure,
  type OrgSuccess,
} from "../lib/organization.server";
import { requireAdminOrRedirect } from "../lib/ui.server";

/**
 * 全局管理页（docs/harness/ACCOUNTS_AND_ORGS.md §8）：**仅管理员**。
 *
 * 内容：组织总览（创建 / 解散=归档 / 恢复）、账号总览（按组织筛选）、无组织账号清单。
 * 刻意**不提供**密码重置与「提升为管理员」入口——密码只能在本机用 `npm run user:passwd` 重置（D-23），
 * 管理员账号只由本机 CLI 管理（§4 第 4 条不变式）。
 *
 * 组织/账号的业务规则都在 `app/lib/organization.server.ts`，本页 loader / action 直接调用。
 */

const ROLE_LABEL: Record<UserRole, string> = { admin: "管理员", manager: "组织管理者", member: "普通用户" };
const STATUS_LABEL: Record<OrganizationStatus, string> = { active: "正常", archived: "已解散" };
const STATUS_COLOR: Record<OrganizationStatus, string> = { active: "green", archived: "default" };
const FILTER_ALL = "all";
const FILTER_NONE = "none";

/** 账号列表的视图行（SQL 的 is_active 是 0/1） */
type AccountRow = {
  id: string;
  username: string;
  email: string;
  name: string;
  role: UserRole;
  orgId: string | null;
  orgName: string | null;
  isActive: number;
  mustChangePassword: number;
  createdAt: string;
};

type ActionResult = { ok: true; notice: string } | { error: string };

/** OrgFailure 的响应体里已经带好了 code/message，这里只把文案取出来给页面显示 */
async function toActionResult(result: OrgSuccess<unknown> | OrgFailure, notice: string): Promise<ActionResult> {
  if (result.ok) return { ok: true, notice };
  const payload = (await result.response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return { error: payload?.error?.message ?? "操作失败，请稍后重试" };
}

export async function loader({ request }: { request: Request }) {
  const user = requireAdminOrRedirect(request);
  const url = new URL(request.url);
  const filter = url.searchParams.get("org") ?? FILTER_ALL;
  const organizations = listOrganizations(user);
  const all = listAllAccounts() as unknown as AccountRow[];

  const accounts =
    filter === FILTER_ALL
      ? all
      : filter === FILTER_NONE
        ? all.filter((account) => account.orgId === null)
        : all.filter((account) => account.orgId === filter);

  return {
    me: { id: user.id, name: user.name, username: user.username },
    organizations,
    filter,
    accounts,
    accountTotal: all.length,
    // 无组织账号（排除管理员自己：管理员是全局角色，不隶属组织，也不能被拉进组织）
    unassigned: all.filter((account) => account.orgId === null && account.role !== "admin"),
  };
}

export async function action({ request }: { request: Request }): Promise<ActionResult> {
  const user = requireAdminOrRedirect(request);
  const payload = await readPayload(request);
  const intent = String(payload.intent ?? "");
  const orgId = String(payload.orgId ?? "");
  const description = typeof payload.description === "string" ? payload.description : "";

  switch (intent) {
    case "create":
      return toActionResult(createOrganization(user, { name: payload.name, description }), "组织已创建");
    case "archive":
      return toActionResult(archiveOrganization(user, orgId), "组织已解散：成员已退回「未加入」状态，数据保留");
    case "restore":
      return toActionResult(restoreOrganization(user, orgId), "组织已恢复：成员需要重新申请或由管理者拉入");
    default:
      return { error: "未知操作" };
  }
}

export default function AdminRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submit = useSubmit();
  const [params, setParams] = useSearchParams();
  const [createForm] = AntdForm.useForm<{ name?: string; description?: string }>();
  const { message } = AntdApp.useApp();

  const busy = navigation.state !== "idle";
  const error = actionData && "error" in actionData ? actionData.error : "";

  // 依赖整个 actionData 对象：连续做两次同样的操作也要各弹一次提示
  useEffect(() => {
    if (actionData && "ok" in actionData) void message.success(actionData.notice);
  }, [actionData, message]);

  /** 所有写操作：action + useSubmit（action 完成后 RR8 自动重跑 loader，页面拿到新数据） */
  const post = (payload: Record<string, unknown>): void => {
    submit(payload as Parameters<typeof submit>[0], { method: "post", encType: "application/json" });
  };

  const setFilter = (value: string): void => {
    const next = new URLSearchParams(params);
    if (value === FILTER_ALL) next.delete("org");
    else next.set("org", value);
    setParams(next, { replace: true });
  };

  const orgColumns: TableProps<Organization>["columns"] = [
    {
      title: "组织名称",
      dataIndex: "name",
      key: "name",
      render: (_value, org) => <Typography.Text strong>{org.name}</Typography.Text>,
    },
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
    {
      title: "操作",
      key: "actions",
      render: (_value, org) =>
        org.status === "archived" ? (
          <Popconfirm
            title={`恢复组织「${org.name}」？`}
            description="恢复后组织重新可用，但成员不会自动回来，需要重新申请或由管理者拉入。"
            okText="恢复"
            cancelText="取消"
            onConfirm={() => post({ intent: "restore", orgId: org.id })}
          >
            <Button size="small" disabled={busy}>
              恢复
            </Button>
          </Popconfirm>
        ) : (
          <Popconfirm
            title={`解散组织「${org.name}」？`}
            description="成员会被退回未加入状态，数据保留但不可访问；只有管理员能恢复。"
            okText="解散"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => post({ intent: "archive", orgId: org.id })}
          >
            <Button size="small" color="danger" variant="outlined" disabled={busy}>
              解散（归档）
            </Button>
          </Popconfirm>
        ),
    },
  ];

  const accountColumns: TableProps<AccountRow>["columns"] = [
    {
      title: "用户名",
      dataIndex: "username",
      key: "username",
      render: (_value, account) => <Typography.Text code>{account.username}</Typography.Text>,
    },
    {
      title: "姓名",
      dataIndex: "name",
      key: "name",
      render: (_value, account) => <Typography.Text strong>{account.name}</Typography.Text>,
    },
    { title: "邮箱", dataIndex: "email", key: "email" },
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
      title: "所属组织",
      dataIndex: "orgName",
      key: "orgName",
      render: (_value, account) => account.orgName ?? <Typography.Text type="secondary">未加入</Typography.Text>,
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

  const unassignedColumns: TableProps<AccountRow>["columns"] = [
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
    { title: "邮箱", dataIndex: "email", key: "email" },
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

  const orgOptions = [
    { value: FILTER_ALL, label: `全部账号（${data.accountTotal}）` },
    { value: FILTER_NONE, label: `未加入任何组织（${data.unassigned.length}）` },
    ...data.organizations.map((org) => ({ value: org.id, label: `${org.name}${org.status === "archived" ? "（已解散）" : ""}` })),
  ];

  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <div>
        <Typography.Text type="secondary">ADMIN</Typography.Text>
        <Typography.Title level={3} className="page-title">
          全局管理
        </Typography.Title>
        <Typography.Text type="secondary">
          管理员是全局角色（不隶属任何组织）：这里管理组织与账号总览。账号密码只能在本机用{" "}
          <Typography.Text code>npm run user:passwd</Typography.Text> 重置，管理员账号同样只由本机 CLI 管理。
        </Typography.Text>
      </div>

      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void revalidator.revalidate()}>
              刷新
            </Button>
          }
        />
      )}

      <Card variant="outlined" title="创建组织">
        <AntdForm
          form={createForm}
          layout="inline"
          onFinish={(values: { name?: string; description?: string }) => {
            const name = values.name?.trim() ?? "";
            if (!name || busy) return;
            post({ intent: "create", name, description: values.description ?? "" });
            createForm.resetFields();
          }}
        >
          <AntdForm.Item name="name" rules={[{ required: true, message: "请输入组织名称" }]}>
            <Input maxLength={40} placeholder="组织名称（2-40 个字符）" style={{ width: 260 }} />
          </AntdForm.Item>
          <AntdForm.Item name="description">
            <Input maxLength={200} placeholder="组织说明（可选）" style={{ width: 320 }} />
          </AntdForm.Item>
          <AntdForm.Item>
            <Button color="primary" variant="solid" htmlType="submit" icon={<PlusOutlined />} disabled={busy}>
              创建组织
            </Button>
          </AntdForm.Item>
        </AntdForm>
      </Card>

      <Card variant="outlined" title={`组织总览（${data.organizations.length} 个）`}>
        {data.organizations.length ? (
          <Table<Organization> rowKey="id" columns={orgColumns} dataSource={data.organizations} pagination={false} />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有任何组织，先用上面的表单创建一个。" />
        )}
      </Card>

      <Card variant="outlined" title="无组织账号">
        <Space orientation="vertical" size="small" className="list-block">
          <Typography.Text type="secondary">
            这些账号还没有加入任何组织：可以到「组织管理」页选中目标组织后用「拉人入组」直接加入，或等他们在「加入组织」页提交申请。
          </Typography.Text>
          {data.unassigned.length ? (
            <>
              <Table<AccountRow> rowKey="id" columns={unassignedColumns} dataSource={data.unassigned} pagination={false} />
              <Flex gap="small" wrap>
                <Button href="/organization">去组织管理页拉人入组</Button>
              </Flex>
            </>
          ) : (
            <Typography.Text type="secondary">当前没有无组织账号。</Typography.Text>
          )}
        </Space>
      </Card>

      <Card
        variant="outlined"
        title="账号总览"
        extra={
          <Flex align="center" gap="small" wrap>
            <Typography.Text type="secondary">按组织筛选</Typography.Text>
            <Select value={data.filter} onChange={setFilter} style={{ width: 240 }} options={orgOptions} />
          </Flex>
        }
      >
        <Space orientation="vertical" size="small" className="list-block">
          <Table<AccountRow>
            rowKey="id"
            columns={accountColumns}
            dataSource={data.accounts}
            pagination={{ pageSize: 20, showSizeChanger: false }}
          />
          <Typography.Text type="secondary">
            共 {data.accounts.length} 个账号（全库 {data.accountTotal} 个）。
          </Typography.Text>
        </Space>
      </Card>
    </Space>
  );
}

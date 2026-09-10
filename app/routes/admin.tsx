import type React from "react";
import { useMemo, useState } from "react";
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
  Select,
  Space,
  Table,
  Tag,
  Typography,
  type MenuProps,
  type TableProps,
} from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, UserAddOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { Organization, OrganizationStatus, UserRole } from "../../shared/types/domain";
import { confirmDanger, RowActions } from "../components/crud-actions";
import { useCrudFeedback } from "../components/crud-hooks";
import { FormModal } from "../components/crud-modal";
import { TableToolbar } from "../components/crud-toolbar";
import { PageHeader } from "../components/page-header";
import { readPayload } from "../lib/form.server";
import {
  archiveOrganization,
  createOrganization,
  inviteMember,
  listAllAccounts,
  listOrganizations,
  restoreOrganization,
  updateOrganization,
  type OrgFailure,
  type OrgSuccess,
} from "../lib/organization.server";
import { requireAdminOrRedirect } from "../lib/ui.server";

/**
 * 全局管理页（docs/harness/ACCOUNTS_AND_ORGS.md §8）：**仅管理员**。
 *
 * 内容：组织总览（创建 / 编辑 / 解散=归档 / 恢复）、账号总览（按组织、角色、状态筛选；无组织账号可就地拉入组织）。
 * 刻意**不提供**密码重置与「提升为管理员」入口——密码只能在本机用 `npm run user:passwd` 重置（D-23），
 * 管理员账号只由本机 CLI 管理（§4 第 4 条不变式）。
 *
 * 组织/账号的业务规则都在 `app/lib/organization.server.ts`，本页 loader / action 直接调用。
 */

const ROLE_LABEL: Record<UserRole, string> = { admin: "管理员", manager: "组织管理者", member: "普通用户" };
const ROLE_COLOR: Record<UserRole, string> = { admin: "blue", manager: "green", member: "default" };
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
    case "rename":
      return toActionResult(updateOrganization(user, orgId, { name: payload.name, description }), "组织信息已保存");
    case "archive":
      return toActionResult(archiveOrganization(user, orgId), "组织已解散：成员已退回「未加入」状态，数据保留");
    case "restore":
      return toActionResult(restoreOrganization(user, orgId), "组织已恢复：成员需要重新申请或由管理者拉入");
    case "invite":
      // 把无组织账号直接拉进指定组织（与 /organization 页共用同一份规则）
      return toActionResult(inviteMember(user, orgId, String(payload.accountId ?? "")), "已把该账号拉入组织");
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
  const { modal } = AntdApp.useApp();
  const [createForm] = AntdForm.useForm<{ name?: string; description?: string }>();
  const [editForm] = AntdForm.useForm<{ name?: string; description?: string }>();
  const [inviteForm] = AntdForm.useForm<{ accountId?: string; orgId?: string }>();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Organization | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");

  const { error } = useCrudFeedback(actionData, () => {
    setCreateOpen(false);
    setEditing(null);
    setInviteOpen(false);
  });
  const busy = navigation.state !== "idle";
  const activeOrganizations = data.organizations.filter((org) => org.status === "active");

  const post = (payload: Record<string, unknown>): void => {
    submit(payload as Parameters<typeof submit>[0], { method: "post", encType: "application/json" });
  };

  const setFilter = (value: string): void => {
    const next = new URLSearchParams(params);
    if (value === FILTER_ALL) next.delete("org");
    else next.set("org", value);
    setParams(next, { replace: true });
  };

  const accounts = useMemo(
    () =>
      data.accounts.filter((account) => {
        if (keyword && !`${account.name}${account.username}${account.email}`.includes(keyword)) return false;
        if (roleFilter !== "all" && account.role !== roleFilter) return false;
        if (stateFilter === "active" && account.isActive !== 1) return false;
        if (stateFilter === "inactive" && account.isActive === 1) return false;
        return true;
      }),
    [data.accounts, keyword, roleFilter, stateFilter],
  );

  const orgColumns: TableProps<Organization>["columns"] = [
    {
      title: "组织名称",
      dataIndex: "name",
      key: "name",
      sorter: (a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"),
      render: (_value, org) => <Typography.Text strong>{org.name}</Typography.Text>,
    },
    { title: "说明", dataIndex: "description", key: "description", render: (_value, org) => org.description || "—" },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      filters: [
        { text: "正常", value: "active" },
        { text: "已解散", value: "archived" },
      ],
      onFilter: (value, org) => org.status === value,
      render: (_value, org) => (
        <Tag color={STATUS_COLOR[org.status]} variant="filled">
          {STATUS_LABEL[org.status]}
        </Tag>
      ),
    },
    {
      title: "成员",
      dataIndex: "memberCount",
      key: "memberCount",
      width: 100,
      sorter: (a, b) => (a.memberCount ?? 0) - (b.memberCount ?? 0),
      render: (_value, org) => `${org.memberCount ?? 0} 人`,
    },
    {
      title: "创建时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 170,
      sorter: (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)),
      render: (_value, org) => dayjs(org.createdAt).format("YYYY-MM-DD HH:mm"),
    },
    {
      title: "操作",
      key: "actions",
      width: 170,
      align: "right",
      render: (_value, org) => {
        const items: MenuProps["items"] = [
          {
            key: "edit",
            label: "编辑组织信息",
            icon: <EditOutlined />,
            onClick: () => setEditing(org),
          },
          { type: "divider" },
          org.status === "archived"
            ? {
                key: "restore",
                label: "恢复组织",
                onClick: () => post({ intent: "restore", orgId: org.id }),
              }
            : {
                key: "archive",
                label: "解散（归档）",
                danger: true,
                icon: <DeleteOutlined />,
                onClick: () =>
                  confirmDanger(modal, {
                    title: `解散组织「${org.name}」？`,
                    content: "成员会被退回未加入状态，数据保留但不可访问；之后只有管理员能恢复。",
                    okText: "解散",
                    onOk: () => post({ intent: "archive", orgId: org.id }),
                  }),
              },
        ];
        return (
          <RowActions
            disabled={busy}
            extra={
              org.status === "archived" ? (
                <Button size="small" color="default" variant="text" onClick={() => post({ intent: "restore", orgId: org.id })}>
                  恢复
                </Button>
              ) : (
                <Button size="small" color="default" variant="text" href={`/organization?org=${org.id}`}>
                  管理成员
                </Button>
              )
            }
            items={items}
          />
        );
      },
    },
  ];

  const accountColumns: TableProps<AccountRow>["columns"] = [
    {
      title: "姓名",
      dataIndex: "name",
      key: "name",
      sorter: (a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"),
      render: (_value, account) => (
        <Space size={4}>
          <Typography.Text strong>{account.name}</Typography.Text>
          {account.id === data.me.id ? <Tag color="blue">当前登录账号</Tag> : null}
        </Space>
      ),
    },
    {
      title: "用户名",
      dataIndex: "username",
      key: "username",
      render: (_value, account) => <Typography.Text code>{account.username}</Typography.Text>,
    },
    { title: "邮箱", dataIndex: "email", key: "email" },
    {
      title: "角色",
      dataIndex: "role",
      key: "role",
      width: 130,
      render: (_value, account) => (
        <Tag color={ROLE_COLOR[account.role]} variant="filled">
          {ROLE_LABEL[account.role]}
        </Tag>
      ),
    },
    {
      title: "所属组织",
      dataIndex: "orgName",
      key: "orgName",
      width: 160,
      render: (_value, account) => account.orgName ?? <Typography.Text type="secondary">未加入</Typography.Text>,
    },
    {
      title: "状态",
      dataIndex: "isActive",
      key: "isActive",
      width: 110,
      render: (_value, account) => (
        <Tag color={account.isActive === 1 ? "green" : "default"} variant="filled">
          {account.isActive === 1 ? "启用中" : "已停用"}
        </Tag>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 140,
      align: "right",
      render: (_value, account) =>
        account.orgId === null && account.role !== "admin" ? (
          <Button
            size="small"
            icon={<UserAddOutlined />}
            disabled={busy || activeOrganizations.length === 0}
            onClick={() => {
              inviteForm.setFieldsValue({ accountId: account.id, orgId: activeOrganizations.at(0)?.id ?? "" });
              setInviteOpen(true);
            }}
          >
            拉入组织
          </Button>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ];

  const orgOptions = [
    { value: FILTER_ALL, label: `全部账号（${data.accountTotal}）` },
    { value: FILTER_NONE, label: `未加入任何组织（${data.unassigned.length}）` },
    ...data.organizations.map((org) => ({ value: org.id, label: `${org.name}${org.status === "archived" ? "（已解散）" : ""}` })),
  ];

  return (
    <Flex vertical gap="large" className="page-stack">
      <PageHeader
        title="全局管理"
        description="管理全部组织，查看账号与成员归属。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => revalidator.revalidate()} loading={busy}>
              刷新
            </Button>
            <Button color="primary" variant="solid" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建组织
            </Button>
          </>
        }
      />

      {error ? <Alert type="error" showIcon title={error} /> : null}

      <Card
        variant="outlined"
        title={`组织总览（${data.organizations.length} 个）`}
        extra={<Typography.Text type="secondary">解散 = 归档，可恢复</Typography.Text>}
      >
        <Table<Organization>
          rowKey="id"
          size="middle"
          columns={orgColumns}
          dataSource={data.organizations}
          loading={busy}
          scroll={{ x: 960 }}
          pagination={{
            pageSize: 10,
            showSizeChanger: true,
            showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 条`,
          }}
          locale={{
            emptyText: (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有任何组织">
                <Button color="primary" variant="solid" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                  新建组织
                </Button>
              </Empty>
            ),
          }}
        />
      </Card>

      <Card
        variant="outlined"
        title="账号总览"
        extra={
          <Typography.Text type="secondary">
            共 {data.accountTotal} 个账号 · 无组织 {data.unassigned.length} 个
          </Typography.Text>
        }
      >
        <Flex vertical gap="middle">
          <TableToolbar
            extra={
              <Typography.Text type="secondary">
                显示 {accounts.length} / {data.accounts.length} 个
              </Typography.Text>
            }
          >
            <Input.Search
              allowClear
              placeholder="搜索姓名 / 用户名 / 邮箱"
              style={{ width: 260 }}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onSearch={(value) => setKeyword(value.trim())}
            />
            <Select value={data.filter} onChange={setFilter} style={{ width: 220 }} options={orgOptions} />
            <Select
              value={roleFilter}
              style={{ width: 140 }}
              onChange={setRoleFilter}
              options={[
                { value: "all", label: "全部角色" },
                { value: "admin", label: "管理员" },
                { value: "manager", label: "组织管理者" },
                { value: "member", label: "普通用户" },
              ]}
            />
            <Select
              value={stateFilter}
              style={{ width: 140 }}
              onChange={setStateFilter}
              options={[
                { value: "all", label: "全部状态" },
                { value: "active", label: "启用中" },
                { value: "inactive", label: "已停用" },
              ]}
            />
            {keyword || roleFilter !== "all" || stateFilter !== "all" || data.filter !== FILTER_ALL ? (
              <Button
                color="default"
                variant="text"
                onClick={() => {
                  setKeyword("");
                  setRoleFilter("all");
                  setStateFilter("all");
                  setFilter(FILTER_ALL);
                }}
              >
                重置
              </Button>
            ) : null}
          </TableToolbar>

          <Table<AccountRow>
            rowKey="id"
            size="middle"
            columns={accountColumns}
            dataSource={accounts}
            loading={busy}
            scroll={{ x: 1040 }}
            pagination={{
              pageSize: 10,
              showSizeChanger: true,
              showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 条`,
            }}
            locale={{
              emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的账号" />,
            }}
          />
        </Flex>
      </Card>

      <FormModal
        open={createOpen}
        title="新建组织"
        okText="创建"
        form={createForm}
        submitting={busy}
        error={error}
        onCancel={() => setCreateOpen(false)}
        onFinish={(values) => {
          const name = values.name?.trim() ?? "";
          if (!name) return;
          post({ intent: "create", name, description: values.description ?? "" });
        }}
      >
        <AntdForm.Item name="name" label="组织名称" rules={[{ required: true, message: "请输入组织名称" }]}>
          <Input maxLength={40} showCount placeholder="2-40 个字符，例如：华东销售组" />
        </AntdForm.Item>
        <AntdForm.Item name="description" label="组织说明">
          <Input.TextArea rows={3} maxLength={200} showCount placeholder="可选：这个组织负责什么" />
        </AntdForm.Item>
      </FormModal>

      <FormModal
        open={editing !== null}
        title={`编辑组织信息：${editing?.name ?? ""}`}
        form={editForm}
        submitting={busy}
        error={error}
        formKey={editing?.id ?? "none"}
        initialValues={{ name: editing?.name ?? "", description: editing?.description ?? "" }}
        onCancel={() => setEditing(null)}
        onFinish={(values) => {
          if (!editing) return;
          const name = values.name?.trim() ?? "";
          if (!name) return;
          post({ intent: "rename", orgId: editing.id, name, description: values.description ?? "" });
        }}
      >
        <AntdForm.Item name="name" label="组织名称" rules={[{ required: true, message: "请输入组织名称" }]}>
          <Input maxLength={40} showCount />
        </AntdForm.Item>
        <AntdForm.Item name="description" label="组织说明">
          <Input.TextArea rows={3} maxLength={200} showCount />
        </AntdForm.Item>
      </FormModal>

      <FormModal
        open={inviteOpen}
        title="把账号拉入组织"
        okText="拉入组织"
        width={520}
        form={inviteForm}
        submitting={busy}
        error={error}
        onCancel={() => setInviteOpen(false)}
        onFinish={(values) => {
          if (!values.accountId || !values.orgId) return;
          post({ intent: "invite", accountId: values.accountId, orgId: values.orgId });
        }}
      >
        <AntdForm.Item name="accountId" label="账号" rules={[{ required: true, message: "请选择账号" }]}>
          <Select
            showSearch={{ optionFilterProp: "label" }}
            placeholder="选择无组织账号"
            options={data.unassigned.map((account) => ({ value: account.id, label: `${account.name}（${account.username}）` }))}
          />
        </AntdForm.Item>
        <AntdForm.Item name="orgId" label="目标组织" rules={[{ required: true, message: "请选择目标组织" }]}>
          <Select placeholder="选择组织" options={activeOrganizations.map((org) => ({ value: org.id, label: org.name }))} />
        </AntdForm.Item>
        <Alert type="info" showIcon title="被拉入的账号会收到站内通知，权限随组织生效。" />
      </FormModal>
    </Flex>
  );
}

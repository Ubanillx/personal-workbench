import type React from "react";
import { useMemo, useState } from "react";
import { useActionData, useLoaderData, useNavigation, useRevalidator, useSearchParams, useSubmit } from "react-router";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Empty,
  Flex,
  Form as AntdForm,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  type DescriptionsProps,
  type MenuProps,
  type TableProps,
} from "antd";
import { PlusOutlined, ReloadOutlined, SaveOutlined, UserAddOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { JoinRequest, JoinRequestKind, JoinRequestStatus, UserRole } from "../../shared/types/domain";
import { confirmAction, confirmDanger, RowActions } from "../components/crud-actions";
import { useCrudFeedback } from "../components/crud-hooks";
import { FormModal } from "../components/crud-modal";
import { TableToolbar } from "../components/crud-toolbar";
import { PageHeader } from "../components/page-header";
import { readPayload } from "../lib/form.server";
import {
  archiveOrganization,
  decideJoinRequest,
  inviteMember,
  listAllAccounts,
  listJoinRequests,
  listMembers,
  listOrganizations,
  removeMember,
  setMemberActive,
  setMemberRole,
  updateOrganization,
  type OrgFailure,
  type OrgSuccess,
} from "../lib/organization.server";
import { requireManagerOrRedirect } from "../lib/ui.server";

/**
 * 组织管理页（docs/harness/ACCOUNTS_AND_ORGS.md §8）。
 *
 * 门禁：`requireManagerOrRedirect`——管理员或组织管理者，普通成员会被送回首页。
 * 组织/成员/申请的全部业务规则都在 `app/lib/organization.server.ts`。
 * 本页 loader / action 直接调用那些函数（不 fetch 自己的 API，也不重复实现规则）。
 *
 * 两个视角：
 * - 管理员（全局角色，不隶属组织）：页头 `Select` 选择当前操作的组织（`?org=` 存在 URL 上，可分享/刷新）；
 * - 组织管理者：固定为自己的组织，页面不接受 URL 指定别的组织。
 *
 * 交互规范：成员的停用/启用/改角色/移出、申请的通过/拒绝、添加成员、编辑组织信息、解散组织。
 * 一律走「弹窗 + 明确的影响说明 + 二次确认」，不在表格里堆砌一组语义不明的裸按钮。
 */

const ROLE_LABEL: Record<UserRole, string> = { admin: "管理员", manager: "组织管理者", member: "普通用户" };
const ROLE_COLOR: Record<UserRole, string> = { admin: "blue", manager: "green", member: "default" };
const KIND_LABEL: Record<JoinRequestKind, string> = { join: "入组申请", leave: "退出申请", invite: "直接加入" };
const STATUS_LABEL: Record<JoinRequestStatus, string> = {
  pending: "待审批",
  approved: "已通过",
  rejected: "已拒绝",
  cancelled: "已作废",
};
const STATUS_COLOR: Record<JoinRequestStatus, string> = { pending: "gold", approved: "green", rejected: "red", cancelled: "default" };
const ROLE_FILTER_OPTIONS = [
  { value: "all", label: "全部角色" },
  { value: "manager", label: "组织管理者" },
  { value: "member", label: "普通用户" },
];
const STATE_FILTER_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "active", label: "启用中" },
  { value: "inactive", label: "已停用" },
];

/** 成员列表的视图行（SQL 的 is_active / must_change_password 是 0/1） */
type MemberRow = {
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
  const user = requireManagerOrRedirect(request);
  const url = new URL(request.url);
  const organizations = listOrganizations(user);

  // 管理员用 ?org= 选组织，默认第一个未解散的组织；组织管理者固定为本组织
  const requested = url.searchParams.get("org");
  const current =
    user.role === "admin"
      ? (organizations.find((org) => org.id === requested) ??
        organizations.find((org) => org.status === "active") ??
        organizations[0] ??
        null)
      : (organizations.find((org) => org.id === user.orgId) ?? null);

  const members = current ? (listMembers(current.id) as unknown as MemberRow[]) : [];
  const requests = current ? listJoinRequests(user, { orgId: current.id }) : [];
  // 「添加成员」的候选：无组织、启用中、且不是管理员（管理员不隶属组织）
  const accounts = listAllAccounts() as unknown as MemberRow[];
  const candidates =
    current && current.status === "active"
      ? accounts.filter((account) => account.orgId === null && account.role !== "admin" && account.isActive === 1)
      : [];

  return {
    me: { id: user.id, name: user.name, username: user.username, role: user.role, orgId: user.orgId },
    organizations,
    current,
    members,
    candidates,
    pending: requests.filter((item) => item.status === "pending"),
    history: requests.filter((item) => item.status !== "pending").slice(0, 20),
  };
}

export async function action({ request }: { request: Request }): Promise<ActionResult> {
  const user = requireManagerOrRedirect(request);
  const payload = await readPayload(request);
  const intent = String(payload.intent ?? "");

  // 目标组织一律从会话推导：组织管理者只能操作自己的组织，不信任表单里传来的 orgId
  const orgId = user.role === "admin" ? String(payload.orgId ?? "") : (user.orgId ?? "");
  const memberId = String(payload.memberId ?? "");
  const text = (key: string): string => (typeof payload[key] === "string" ? String(payload[key]) : "");
  const active = payload.active === true || payload.active === "true";
  const approve = payload.approve === true || payload.approve === "true";

  switch (intent) {
    case "rename":
      return toActionResult(updateOrganization(user, orgId, { name: payload.name, description: text("description") }), "组织信息已保存");
    case "archive":
      return toActionResult(archiveOrganization(user, orgId), "组织已解散：成员已退回「未加入」状态，数据保留");
    case "toggle-member":
      return toActionResult(setMemberActive(user, memberId, active), active ? "成员已启用" : "成员已停用，其会话已失效");
    case "promote":
      return toActionResult(setMemberRole(user, memberId, "manager"), "已设为组织管理者");
    case "demote":
      return toActionResult(setMemberRole(user, memberId, "member"), "已降为普通用户");
    case "remove-member":
      return toActionResult(removeMember(user, memberId), "已移出组织：该账号回到「未加入」状态");
    case "invite":
      return toActionResult(inviteMember(user, orgId, String(payload.accountId ?? "")), "已把该账号拉入本组织");
    case "decide":
      return toActionResult(
        decideJoinRequest(user, String(payload.requestId ?? ""), approve, text("note")),
        approve ? "申请已通过" : "申请已拒绝",
      );
    default:
      return { error: "未知操作" };
  }
}

export default function OrganizationRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submit = useSubmit();
  const [params, setParams] = useSearchParams();
  const { modal } = AntdApp.useApp();
  const [editForm] = AntdForm.useForm<{ name?: string; description?: string }>();
  const [inviteForm] = AntdForm.useForm<{ accountId?: string }>();
  const [editOpen, setEditOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [memberKeyword, setMemberKeyword] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");

  const { error } = useCrudFeedback(actionData, () => {
    setEditOpen(false);
    setInviteOpen(false);
  });
  const busy = navigation.state !== "idle";
  const isAdmin = data.me.role === "admin";
  const current = data.current;
  const archived = current?.status === "archived";

  const post = (payload: Record<string, unknown>): void => {
    submit(payload as Parameters<typeof submit>[0], { method: "post", encType: "application/json" });
  };

  const selectOrg = (orgId: string): void => {
    const next = new URLSearchParams(params);
    next.set("org", orgId);
    setParams(next, { replace: true });
  };

  const members = useMemo(
    () =>
      data.members.filter((member) => {
        if (memberKeyword && !`${member.name}${member.username}${member.email}`.includes(memberKeyword)) return false;
        if (roleFilter !== "all" && member.role !== roleFilter) return false;
        if (stateFilter === "active" && member.isActive !== 1) return false;
        if (stateFilter === "inactive" && member.isActive === 1) return false;
        return true;
      }),
    [data.members, memberKeyword, roleFilter, stateFilter],
  );

  const decide = (row: JoinRequest, accepted: boolean, note = ""): void => {
    post({ intent: "decide", requestId: row.id, approve: accepted, note });
  };

  const reject = (row: JoinRequest): void => {
    let note = "";
    modal.confirm({
      title: `拒绝 ${row.userName ?? "该账号"} 的${KIND_LABEL[row.kind]}？`,
      content: (
        <Input.TextArea
          rows={3}
          maxLength={200}
          placeholder="拒绝原因（可选，会通知申请人）"
          onChange={(event) => (note = event.target.value)}
        />
      ),
      okText: "拒绝",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: () => decide(row, false, note),
    });
  };

  const memberColumns: TableProps<MemberRow>["columns"] = [
    {
      title: "姓名",
      dataIndex: "name",
      key: "name",
      sorter: (a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"),
      render: (_value, member) => (
        <Space size={4}>
          <Typography.Text strong>{member.name}</Typography.Text>
          {member.id === data.me.id ? <Tag color="blue">当前登录账号</Tag> : null}
        </Space>
      ),
    },
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
      width: 130,
      filters: [
        { text: "组织管理者", value: "manager" },
        { text: "普通用户", value: "member" },
      ],
      onFilter: (value, member) => member.role === value,
      render: (_value, member) => (
        <Tag color={ROLE_COLOR[member.role]} variant="filled">
          {ROLE_LABEL[member.role]}
        </Tag>
      ),
    },
    {
      title: "状态",
      dataIndex: "isActive",
      key: "isActive",
      width: 110,
      render: (_value, member) => (
        <Tag color={member.isActive === 1 ? "green" : "default"} variant="filled">
          {member.isActive === 1 ? "启用中" : "已停用"}
        </Tag>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 170,
      align: "right",
      render: (_value, member) => {
        if (member.id === data.me.id) return <Typography.Text type="secondary">当前登录账号</Typography.Text>;
        const items: MenuProps["items"] = [
          {
            key: "toggle",
            label: member.isActive === 1 ? "停用账号" : "启用账号",
            disabled: archived,
            onClick: () =>
              (member.isActive === 1 ? confirmDanger : confirmAction)(modal, {
                title: `${member.isActive === 1 ? "停用" : "启用"} ${member.name}？`,
                content:
                  member.isActive === 1
                    ? "停用后该账号立即失去会话，无法登录，直到重新启用。"
                    : "启用后该账号可以重新登录并访问本组织数据。",
                okText: member.isActive === 1 ? "停用" : "启用",
                onOk: () => post({ intent: "toggle-member", memberId: member.id, active: member.isActive !== 1 }),
              }),
          },
          { type: "divider" },
          {
            key: "remove",
            label: "移出组织",
            danger: true,
            disabled: archived,
            onClick: () =>
              confirmDanger(modal, {
                title: `把 ${member.name} 移出组织？`,
                content: "该账号会退回「未加入」状态，之后可以重新申请或由管理者拉入。",
                okText: "移出组织",
                onOk: () => post({ intent: "remove-member", memberId: member.id }),
              }),
          },
        ];
        return (
          <RowActions
            disabled={busy}
            extra={
              <Button
                size="small"
                color="default"
                variant="text"
                disabled={archived}
                onClick={() =>
                  (member.role === "manager" ? confirmDanger : confirmAction)(modal, {
                    title: member.role === "manager" ? `把 ${member.name} 降为普通用户？` : `把 ${member.name} 设为组织管理者？`,
                    content:
                      member.role === "manager"
                        ? "本组织最后一名组织管理者不能被降级，需要先指定继任者。"
                        : "组织管理者可以管理本组织成员、审批申请并管理本组织全部任务。",
                    okText: member.role === "manager" ? "降为普通用户" : "设为组织管理者",
                    onOk: () => post({ intent: member.role === "manager" ? "demote" : "promote", memberId: member.id }),
                  })
                }
              >
                {member.role === "manager" ? "降为普通用户" : "设为管理者"}
              </Button>
            }
            items={items}
          />
        );
      },
    },
  ];

  const requestColumns: TableProps<JoinRequest>["columns"] = [
    { title: "类型", dataIndex: "kind", key: "kind", width: 110, render: (_value, row) => KIND_LABEL[row.kind] },
    {
      title: "申请人",
      dataIndex: "userName",
      key: "userName",
      render: (_value, row) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text strong>{row.userName ?? "未知账号"}</Typography.Text>
          <Typography.Text type="secondary">{row.username ?? "—"}</Typography.Text>
        </Space>
      ),
    },
    { title: "说明", dataIndex: "message", key: "message", render: (_value, row) => row.message || "—" },
    {
      title: "提交时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 170,
      sorter: (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)),
      render: (_value, row) => dayjs(row.createdAt).format("YYYY-MM-DD HH:mm"),
    },
    {
      title: "操作",
      key: "actions",
      width: 160,
      align: "right",
      render: (_value, row) => (
        <Space size={4}>
          <Button
            size="small"
            color="primary"
            variant="solid"
            disabled={busy}
            onClick={() =>
              confirmAction(modal, {
                title: `通过 ${row.userName ?? "该账号"} 的${KIND_LABEL[row.kind]}？`,
                content:
                  row.kind === "join"
                    ? "通过后该账号加入本组织，并自动作废它在其它组织的待审批申请。"
                    : row.kind === "leave"
                      ? "通过后该账号退回「未加入」状态。"
                      : "通过后该账号直接成为本组织成员。",
                okText: "通过",
                onOk: () => decide(row, true),
              })
            }
          >
            通过
          </Button>
          <Button size="small" color="danger" variant="outlined" disabled={busy} onClick={() => reject(row)}>
            拒绝
          </Button>
        </Space>
      ),
    },
  ];

  const historyColumns: TableProps<JoinRequest>["columns"] = [
    { title: "类型", dataIndex: "kind", key: "kind", width: 110, render: (_value, row) => KIND_LABEL[row.kind] },
    { title: "申请人", dataIndex: "userName", key: "userName", render: (_value, row) => row.userName ?? "未知账号" },
    {
      title: "结果",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (_value, row) => (
        <Tag color={STATUS_COLOR[row.status]} variant="filled">
          {STATUS_LABEL[row.status]}
        </Tag>
      ),
    },
    {
      title: "处理",
      key: "decision",
      render: (_value, row) =>
        row.decidedAt
          ? `${row.decidedByName ?? "系统"} · ${dayjs(row.decidedAt).format("MM-DD HH:mm")}${row.decisionNote ? ` · ${row.decisionNote}` : ""}`
          : "—",
    },
  ];

  const orgItems: DescriptionsProps["items"] = current
    ? [
        { key: "name", label: "组织名称", children: current.name },
        { key: "count", label: "成员人数", children: `${data.members.length} 人` },
        {
          key: "status",
          label: "状态",
          children: (
            <Tag color={archived ? "default" : "green"} variant="filled">
              {archived ? "已解散（数据保留）" : "正常"}
            </Tag>
          ),
        },
        { key: "created", label: "创建时间", children: dayjs(current.createdAt).format("YYYY-MM-DD HH:mm") },
        { key: "description", label: "组织说明", children: current.description || "—", span: 2 },
        { key: "id", label: "组织 ID", children: <Typography.Text code>{current.id}</Typography.Text>, span: 2 },
      ]
    : [];

  return (
    <Flex vertical gap="large" className="page-stack">
      <PageHeader
        title="组织管理"
        description={isAdmin ? "管理组织成员，审批加入与退出申请。" : "管理本组织成员，审批加入与退出申请。"}
        extra={
          <>
            {isAdmin ? (
              <Select
                value={current?.id ?? ""}
                onChange={selectOrg}
                style={{ width: 280 }}
                placeholder="选择要管理的组织"
                options={data.organizations.map((org) => ({
                  value: org.id,
                  label: `${org.name}${org.status === "archived" ? "（已解散）" : ""} · ${org.memberCount ?? 0} 人`,
                }))}
              />
            ) : null}
            <Button icon={<ReloadOutlined />} onClick={() => revalidator.revalidate()} loading={busy}>
              刷新
            </Button>
            {isAdmin ? <Button href="/admin">全局管理</Button> : null}
          </>
        }
      />

      {error ? <Alert type="error" showIcon title={error} /> : null}

      {!current ? (
        <Card variant="outlined" title="组织信息">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={isAdmin ? "还没有任何组织，先到全局管理页创建一个。" : "当前账号不属于任何组织。"}
          >
            {isAdmin ? (
              <Button color="primary" variant="solid" href="/admin" icon={<PlusOutlined />}>
                去创建组织
              </Button>
            ) : null}
          </Empty>
        </Card>
      ) : (
        <>
          <Card
            variant="outlined"
            title="组织信息"
            extra={
              <Space size="small">
                <Tag color={archived ? "default" : "green"} variant="filled">
                  {archived ? "已解散" : "正常"}
                </Tag>
                <Button icon={<SaveOutlined />} disabled={busy || archived} onClick={() => setEditOpen(true)}>
                  编辑组织信息
                </Button>
              </Space>
            }
          >
            <Flex vertical gap="middle">
              <Descriptions size="small" column={2} items={orgItems} />
              {archived ? (
                <Alert
                  type="warning"
                  showIcon
                  title="该组织已解散（归档）"
                  description="成员已全部退回「未加入」状态，数据保留但不可访问；只有管理员能在全局管理页恢复组织。"
                />
              ) : null}
            </Flex>
          </Card>

          <Card
            variant="outlined"
            title={`成员列表（${data.members.length} 人）`}
            extra={
              <Button
                color="primary"
                variant="solid"
                icon={<UserAddOutlined />}
                disabled={archived || busy || data.candidates.length === 0}
                onClick={() => setInviteOpen(true)}
              >
                添加成员
              </Button>
            }
          >
            <Flex vertical gap="middle">
              <TableToolbar
                extra={
                  <Typography.Text type="secondary">
                    显示 {members.length} / {data.members.length} 个
                  </Typography.Text>
                }
              >
                <Input.Search
                  allowClear
                  placeholder="搜索姓名 / 用户名 / 邮箱"
                  style={{ width: 260 }}
                  value={memberKeyword}
                  onChange={(event) => setMemberKeyword(event.target.value)}
                  onSearch={(value) => setMemberKeyword(value.trim())}
                />
                <Select value={roleFilter} options={ROLE_FILTER_OPTIONS} style={{ width: 140 }} onChange={setRoleFilter} />
                <Select value={stateFilter} options={STATE_FILTER_OPTIONS} style={{ width: 140 }} onChange={setStateFilter} />
                {memberKeyword || roleFilter !== "all" || stateFilter !== "all" ? (
                  <Button
                    color="default"
                    variant="text"
                    onClick={() => {
                      setMemberKeyword("");
                      setRoleFilter("all");
                      setStateFilter("all");
                    }}
                  >
                    重置
                  </Button>
                ) : null}
              </TableToolbar>
              <Table<MemberRow>
                rowKey="id"
                size="middle"
                columns={memberColumns}
                dataSource={members}
                loading={busy}
                scroll={{ x: 880 }}
                pagination={{
                  pageSize: 10,
                  showSizeChanger: true,
                  showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 条`,
                }}
                locale={{
                  emptyText: (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={data.members.length ? "没有符合条件的成员" : "本组织还没有成员"}
                    >
                      {data.members.length === 0 && !archived && data.candidates.length ? (
                        <Button onClick={() => setInviteOpen(true)} icon={<UserAddOutlined />}>
                          添加成员
                        </Button>
                      ) : null}
                    </Empty>
                  ),
                }}
              />
            </Flex>
          </Card>

          <Card variant="outlined" title="待审批申请" extra={<Typography.Text type="secondary">{data.pending.length} 条</Typography.Text>}>
            {data.pending.length ? (
              <Table<JoinRequest>
                rowKey="id"
                size="middle"
                columns={requestColumns}
                dataSource={data.pending}
                pagination={false}
                scroll={{ x: 760 }}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待审批的入组或退组申请" />
            )}
          </Card>

          <Card variant="outlined" title="最近处理记录">
            {data.history.length ? (
              <Table<JoinRequest>
                rowKey="id"
                size="middle"
                columns={historyColumns}
                dataSource={data.history}
                pagination={false}
                scroll={{ x: 720 }}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有处理过入组或退组申请" />
            )}
          </Card>

          {!archived ? (
            <Card variant="outlined" title="危险操作">
              <Flex vertical gap="small">
                <Typography.Text type="secondary">解散后，成员将退出组织，数据保留但暂时无法访问。管理员可恢复组织。</Typography.Text>
                <Button
                  color="danger"
                  variant="outlined"
                  style={{ width: "fit-content" }}
                  disabled={busy}
                  onClick={() =>
                    confirmDanger(modal, {
                      title: `确认解散「${current.name}」？`,
                      content: "成员会被退回未加入状态，数据保留；之后只有管理员能恢复组织。",
                      okText: "解散组织",
                      onOk: () => post({ intent: "archive", orgId: current.id }),
                    })
                  }
                >
                  解散组织
                </Button>
              </Flex>
            </Card>
          ) : null}
        </>
      )}

      {current ? (
        <FormModal
          open={editOpen}
          title="编辑组织信息"
          okText="保存"
          form={editForm}
          submitting={busy}
          error={error}
          formKey={current.id}
          initialValues={{ name: current.name, description: current.description }}
          onCancel={() => setEditOpen(false)}
          onFinish={(values) => {
            const name = values.name?.trim() ?? "";
            if (!name) return;
            post({ intent: "rename", orgId: current.id, name, description: values.description ?? "" });
          }}
        >
          <AntdForm.Item name="name" label="组织名称" rules={[{ required: true, message: "请输入组织名称" }]}>
            <Input maxLength={40} placeholder="2-40 个字符" showCount />
          </AntdForm.Item>
          <AntdForm.Item name="description" label="组织说明">
            <Input.TextArea rows={3} maxLength={200} showCount placeholder="可选：这个组织是做什么的" />
          </AntdForm.Item>
        </FormModal>
      ) : null}

      {current ? (
        <FormModal
          open={inviteOpen}
          title="添加成员"
          okText="拉入本组织"
          width={520}
          form={inviteForm}
          submitting={busy}
          error={error}
          onCancel={() => setInviteOpen(false)}
          onFinish={(values) => {
            if (!values.accountId) return;
            post({ intent: "invite", orgId: current.id, accountId: values.accountId });
          }}
        >
          <Alert
            type="info"
            showIcon
            title="从「无组织账号」里选择一个直接加入本组织"
            description="可直接添加尚未加入组织的账号，成员将收到站内通知。"
          />
          <AntdForm.Item
            name="accountId"
            label="无组织账号"
            rules={[{ required: true, message: "请选择要拉入的账号" }]}
            style={{ marginTop: 16 }}
          >
            <Select
              showSearch={{ optionFilterProp: "label" }}
              placeholder="搜索姓名或用户名"
              options={data.candidates.map((account) => ({ value: account.id, label: `${account.name}（${account.username}）` }))}
            />
          </AntdForm.Item>
        </FormModal>
      ) : null}
    </Flex>
  );
}

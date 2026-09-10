import type React from "react";
import { useEffect } from "react";
import { useActionData, useLoaderData, useNavigation, useRevalidator, useSearchParams, useSubmit } from "react-router";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Divider,
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
import { PlusOutlined, ReloadOutlined, SaveOutlined, UserAddOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { JoinRequest, JoinRequestKind, JoinRequestStatus, UserRole } from "../../shared/types/domain";
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
 * 组织/成员/申请的全部业务规则都在 `app/lib/organization.server.ts`，
 * 本页 loader / action 直接调用那些函数（不 fetch 自己的 API，也不重复实现规则）。
 *
 * 两个视角：
 * - 管理员（全局角色，不隶属组织）：顶部 `Select` 选择当前操作的组织（`?org=` 存在 URL 上，可分享/刷新）；
 * - 组织管理者：固定为自己的组织，页面不接受 URL 指定别的组织。
 */

const ROLE_LABEL: Record<UserRole, string> = { admin: "管理员", manager: "组织管理者", member: "普通用户" };
const KIND_LABEL: Record<JoinRequestKind, string> = { join: "入组申请", leave: "退出申请", invite: "直接加入" };
const STATUS_LABEL: Record<JoinRequestStatus, string> = {
  pending: "待审批",
  approved: "已通过",
  rejected: "已拒绝",
  cancelled: "已作废",
};
const STATUS_COLOR: Record<JoinRequestStatus, string> = { pending: "gold", approved: "green", rejected: "red", cancelled: "default" };

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
  // 「拉人入组」的候选：无组织、启用中、且不是管理员（管理员不隶属组织）
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
  const [inviteForm] = AntdForm.useForm<{ accountId?: string }>();
  const { message, modal } = AntdApp.useApp();

  const busy = navigation.state !== "idle";
  const isAdmin = data.me.role === "admin";
  const current = data.current;
  const archived = current?.status === "archived";
  const error = actionData && "error" in actionData ? actionData.error : "";

  // 依赖整个 actionData 对象：连续做两次同样的操作（例如连拉两个人）也要各弹一次提示
  useEffect(() => {
    if (actionData && "ok" in actionData) void message.success(actionData.notice);
  }, [actionData, message]);

  /** 所有写操作：action + useSubmit（RR8 的 action 完成后会自动重跑 loader，页面因此拿到新数据） */
  const post = (payload: Record<string, unknown>): void => {
    submit(payload as Parameters<typeof submit>[0], { method: "post", encType: "application/json" });
  };

  const selectOrg = (orgId: string): void => {
    const next = new URLSearchParams(params);
    next.set("org", orgId);
    setParams(next, { replace: true });
  };

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
      render: (_value, member) => <Typography.Text strong>{member.name}</Typography.Text>,
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
    {
      title: "操作",
      key: "actions",
      render: (_value, member) => {
        if (member.id === data.me.id) return <Typography.Text type="secondary">当前登录账号</Typography.Text>;
        return (
          <Space size="small" wrap>
            <Popconfirm
              title={`${member.isActive === 1 ? "停用" : "启用"} ${member.name}？`}
              description={member.isActive === 1 ? "停用后该账号立即失去会话，无法登录。" : "启用后该账号可以重新登录。"}
              okText="确定"
              cancelText="取消"
              onConfirm={() => post({ intent: "toggle-member", memberId: member.id, active: member.isActive !== 1 })}
            >
              <Button size="small" disabled={busy || archived}>
                {member.isActive === 1 ? "停用" : "启用"}
              </Button>
            </Popconfirm>
            <Popconfirm
              title={member.role === "manager" ? `把 ${member.name} 降为普通用户？` : `把 ${member.name} 设为组织管理者？`}
              description={
                member.role === "manager"
                  ? "本组织最后一名组织管理者不能被降级，需要先指定继任者。"
                  : "组织管理者可以管理本组织成员、审批申请并管理本组织全部任务。"
              }
              okText="确定"
              cancelText="取消"
              onConfirm={() => post({ intent: member.role === "manager" ? "demote" : "promote", memberId: member.id })}
            >
              <Button size="small" disabled={busy || archived}>
                {member.role === "manager" ? "降为普通用户" : "设为组织管理者"}
              </Button>
            </Popconfirm>
            <Popconfirm
              title={`把 ${member.name} 移出组织？`}
              description="该账号会退回「未加入」状态，之后可以重新申请或由管理者拉入。"
              okText="移出组织"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => post({ intent: "remove-member", memberId: member.id })}
            >
              <Button size="small" color="danger" variant="outlined" disabled={busy || archived}>
                移出组织
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const requestColumns: TableProps<JoinRequest>["columns"] = [
    { title: "类型", dataIndex: "kind", key: "kind", render: (_value, row) => KIND_LABEL[row.kind] },
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
      render: (_value, row) => dayjs(row.createdAt).format("YYYY-MM-DD HH:mm"),
    },
    {
      title: "操作",
      key: "actions",
      render: (_value, row) => (
        <Space size="small" wrap>
          <Popconfirm
            title={`通过 ${row.userName ?? "该账号"} 的${KIND_LABEL[row.kind]}？`}
            description={
              row.kind === "join"
                ? "通过后该账号加入本组织，并自动作废它在其它组织的待审批申请。"
                : row.kind === "leave"
                  ? "通过后该账号退回「未加入」状态。"
                  : undefined
            }
            okText="通过"
            cancelText="取消"
            onConfirm={() => decide(row, true)}
          >
            <Button size="small" color="primary" variant="solid" disabled={busy}>
              通过
            </Button>
          </Popconfirm>
          <Button size="small" color="danger" variant="outlined" disabled={busy} onClick={() => reject(row)}>
            拒绝
          </Button>
        </Space>
      ),
    },
  ];

  const historyColumns: TableProps<JoinRequest>["columns"] = [
    { title: "类型", dataIndex: "kind", key: "kind", render: (_value, row) => KIND_LABEL[row.kind] },
    { title: "申请人", dataIndex: "userName", key: "userName", render: (_value, row) => row.userName ?? "未知账号" },
    {
      title: "结果",
      dataIndex: "status",
      key: "status",
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

  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <div>
        <Typography.Text type="secondary">ORG</Typography.Text>
        <Typography.Title level={3} className="page-title">
          组织管理
        </Typography.Title>
        <Typography.Text type="secondary">
          {isAdmin
            ? "管理员可以管理全部组织：切换组织、审批入组/退组申请、维护成员，也可以解散（归档）组织。"
            : "管理本组织的成员与申请：审批入组/退组、停用账号、调整角色、拉无组织账号入组。"}
        </Typography.Text>
      </div>

      {isAdmin && (
        <Flex align="center" gap="small" wrap>
          <Typography.Text type="secondary">当前组织</Typography.Text>
          <Select
            value={current?.id ?? ""}
            onChange={selectOrg}
            style={{ width: 300 }}
            placeholder="选择要管理的组织"
            options={data.organizations.map((org) => ({
              value: org.id,
              label: `${org.name}${org.status === "archived" ? "（已解散）" : ""} · ${org.memberCount ?? 0} 人`,
            }))}
          />
          <Button href="/admin">去全局管理页</Button>
        </Flex>
      )}

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

      {!current ? (
        <Card variant="outlined" title="组织信息">
          <Space orientation="vertical" size="middle" className="list-block">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={isAdmin ? "还没有任何组织，先到全局管理页创建一个。" : "当前账号不属于任何组织。"}
            />
            {isAdmin && (
              <Button color="primary" variant="solid" href="/admin" icon={<PlusOutlined />}>
                去创建组织
              </Button>
            )}
          </Space>
        </Card>
      ) : (
        <>
          <Card
            variant="outlined"
            title="组织信息"
            extra={
              <Tag color={archived ? "default" : "green"} variant="filled">
                {archived ? "已解散" : "正常"}
              </Tag>
            }
          >
            <Space orientation="vertical" size="middle" className="page-stack">
              <Descriptions
                column={2}
                items={[
                  { key: "name", label: "组织名称", children: current.name },
                  { key: "count", label: "成员人数", children: `${data.members.length} 人` },
                  { key: "status", label: "状态", children: archived ? "已解散（数据保留）" : "正常" },
                  { key: "created", label: "创建时间", children: dayjs(current.createdAt).format("YYYY-MM-DD HH:mm") },
                  { key: "description", label: "组织说明", children: current.description || "—", span: 2 },
                  { key: "id", label: "组织 ID", children: <Typography.Text code>{current.id}</Typography.Text>, span: 2 },
                ]}
              />

              {archived && (
                <Alert
                  type="warning"
                  showIcon
                  title="该组织已解散（归档）"
                  description="成员已全部退回「未加入」状态，数据保留但不可访问；只有管理员能在全局管理页恢复组织。"
                />
              )}

              <Divider />

              <AntdForm
                key={current.id}
                layout="vertical"
                disabled={archived}
                initialValues={{ name: current.name, description: current.description }}
                onFinish={(values: { name?: string; description?: string }) => {
                  const name = values.name?.trim() ?? "";
                  if (!name || busy || archived) return;
                  post({ intent: "rename", orgId: current.id, name, description: values.description ?? "" });
                }}
              >
                <AntdForm.Item name="name" label="组织名称" rules={[{ required: true, message: "请输入组织名称" }]}>
                  <Input maxLength={40} placeholder="2-40 个字符" />
                </AntdForm.Item>
                <AntdForm.Item name="description" label="组织说明">
                  <Input.TextArea rows={2} maxLength={200} placeholder="可选：这个组织是做什么的" />
                </AntdForm.Item>
                <Button color="primary" variant="solid" htmlType="submit" icon={<SaveOutlined />} disabled={busy || archived}>
                  保存组织信息
                </Button>
              </AntdForm>
            </Space>
          </Card>

          <Card variant="outlined" title={`成员列表（${data.members.length} 人）`}>
            {data.members.length ? (
              <Table<MemberRow> rowKey="id" columns={memberColumns} dataSource={data.members} pagination={false} />
            ) : (
              <Typography.Text type="secondary">本组织还没有成员，可以用下面的「拉人入组」直接加入无组织账号。</Typography.Text>
            )}
          </Card>

          <Card variant="outlined" title="待审批申请" extra={<Typography.Text type="secondary">{data.pending.length} 条</Typography.Text>}>
            {data.pending.length ? (
              <Table<JoinRequest> rowKey="id" columns={requestColumns} dataSource={data.pending} pagination={false} />
            ) : (
              <Typography.Text type="secondary">暂无待审批的入组或退组申请。</Typography.Text>
            )}
          </Card>

          <Card variant="outlined" title="拉人入组">
            <Space orientation="vertical" size="small" className="list-block">
              <Typography.Text type="secondary">
                直接从「无组织账号」里选一个拉进本组织（D-31：不需要对方申请，被拉的人会收到站内通知）。账号密码由本人在登录页自助使用，
                忘记密码只能在本机用 CLI 重置。
              </Typography.Text>
              {data.candidates.length ? (
                <AntdForm
                  key={current.id}
                  form={inviteForm}
                  layout="inline"
                  disabled={archived}
                  onFinish={(values: { accountId?: string }) => {
                    if (!values.accountId || busy || archived) return;
                    post({ intent: "invite", orgId: current.id, accountId: values.accountId });
                    // 拉进来的人已经不在候选列表里了，清空选择避免留下一个失效的 id
                    inviteForm.resetFields();
                  }}
                >
                  <AntdForm.Item name="accountId">
                    <Select
                      showSearch={{ optionFilterProp: "label" }}
                      placeholder="选择无组织账号"
                      style={{ width: 320 }}
                      options={data.candidates.map((account) => ({ value: account.id, label: `${account.name}（${account.username}）` }))}
                    />
                  </AntdForm.Item>
                  <AntdForm.Item>
                    <Button color="primary" variant="solid" htmlType="submit" icon={<UserAddOutlined />} disabled={busy || archived}>
                      拉入本组织
                    </Button>
                  </AntdForm.Item>
                </AntdForm>
              ) : (
                <Typography.Text type="secondary">
                  {archived
                    ? "组织已解散，不能加入新成员。"
                    : "当前没有可拉入的无组织账号：等有人在「加入组织」页提交申请，或让对方先注册。"}
                </Typography.Text>
              )}
            </Space>
          </Card>

          <Card variant="outlined" title="最近处理记录">
            {data.history.length ? (
              <Table<JoinRequest> rowKey="id" columns={historyColumns} dataSource={data.history} pagination={false} />
            ) : (
              <Typography.Text type="secondary">还没有处理过入组或退组申请。</Typography.Text>
            )}
          </Card>

          {!archived && (
            <Card variant="outlined" title="解散组织">
              <Space orientation="vertical" size="small" className="list-block">
                <Typography.Text type="secondary">
                  解散 = 归档（D-33）：成员会被退回「未加入」状态，本组织的数据保留但不可访问；恢复组织只有管理员能在全局管理页操作。
                </Typography.Text>
                <Popconfirm
                  title={`确认解散「${current.name}」？`}
                  description="成员会被退回未加入状态，数据保留；之后只有管理员能恢复组织。"
                  okText="解散组织"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => post({ intent: "archive", orgId: current.id })}
                >
                  <Button color="danger" variant="outlined" disabled={busy}>
                    解散组织
                  </Button>
                </Popconfirm>
              </Space>
            </Card>
          )}
        </>
      )}
    </Space>
  );
}

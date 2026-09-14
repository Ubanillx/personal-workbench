import type React from "react";
import { useEffect, useMemo, useState } from "react";
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
  type TableProps,
} from "antd";
import {
  CheckCircleOutlined,
  CheckOutlined,
  CloseOutlined,
  SaveOutlined,
  StopOutlined,
  UserAddOutlined,
  UserDeleteOutlined,
  UserSwitchOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import type { JoinRequest, Organization } from "../../../shared/types/domain";
import { confirmAction, confirmDanger, RowActions, type RowAction } from "../crud-actions";
import { useListParams, useServerTable } from "../crud-hooks";
import { FormDrawer } from "../crud-drawer";
import { dataTable } from "../table-layout";
import { TableToolbar } from "../crud-toolbar";
import type { Paged } from "../../lib/paging";
import {
  KIND_LABEL,
  ORG_STATUS_COLOR,
  ORG_STATUS_LABEL,
  REQUEST_STATUS_COLOR,
  REQUEST_STATUS_LABEL,
  ROLE_COLOR,
  ROLE_FILTER_OPTIONS,
  ROLE_LABEL,
  STATE_FILTER_OPTIONS,
} from "./constants";
import type { Me, MemberRow, PostPayload } from "./types";

/**
 * Tab1「组织与成员」——原 `/organization` 页的全部内容。
 *
 * 保留两个视角（与管理页一致）：
 * - 管理员：页内 `Select` 切换要管理的组织（`?org=` 挂在 URL 上，刷新/分享不丢）；
 * - 组织管理者：固定为本组织，不接受切换。
 *
 * 解散组织在这个 Tab 里**只对组织管理者提供**；管理员的组织解散统一在「组织总览」Tab，
 * 保证每种角色对同一动作只有一个入口。
 */
type Props = {
  me: Me;
  isAdmin: boolean;
  organizations: Organization[];
  current: Organization | null;
  /** 成员列表：服务端筛选 + 排序 + 分页的结果（页面只渲染当页） */
  members: Paged<MemberRow>;
  candidates: MemberRow[];
  pending: JoinRequest[];
  history: JoinRequest[];
  post: PostPayload;
  busy: boolean;
  error: string;
  /** 写操作成功时由外壳递增，用来收起本 Tab 打开的弹窗 */
  successTick: number;
  onSelectOrg: (orgId: string) => void;
};

export function OrgMembersTab({
  me,
  isAdmin,
  organizations,
  current,
  members,
  candidates,
  pending,
  history,
  post,
  busy,
  error,
  successTick,
  onSelectOrg,
}: Props): React.ReactElement {
  const { modal } = AntdApp.useApp();
  const [editForm] = AntdForm.useForm<{ name?: string; description?: string }>();
  const [inviteForm] = AntdForm.useForm<{ accountId?: string }>();
  const [editOpen, setEditOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  /**
   * 筛选条件放在 URL 上（与其它列表页同一套）：关键词 / 角色 / 状态都在**服务端**过滤，
   * 这样分页才对得上（原来它们在浏览器里过滤当前页）。
   */
  const list = useListParams();
  const keyword = list.get("q");
  const roleFilter = list.get("role", "all");
  const stateFilter = list.get("state", "all");
  const [draftKeyword, setDraftKeyword] = useState(keyword);
  useEffect(() => setDraftKeyword(keyword), [keyword]);
  const filtered = Boolean(keyword || roleFilter !== "all" || stateFilter !== "all");
  /** 服务端分页：翻页、改条数与表头排序都只写回 URL，由 loader 决定这一页是谁 */
  const rows = members.rows;
  const paging = useServerTable<MemberRow>(members);

  const archived = current?.status === "archived";

  useEffect(() => {
    if (successTick > 0) {
      setEditOpen(false);
      setInviteOpen(false);
    }
  }, [successTick]);

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
      // 表头排序由服务端做（客户端比较器只能排当前这一页）
      sorter: true,
      sortOrder: paging.sortOrderOf("name"),
      render: (_value, member) => (
        <Space size={4}>
          <Typography.Text strong>{member.name}</Typography.Text>
          {member.id === me.id ? <Tag color="blue">当前登录账号</Tag> : null}
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
      // 列上的筛选下拉已删除：角色由工具栏的筛选器负责（同一字段只留一套说法；
      // 列筛选只作用于当前页，服务端分页下必然给出错误结果）
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
      // 图标动作按钮平铺（设为管理者 / 停用 / 移出组织），每个约 36px
      width: 160,
      align: "right",
      ellipsis: false,
      render: (_value, member) => {
        if (member.id === me.id) return <Typography.Text type="secondary">当前登录账号</Typography.Text>;
        const actions: RowAction[] = [
          {
            key: "role",
            label: member.role === "manager" ? "降为普通用户" : "设为管理者",
            icon: <UserSwitchOutlined />,
            disabled: archived,
            onClick: () =>
              (member.role === "manager" ? confirmDanger : confirmAction)(modal, {
                title: member.role === "manager" ? `把 ${member.name} 降为普通用户？` : `把 ${member.name} 设为组织管理者？`,
                content:
                  member.role === "manager"
                    ? "本组织最后一名组织管理者不能被降级，需要先指定继任者。"
                    : "组织管理者可以管理本组织成员、审批申请并管理本组织全部任务。",
                okText: member.role === "manager" ? "降为普通用户" : "设为组织管理者",
                onOk: () => post({ intent: member.role === "manager" ? "demote" : "promote", memberId: member.id }),
              }),
          },
          {
            key: "toggle",
            label: member.isActive === 1 ? "停用账号" : "启用账号",
            icon: member.isActive === 1 ? <StopOutlined /> : <CheckCircleOutlined />,
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
          {
            key: "remove",
            label: "移出组织",
            icon: <UserDeleteOutlined />,
            tone: "danger",
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
        return <RowActions actions={actions} disabled={busy} />;
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
      width: 200,
      align: "right",
      render: (_value, row) => (
        <RowActions
          disabled={busy}
          actions={[
            {
              key: "approve",
              label: "通过",
              icon: <CheckOutlined />,
              tone: "primary",
              onClick: () =>
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
                }),
            },
            {
              key: "reject",
              label: "拒绝",
              icon: <CloseOutlined />,
              tone: "danger",
              onClick: () => reject(row),
            },
          ]}
        />
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
        <Tag color={REQUEST_STATUS_COLOR[row.status]} variant="filled">
          {REQUEST_STATUS_LABEL[row.status]}
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
        { key: "count", label: "成员人数", children: `${members.total} 人` },
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

  // 三个表的排版方案（自动省略 + 定宽排版）：本页三张表都不带勾选列
  const memberTable = useMemo(() => dataTable<MemberRow>({ columns: memberColumns }), [memberColumns]);
  const requestTable = useMemo(() => dataTable<JoinRequest>({ columns: requestColumns }), [requestColumns]);
  const historyTable = useMemo(() => dataTable<JoinRequest>({ columns: historyColumns }), [historyColumns]);

  return (
    <Flex vertical gap="large">
      {isAdmin ? (
        <Flex align="center" gap="small" wrap>
          <Typography.Text type="secondary">当前管理组织</Typography.Text>
          <Select
            value={current?.id ?? ""}
            onChange={onSelectOrg}
            style={{ width: 320 }}
            placeholder="选择要管理的组织"
            options={organizations.map((org) => ({
              value: org.id,
              label: `${org.name}${org.status === "archived" ? "（已解散）" : ""} · ${org.memberCount ?? 0} 人`,
            }))}
          />
          {current ? (
            <Tag color={ORG_STATUS_COLOR[current.status]} variant="filled">
              {ORG_STATUS_LABEL[current.status]}
            </Tag>
          ) : null}
        </Flex>
      ) : null}

      {!current ? (
        <Card variant="outlined" title="组织信息">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={isAdmin ? "还没有组织，请先在「组织总览」新建。" : "当前账号不属于任何组织。"}
          />
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
                  title="该组织已解散"
                  description="成员已退回「未加入」，数据保留；管理员可在「组织总览」恢复。"
                />
              ) : null}
            </Flex>
          </Card>

          <Card
            variant="outlined"
            title={`成员列表（${members.total} 人）`}
            extra={
              <Space size="small">
                <Button href="/join">查看我的申请</Button>
                <Button
                  color="primary"
                  variant="solid"
                  icon={<UserAddOutlined />}
                  disabled={archived || busy || candidates.length === 0}
                  onClick={() => setInviteOpen(true)}
                >
                  添加成员
                </Button>
              </Space>
            }
          >
            <Flex vertical gap="middle">
              <TableToolbar
                extra={
                  <Typography.Text type="secondary">
                    共 {members.total} 个{filtered ? "（已筛选）" : ""}
                  </Typography.Text>
                }
              >
                <Input.Search
                  allowClear
                  placeholder="搜索姓名 / 用户名 / 邮箱"
                  style={{ width: 260 }}
                  value={draftKeyword}
                  loading={busy}
                  onChange={(event) => setDraftKeyword(event.target.value)}
                  onSearch={(value) => list.patch({ q: value.trim() })}
                />
                <Select
                  value={roleFilter}
                  options={ROLE_FILTER_OPTIONS}
                  style={{ width: 140 }}
                  onChange={(value: string) => list.patch({ role: value === "all" ? null : value })}
                />
                <Select
                  value={stateFilter}
                  options={STATE_FILTER_OPTIONS}
                  style={{ width: 140 }}
                  onChange={(value: string) => list.patch({ state: value === "all" ? null : value })}
                />
                {filtered ? (
                  <Button color="default" variant="text" onClick={() => list.patch({ q: null, role: null, state: null })}>
                    重置
                  </Button>
                ) : null}
              </TableToolbar>
              <Table<MemberRow>
                {...memberTable}
                rowKey="id"
                size="middle"
                dataSource={rows}
                loading={busy}
                pagination={paging.pagination}
                onChange={paging.onTableChange}
                locale={{
                  emptyText: (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filtered ? "没有符合条件的成员" : "本组织还没有成员"}>
                      {!filtered && members.total === 0 && !archived && candidates.length ? (
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

          <Card variant="outlined" title="待审批申请" extra={<Typography.Text type="secondary">{pending.length} 条</Typography.Text>}>
            {pending.length ? (
              <Table<JoinRequest> {...requestTable} rowKey="id" size="middle" dataSource={pending} pagination={false} />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待审批的入组或退组申请" />
            )}
          </Card>

          <Card variant="outlined" title="最近处理记录">
            {history.length ? (
              <Table<JoinRequest> {...historyTable} rowKey="id" size="middle" dataSource={history} pagination={false} />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有处理过入组或退组申请" />
            )}
          </Card>

          {!archived && !isAdmin ? (
            <Card variant="outlined" title="危险操作">
              <Flex vertical gap="small">
                <Typography.Text type="secondary">解散后成员退出组织，数据保留；管理员可恢复。</Typography.Text>
                <Button
                  color="danger"
                  variant="outlined"
                  style={{ width: "fit-content" }}
                  disabled={busy}
                  onClick={() =>
                    confirmDanger(modal, {
                      title: `确认解散「${current.name}」？`,
                      content: "成员将退回「未加入」，数据保留；仅管理员可恢复。",
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
        <FormDrawer
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
            <Input.TextArea rows={3} maxLength={200} showCount placeholder="可选，简述职责" />
          </AntdForm.Item>
        </FormDrawer>
      ) : null}

      {current ? (
        <FormDrawer
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
          <Alert type="info" showIcon title="可直接添加未加入组织的账号" description="添加后成员会收到通知。" />
          <AntdForm.Item
            name="accountId"
            label="无组织账号"
            rules={[{ required: true, message: "请选择要拉入的账号" }]}
            style={{ marginTop: 16 }}
          >
            <Select
              showSearch={{ optionFilterProp: "label" }}
              placeholder="搜索姓名或用户名"
              options={candidates.map((account) => ({ value: account.id, label: `${account.name}（${account.username}）` }))}
            />
          </AntdForm.Item>
        </FormDrawer>
      ) : null}
    </Flex>
  );
}

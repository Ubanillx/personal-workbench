import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Empty, Flex, Input, Modal, Radio, Select, Space, Table, Tag, Typography, type TableProps } from "antd";
import { KeyOutlined, UserAddOutlined } from "@ant-design/icons";
import { useFetcher } from "react-router";
import type { Organization } from "../../../shared/types/domain";
import { TableToolbar } from "../crud-toolbar";
import { useListParams, useServerTable } from "../crud-hooks";
import { dataTable } from "../table-layout";
import type { Paged } from "../../lib/paging";
import { RowActions, type RowAction } from "../crud-actions";
import { ACCOUNT_ROLE_FILTER_OPTIONS, FILTER_ALL, FILTER_NONE, ROLE_COLOR, ROLE_LABEL, STATE_FILTER_OPTIONS } from "./constants";
import type { Me, MemberRow } from "./types";

/**
 * Tab3「账号总览」（仅管理员）——原 `/admin` 页的账号维度视图。
 *
 * 这里只读：可搜索、可按组织与角色筛选。「拉入组织」不再在本 Tab 提供独立表单，
 * 未加入账号给一个「到组织与成员里添加」的引导，避免同一动作两个入口。
 */
type Props = {
  me: Me;
  /** 账号列表：服务端筛选 + 排序 + 分页的结果（页面只渲染当页） */
  accounts: Paged<MemberRow>;
  accountTotal: number;
  unassignedCount: number;
  scope: string;
  organizations: Organization[];
  onScopeChange: (scope: string) => void;
  busy: boolean;
  /** 跳到「组织与成员」Tab */
  onOpenMembers: () => void;
};

type ResetResult = { username: string; password: string | null };

export function AccountsTab({
  me,
  accounts,
  accountTotal,
  unassignedCount,
  scope,
  organizations,
  onScopeChange,
  busy,
  onOpenMembers,
}: Props): React.ReactElement {
  /**
   * 筛选条件放在 URL 上（与其它列表页同一套）：关键词 / 角色 / 状态都在**服务端**过滤，
   * 这样分页才对得上（原来它们在浏览器里过滤当前页）。`?scope=` 由外壳的 `onScopeChange` 写。
   */
  const list = useListParams();
  const keyword = list.get("q");
  const roleFilter = list.get("role", "all");
  const stateFilter = list.get("state", "all");
  const [draftKeyword, setDraftKeyword] = useState(keyword);
  useEffect(() => setDraftKeyword(keyword), [keyword]);
  const filtered = Boolean(keyword || roleFilter !== "all" || stateFilter !== "all" || scope !== FILTER_ALL);
  /** 服务端分页：翻页、改条数与表头排序都只写回 URL，由 loader 决定这一页是谁 */
  const rows = accounts.rows;
  const paging = useServerTable<MemberRow>(accounts);

  // 重置他人密码：仅管理员可到达本 Tab；服务端还会再校验一次角色
  const resetFetcher = useFetcher<{ ok?: boolean; notice?: string; reset?: ResetResult; error?: string }>();
  const [resetTarget, setResetTarget] = useState<MemberRow | null>(null);
  const [resetMode, setResetMode] = useState<"generate" | "manual">("generate");
  const [manualPassword, setManualPassword] = useState("");
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [resetResult, setResetResult] = useState<ResetResult | null>(null);
  const [resetError, setResetError] = useState("");
  // 提交时的 fetcher.data 基线：避免把上一次的结果当成本次的成功
  const resetBaseline = useRef<unknown>(undefined);

  const openReset = (account: MemberRow): void => {
    setResetTarget(account);
    setResetMode("generate");
    setManualPassword("");
    setResetSubmitting(false);
    setResetResult(null);
    setResetError("");
  };
  const closeReset = (): void => setResetTarget(null);
  const submitReset = (): void => {
    if (!resetTarget) return;
    resetBaseline.current = resetFetcher.data;
    setResetSubmitting(true);
    setResetError("");
    resetFetcher.submit(
      {
        intent: "reset-password",
        memberId: resetTarget.id,
        generate: resetMode === "generate",
        ...(resetMode === "manual" ? { password: manualPassword } : {}),
      },
      { method: "post", encType: "application/json" },
    );
  };
  useEffect(() => {
    if (!resetSubmitting || resetFetcher.state !== "idle") return;
    if (resetFetcher.data === resetBaseline.current) return;
    setResetSubmitting(false);
    const data = resetFetcher.data;
    if (data?.error) {
      setResetError(data.error);
      return;
    }
    if (data?.ok) setResetResult(data.reset ?? { username: resetTarget?.username ?? "", password: null });
  }, [resetFetcher.state, resetFetcher.data, resetSubmitting, resetTarget]);

  const scopeOptions = [
    { value: FILTER_ALL, label: `全部账号（${accountTotal}）` },
    { value: FILTER_NONE, label: `未加入任何组织（${unassignedCount}）` },
    ...organizations.map((org) => ({ value: org.id, label: `${org.name}${org.status === "archived" ? "（已解散）" : ""}` })),
  ];

  const columns: TableProps<MemberRow>["columns"] = [
    {
      title: "姓名",
      dataIndex: "name",
      key: "name",
      // 表头排序由服务端做（客户端比较器只能排当前这一页）
      sorter: true,
      sortOrder: paging.sortOrderOf("name"),
      render: (_value, account) => (
        <Space size={4}>
          <Typography.Text strong>{account.name}</Typography.Text>
          {account.id === me.id ? <Tag color="blue">当前登录账号</Tag> : null}
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
      // 两个图标动作按钮（去加入组织 / 重置密码）的宽度
      width: 160,
      align: "right",
      ellipsis: false,
      render: (_value, account) => {
        if (account.id === me.id) return <Typography.Text type="secondary">—</Typography.Text>;
        const actions: RowAction[] = [];
        if (account.orgId === null && account.role !== "admin") {
          actions.push({
            key: "join",
            label: "去加入组织",
            icon: <UserAddOutlined />,
            tone: "primary",
            disabled: organizations.length === 0,
            onClick: onOpenMembers,
          });
        }
        actions.push({ key: "reset-password", label: "重置密码", icon: <KeyOutlined />, onClick: () => openReset(account) });
        return <RowActions disabled={busy} actions={actions} />;
      },
    },
  ];

  // 表格排版方案（自动省略 + 定宽排版）
  const table = useMemo(() => dataTable<MemberRow>({ columns }), [columns]);

  return (
    <Card
      variant="outlined"
      title="账号总览"
      extra={
        <Typography.Text type="secondary">
          共 {accountTotal} 个账号 · 无组织 {unassignedCount} 个
        </Typography.Text>
      }
    >
      <Flex vertical gap="middle">
        <TableToolbar
          extra={
            <Typography.Text type="secondary">
              共 {accounts.total} 个{filtered ? "（已筛选）" : ""}
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
          <Select value={scope} onChange={onScopeChange} style={{ width: 220 }} options={scopeOptions} />
          <Select
            value={roleFilter}
            style={{ width: 140 }}
            onChange={(value: string) => list.patch({ role: value === "all" ? null : value })}
            options={ACCOUNT_ROLE_FILTER_OPTIONS}
          />
          <Select
            value={stateFilter}
            style={{ width: 140 }}
            onChange={(value: string) => list.patch({ state: value === "all" ? null : value })}
            options={STATE_FILTER_OPTIONS}
          />
          {filtered ? (
            <Button color="default" variant="text" onClick={() => list.patch({ q: null, role: null, state: null, scope: null })}>
              重置
            </Button>
          ) : null}
        </TableToolbar>

        <Table<MemberRow>
          {...table}
          rowKey="id"
          size="middle"
          dataSource={rows}
          loading={busy}
          pagination={paging.pagination}
          onChange={paging.onTableChange}
          locale={{
            emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的账号" />,
          }}
        />

        <Modal
          open={resetTarget !== null}
          title={resetResult ? "密码已重置" : `重置密码：${resetTarget?.name ?? ""}`}
          okText={resetResult ? "完成" : "确认重置"}
          onOk={resetResult ? closeReset : submitReset}
          onCancel={closeReset}
          confirmLoading={resetSubmitting}
          okButtonProps={{ disabled: !resetResult && resetMode === "manual" && manualPassword.length < 8 }}
        >
          {resetResult ? (
            <Flex vertical gap="small">
              <Typography.Text type="secondary">
                {resetResult.password ? "请把临时密码交给使用者（只显示这一次）。" : "新密码已生效。"}
                该账号的现有登录已全部失效，下次登录必须先修改密码。
              </Typography.Text>
              {resetResult.password ? (
                <Typography.Text code copyable>
                  {resetResult.password}
                </Typography.Text>
              ) : null}
            </Flex>
          ) : (
            <Flex vertical gap="middle">
              <Typography.Text type="secondary">重置后该账号的现有登录会立即失效，且下次登录必须先修改密码。</Typography.Text>
              <Radio.Group
                value={resetMode}
                onChange={(event) => setResetMode(event.target.value as "generate" | "manual")}
                options={[
                  { value: "generate", label: "随机生成密码" },
                  { value: "manual", label: "手动输入新密码" },
                ]}
              />
              {resetMode === "manual" ? (
                <Input.Password
                  value={manualPassword}
                  autoComplete="new-password"
                  placeholder="至少 8 位"
                  onChange={(event) => setManualPassword(event.target.value)}
                />
              ) : null}
              {resetError ? <Typography.Text type="danger">{resetError}</Typography.Text> : null}
            </Flex>
          )}
        </Modal>
      </Flex>
    </Card>
  );
}

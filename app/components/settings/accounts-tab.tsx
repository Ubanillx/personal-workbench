import type React from "react";
import { useMemo, useState } from "react";
import { Button, Card, Empty, Flex, Input, Select, Space, Table, Tag, Typography, type TableProps } from "antd";
import { UserAddOutlined } from "@ant-design/icons";
import type { Organization } from "../../../shared/types/domain";
import { TableToolbar } from "../crud-toolbar";
import { dataTable } from "../table-layout";
import { RowActions } from "../crud-actions";
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
  accounts: MemberRow[];
  accountTotal: number;
  unassignedCount: number;
  scope: string;
  organizations: Organization[];
  onScopeChange: (scope: string) => void;
  busy: boolean;
  /** 跳到「组织与成员」Tab */
  onOpenMembers: () => void;
};

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
  const [keyword, setKeyword] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");

  const filtered = useMemo(
    () =>
      accounts.filter((account) => {
        if (keyword && !`${account.name}${account.username}${account.email}`.includes(keyword)) return false;
        if (roleFilter !== "all" && account.role !== roleFilter) return false;
        if (stateFilter === "active" && account.isActive !== 1) return false;
        if (stateFilter === "inactive" && account.isActive === 1) return false;
        return true;
      }),
    [accounts, keyword, roleFilter, stateFilter],
  );

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
      sorter: (a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"),
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
      // 「去加入组织」一个图标动作按钮，撑满一列的最小宽度
      width: 120,
      align: "right",
      ellipsis: false,
      render: (_value, account) =>
        account.orgId === null && account.role !== "admin" ? (
          <RowActions
            disabled={busy}
            actions={[
              {
                key: "join",
                label: "去加入组织",
                icon: <UserAddOutlined />,
                tone: "primary",
                disabled: organizations.length === 0,
                onClick: onOpenMembers,
              },
            ]}
          />
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
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
              显示 {filtered.length} / {accounts.length} 个
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
          <Select value={scope} onChange={onScopeChange} style={{ width: 220 }} options={scopeOptions} />
          <Select value={roleFilter} style={{ width: 140 }} onChange={setRoleFilter} options={ACCOUNT_ROLE_FILTER_OPTIONS} />
          <Select value={stateFilter} style={{ width: 140 }} onChange={setStateFilter} options={STATE_FILTER_OPTIONS} />
          {keyword || roleFilter !== "all" || stateFilter !== "all" || scope !== FILTER_ALL ? (
            <Button
              color="default"
              variant="text"
              onClick={() => {
                setKeyword("");
                setRoleFilter("all");
                setStateFilter("all");
                onScopeChange(FILTER_ALL);
              }}
            >
              重置
            </Button>
          ) : null}
        </TableToolbar>

        <Table<MemberRow>
          {...table}
          rowKey="id"
          size="middle"
          dataSource={filtered}
          loading={busy}
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
  );
}

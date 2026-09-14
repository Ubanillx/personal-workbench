import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { App as AntdApp, Button, Card, Empty, Flex, Form as AntdForm, Input, Select, Table, Tag, Typography, type TableProps } from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, TeamOutlined, UndoOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { Organization } from "../../../shared/types/domain";
import type { Paged } from "../../lib/paging";
import { confirmDanger, RowActions, type RowAction } from "../crud-actions";
import { useListParams, useServerTable } from "../crud-hooks";
import { FormDrawer } from "../crud-drawer";
import { dataTable } from "../table-layout";
import { TableToolbar } from "../crud-toolbar";
import { ORG_STATUS_COLOR, ORG_STATUS_LABEL } from "./constants";
import type { PostPayload } from "./types";

/**
 * Tab2「组织总览」（仅管理员）——原 `/admin` 页的组织维度管理。
 *
 * 这是管理员对组织的唯一写入口：新建 / 编辑 / 解散 / 恢复 / 管理成员。
 * 组织管理者的组织解散入口在「组织与成员」Tab 的危险操作卡，两者不重叠。
 */
type Props = {
  /** 组织列表：服务端筛选 + 排序 + 分页的结果（页面只渲染当页） */
  organizations: Paged<Organization>;
  post: PostPayload;
  busy: boolean;
  error: string;
  successTick: number;
  /** 跳到「组织与成员」Tab 并选中该组织 */
  onOpenMembers: (orgId: string) => void;
};

export function OrgOverviewTab({ organizations, post, busy, error, successTick, onOpenMembers }: Props): React.ReactElement {
  const { modal } = AntdApp.useApp();
  const [createForm] = AntdForm.useForm<{ name?: string; description?: string }>();
  const [editForm] = AntdForm.useForm<{ name?: string; description?: string }>();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Organization | null>(null);
  /**
   * 状态筛选放在 URL 上（原来在列头的筛选下拉里，只作用于当前页）：
   * 服务端分页后它必须在 SQL 里生效，入口也搬到工具栏（同一字段只留一套说法）。
   */
  const list = useListParams();
  const status = list.get("status", "all");
  const filtered = status !== "all";
  /** 服务端分页：翻页、改条数与表头排序都只写回 URL，由 loader 决定这一页是谁 */
  const rows = organizations.rows;
  const paging = useServerTable<Organization>(organizations);

  useEffect(() => {
    if (successTick > 0) {
      setCreateOpen(false);
      setEditing(null);
    }
  }, [successTick]);

  const columns: TableProps<Organization>["columns"] = [
    {
      title: "组织名称",
      dataIndex: "name",
      key: "name",
      // 表头排序由服务端做（客户端比较器只能排当前这一页）
      sorter: true,
      sortOrder: paging.sortOrderOf("name"),
      render: (_value, org) => <Typography.Text strong>{org.name}</Typography.Text>,
    },
    { title: "说明", dataIndex: "description", key: "description", render: (_value, org) => org.description || "—" },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      // 列上的筛选下拉已删除：状态由工具栏的筛选器负责（列筛选只作用于当前页）
      render: (_value, org) => (
        <Tag color={ORG_STATUS_COLOR[org.status]} variant="filled">
          {ORG_STATUS_LABEL[org.status]}
        </Tag>
      ),
    },
    {
      title: "成员",
      dataIndex: "memberCount",
      key: "memberCount",
      width: 100,
      sorter: true,
      sortOrder: paging.sortOrderOf("memberCount"),
      render: (_value, org) => `${org.memberCount ?? 0} 人`,
    },
    {
      title: "创建时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 170,
      sorter: true,
      sortOrder: paging.sortOrderOf("createdAt"),
      render: (_value, org) => dayjs(org.createdAt).format("YYYY-MM-DD HH:mm"),
    },
    {
      title: "操作",
      key: "actions",
      // 图标动作按钮平铺（管理成员 / 编辑 / 解散 或 恢复），每个约 36px
      width: 160,
      align: "right",
      ellipsis: false,
      render: (_value, org) => {
        const actions: RowAction[] =
          org.status === "archived"
            ? [
                {
                  key: "restore",
                  label: "恢复组织",
                  icon: <UndoOutlined />,
                  onClick: () => post({ intent: "restore", orgId: org.id }),
                },
              ]
            : [
                {
                  key: "members",
                  label: "管理成员",
                  icon: <TeamOutlined />,
                  onClick: () => onOpenMembers(org.id),
                },
                {
                  key: "edit",
                  label: "编辑组织信息",
                  icon: <EditOutlined />,
                  onClick: () => setEditing(org),
                },
                {
                  key: "archive",
                  label: "解散（归档）",
                  icon: <DeleteOutlined />,
                  tone: "danger",
                  onClick: () =>
                    confirmDanger(modal, {
                      title: `解散组织「${org.name}」？`,
                      content: "成员将退回「未加入」，数据保留；仅管理员可恢复。",
                      okText: "解散",
                      onOk: () => post({ intent: "archive", orgId: org.id }),
                    }),
                },
              ];
        return <RowActions actions={actions} disabled={busy} />;
      },
    },
  ];

  // 表格排版方案（自动省略 + 定宽排版）
  const table = useMemo(() => dataTable<Organization>({ columns }), [columns]);

  return (
    <Flex vertical gap="large">
      <Card
        variant="outlined"
        title={`组织总览（${organizations.total} 个）`}
        extra={
          <Flex align="center" gap="small" wrap>
            <Typography.Text type="secondary">解散 = 归档，可恢复</Typography.Text>
            <Button color="primary" variant="solid" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建组织
            </Button>
          </Flex>
        }
      >
        <Flex vertical gap="middle">
          <TableToolbar
            extra={
              <Typography.Text type="secondary">
                共 {organizations.total} 个组织{filtered ? "（已筛选）" : ""}
              </Typography.Text>
            }
          >
            <Select
              aria-label="按状态筛选"
              value={status}
              style={{ width: 140 }}
              options={[
                { value: "all", label: "全部状态" },
                { value: "active", label: ORG_STATUS_LABEL.active },
                { value: "archived", label: ORG_STATUS_LABEL.archived },
              ]}
              onChange={(value: string) => list.patch({ status: value === "all" ? null : value })}
            />
            {filtered ? (
              <Button color="default" variant="text" onClick={() => list.patch({ status: null })}>
                重置
              </Button>
            ) : null}
          </TableToolbar>
          <Table<Organization>
            {...table}
            rowKey="id"
            size="middle"
            dataSource={rows}
            loading={busy}
            pagination={paging.pagination}
            onChange={paging.onTableChange}
            locale={{
              emptyText: (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filtered ? "没有符合条件的组织" : "还没有任何组织"}>
                  <Button color="primary" variant="solid" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                    新建组织
                  </Button>
                </Empty>
              ),
            }}
          />
        </Flex>
      </Card>

      <FormDrawer
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
          <Input maxLength={40} showCount placeholder="2-40 个字符" />
        </AntdForm.Item>
        <AntdForm.Item name="description" label="组织说明">
          <Input.TextArea rows={3} maxLength={200} showCount placeholder="可选，简述职责" />
        </AntdForm.Item>
      </FormDrawer>

      <FormDrawer
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
      </FormDrawer>
    </Flex>
  );
}

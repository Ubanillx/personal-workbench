import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { App as AntdApp, Button, Card, Empty, Flex, Form as AntdForm, Input, Table, Tag, Typography, type TableProps } from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, TeamOutlined, UndoOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { Organization } from "../../../shared/types/domain";
import { confirmDanger, RowActions, type RowAction } from "../crud-actions";
import { FormDrawer } from "../crud-drawer";
import { dataTable } from "../table-layout";
import { ORG_STATUS_COLOR, ORG_STATUS_LABEL } from "./constants";
import type { PostPayload } from "./types";

/**
 * Tab2「组织总览」（仅管理员）——原 `/admin` 页的组织维度管理。
 *
 * 这是管理员对组织的唯一写入口：新建 / 编辑 / 解散 / 恢复 / 管理成员。
 * 组织管理者的组织解散入口在「组织与成员」Tab 的危险操作卡，两者不重叠。
 */
type Props = {
  organizations: Organization[];
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
        title={`组织总览（${organizations.length} 个）`}
        extra={
          <Flex align="center" gap="small" wrap>
            <Typography.Text type="secondary">解散 = 归档，可恢复</Typography.Text>
            <Button color="primary" variant="solid" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建组织
            </Button>
          </Flex>
        }
      >
        <Table<Organization>
          {...table}
          rowKey="id"
          size="middle"
          dataSource={organizations}
          loading={busy}
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

import type React from "react";
import { Form, useActionData, useLoaderData, useNavigate, useNavigation, useRevalidator, useSearchParams } from "react-router";
import { Alert, Button, Empty, Flex, Input, Popconfirm, Segmented, Space, Table, Typography, type TableProps } from "antd";
import { CopyOutlined, DeleteOutlined, PlusOutlined, SearchOutlined } from "@ant-design/icons";
import { createFileRecord, listFiles } from "../lib/files.server";
import { requireManagerOrRedirect } from "../lib/ui.server";

type FileRow = { id: string; name: string; filePath: string; category: string; lastUsedAt: string | null };

/**
 * 文件页：与 GET /api/files 共用 app/lib/files.server.ts。
 * 文件库只对管理员与组织管理者开放（§4），普通成员由 requireManagerOrRedirect 送回首页；
 * 列表按组织过滤，`?org=` 是管理员（D-28）的筛选器接缝：既是列表过滤，也是管理员新增时的目标组织。
 */
export async function loader({ request }: { request: Request }) {
  const user = requireManagerOrRedirect(request);
  const query = new URL(request.url).searchParams;
  // 组织筛选器只对管理员有意义（D-28），与 /tasks 页的写法一致
  const files = listFiles(
    user,
    (query.get("search") ?? "").trim(),
    (query.get("category") ?? "").trim(),
    user.role === "admin" ? query.get("org") : null,
  ) as unknown as FileRow[];
  return { files };
}

/** 新增文件索引：表单是 form-urlencoded，因此读 formData 并调用共享服务（不是打收 JSON 的 API） */
export async function action({ request }: { request: Request }) {
  const user = requireManagerOrRedirect(request);
  const form = await request.formData();
  // 组织归属由 app/lib/files.server.ts 解析：管理者写本组织；
  // 管理员是全局角色，目标组织先看表单字段，再看页面上的组织筛选器 ?org=（D-28 的接缝）
  const created = createFileRecord(user, {
    name: String(form.get("name") ?? ""),
    filePath: String(form.get("filePath") ?? ""),
    category: String(form.get("category") ?? ""),
    orgId: form.get("orgId") || new URL(request.url).searchParams.get("org"),
  });
  return { error: created.ok ? null : created.message };
}

export default function FilesRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const search = params.get("search") ?? "";
  const filter = params.get("category") ?? "";
  const busy = navigation.state !== "idle" || revalidator.state !== "idle";

  const files = data.files;
  const categories = [...new Set(files.map((file) => file.category).filter(Boolean))];
  const filterOptions = [{ value: "", label: "全部" }, ...categories.map((item) => ({ value: item, label: `#${item}` }))];

  const copy = (file: FileRow): void => {
    if (!navigator.clipboard) {
      window.prompt("请复制以下路径", file.filePath);
      return;
    }
    void navigator.clipboard
      .writeText(file.filePath)
      .then(() => fetch(`/api/files/${file.id}/use`, { method: "POST", credentials: "include" }))
      .then(() => revalidator.revalidate())
      .catch(() => window.prompt("请复制以下路径", file.filePath));
  };
  const remove = (file: FileRow): void => {
    void fetch(`/api/files/${file.id}`, { method: "DELETE", credentials: "include" }).then(() => revalidator.revalidate());
  };

  const columns: TableProps<FileRow>["columns"] = [
    {
      title: "文件",
      dataIndex: "name",
      key: "name",
      render: (_value, file) => (
        <Flex vertical gap={2}>
          <Typography.Text strong>{file.name}</Typography.Text>
          <Typography.Text type="secondary">
            {file.category ? `[${file.category}] ` : ""}
            {file.filePath}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: "最近使用",
      dataIndex: "lastUsedAt",
      key: "lastUsedAt",
      render: (_value, file) => (
        <Typography.Text type="secondary">{file.lastUsedAt ? new Date(file.lastUsedAt).toLocaleString() : "尚未记录"}</Typography.Text>
      ),
    },
    {
      title: "操作",
      key: "actions",
      render: (_value, file) => (
        <Space size="small">
          <Button icon={<CopyOutlined />} onClick={() => copy(file)}>
            复制路径
          </Button>
          <Popconfirm title="确定删除文件索引吗？" okText="确定" cancelText="取消" onConfirm={() => remove(file)}>
            <Button danger variant="text" icon={<DeleteOutlined />} aria-label="删除文件索引" />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <Space align="center" className="page-head" size="middle">
        <div>
          <Typography.Title level={3} className="page-title">
            重要文件
          </Typography.Title>
          <Typography.Text type="secondary">只保存本机或共享盘路径索引，不上传文件内容。</Typography.Text>
        </div>
        {/* 搜索走 GET 表单：改动 URL 查询参数并重跑 loader，不再维护一份列表 state */}
        <Form method="get" className="quick-add">
          <Space.Compact>
            <Input name="search" defaultValue={search} placeholder="搜索名称或路径" style={{ maxWidth: 280 }} allowClear />
            {filter ? <input type="hidden" name="category" value={filter} /> : null}
            <Button icon={<SearchOutlined />} htmlType="submit">
              搜索
            </Button>
          </Space.Compact>
        </Form>
      </Space>

      {/* 提交给本页 action（RR8 的 Form）；表单是 form-urlencoded，action 里读 formData */}
      <Form method="post">
        <Space wrap>
          <Input name="name" placeholder="文件名称" />
          <Input name="filePath" placeholder="文件路径" />
          <Input name="category" placeholder="分类" />
          <Button color="primary" variant="solid" htmlType="submit" icon={<PlusOutlined />} disabled={busy} loading={busy}>
            {busy ? "保存中…" : "添加"}
          </Button>
        </Space>
      </Form>

      {categories.length > 0 && (
        <Segmented
          value={filter}
          options={filterOptions}
          onChange={(value) => {
            const next = new URLSearchParams();
            if (search) next.set("search", search);
            if (String(value)) next.set("category", String(value));
            navigate(next.toString() ? `?${next.toString()}` : "?", { replace: true });
          }}
        />
      )}

      {actionData?.error && <Alert type="error" showIcon title={actionData.error} />}

      <Table<FileRow>
        rowKey="id"
        columns={columns}
        dataSource={files}
        pagination={false}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Space orientation="vertical" size={2}>
                  <Typography.Text strong>暂无已登记文件</Typography.Text>
                  <Typography.Text type="secondary">添加报价单、客户资料或模板路径。</Typography.Text>
                </Space>
              }
            />
          ),
        }}
      />
    </Space>
  );
}

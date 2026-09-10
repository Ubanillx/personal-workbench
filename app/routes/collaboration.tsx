import type React from "react";
import { useState } from "react";
import { useLoaderData, useRevalidator } from "react-router";
import { Alert, Button, Card, Flex, Form, Input, Popconfirm, Select, Space, Table, Tag, Typography, type TableProps } from "antd";
import { CheckOutlined, CopyOutlined, PlusOutlined } from "@ant-design/icons";
import { accessInfoPayload } from "../lib/access.server";
import { requireUserOrRedirect } from "../lib/ui.server";
import { listUsers } from "../lib/users.server";
import type { UserRole } from "../../shared/types/domain";

type Collaborator = { id: string; name: string; role: UserRole; isActive: number | boolean };
type AccessInfo = { port: number; host: string; localUrl: string; lanUrls: string[]; warning: string };

const roleLabel: Record<UserRole, string> = { owner: "主人", assistant: "助理", viewer: "查看者" };

/** 协作管理 loader：与 GET /api/users、/api/access-info 共用服务；仅主人可见 */
export async function loader({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  if (user.role !== "owner") {
    return { forbidden: true as const, role: user.role, members: [] as Collaborator[], access: null as AccessInfo | null };
  }
  return {
    forbidden: false as const,
    role: user.role,
    members: listUsers() as unknown as Collaborator[],
    access: accessInfoPayload(),
  };
}

export default function CollaborationRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [token, setToken] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (data.forbidden) {
    return (
      <Space orientation="vertical" size="large" className="page-stack">
        <div>
          <Typography.Title level={3} className="page-title">
            协作管理
          </Typography.Title>
        </div>
        <Alert
          type="error"
          showIcon
          title="当前账户没有成员管理权限"
          description={`当前登录身份为${roleLabel[data.role]}，只有主人可以管理成员。请退出当前账户，并使用主人令牌重新登录。`}
          action={
            <form method="post" action="/logout">
              <Button htmlType="submit">退出并重新登录</Button>
            </form>
          }
        />
      </Space>
    );
  }

  const copy = (value: string, label: string): void => {
    const fallback = (): void => {
      window.prompt(`请复制${label}`, value);
    };
    if (!navigator.clipboard) {
      fallback();
      return;
    }
    void navigator.clipboard
      .writeText(value)
      .then(() => setNotice(`${label}已复制`))
      .catch(fallback);
  };

  /**
   * 三个写操作都走 JSON API 再 revalidate：它们需要把响应里的令牌写进页面状态，
   * 这正是约定 3 的第 ② 条路径（需要 JSON 响应），与旧实现的行为一致。
   */
  const create = async (values: { name: string; role: "assistant" | "viewer" }): Promise<void> => {
    if (!values.name?.trim() || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/users", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: values.name.trim(), role: values.role }),
      });
      const payload = (await response.json()) as { ok: boolean; data?: { token: string }; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? "新增成员失败");
      setToken(payload.data?.token ?? null);
      revalidator.revalidate();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "新增成员失败");
    } finally {
      setBusy(false);
    }
  };

  const toggleMember = async (member: Collaborator): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/users/${member.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: !member.isActive }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? "成员状态更新失败");
      setNotice(`${member.name}已${member.isActive ? "停用" : "启用"}`);
      revalidator.revalidate();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "成员状态更新失败");
    } finally {
      setBusy(false);
    }
  };

  const rotateToken = async (member: Collaborator): Promise<void> => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/users/${member.id}/token`, { method: "POST", credentials: "include" });
      const payload = (await response.json()) as { ok: boolean; data?: { token: string }; error?: { message: string } };
      if (!payload.ok) throw new Error(payload.error?.message ?? "令牌生成失败");
      setToken(payload.data?.token ?? null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "令牌生成失败");
    } finally {
      setBusy(false);
    }
  };

  const memberColumns: TableProps<Collaborator>["columns"] = [
    { title: "成员", dataIndex: "name", key: "name", render: (_value, member) => <Typography.Text strong>{member.name}</Typography.Text> },
    { title: "角色", dataIndex: "role", key: "role", render: (_value, member) => roleLabel[member.role] },
    {
      title: "状态",
      dataIndex: "isActive",
      key: "isActive",
      render: (_value, member) => (
        <Tag color={member.isActive ? "green" : "default"} variant="filled">
          {member.isActive ? "启用中" : "已停用"}
        </Tag>
      ),
    },
    {
      title: "操作",
      key: "actions",
      render: (_value, member) =>
        member.role === "owner" ? null : (
          <Space size="small">
            <Popconfirm
              title={`${member.isActive ? "停用" : "启用"}${member.name}？`}
              okText="确定"
              cancelText="取消"
              onConfirm={() => void toggleMember(member)}
            >
              <Button disabled={busy}>{member.isActive ? "停用" : "启用"}</Button>
            </Popconfirm>
            <Popconfirm
              title={`重新生成 ${member.name} 的令牌会使旧令牌失效，继续吗？`}
              okText="确定"
              cancelText="取消"
              onConfirm={() => void rotateToken(member)}
            >
              <Button disabled={busy || !member.isActive}>重发令牌</Button>
            </Popconfirm>
          </Space>
        ),
    },
  ];

  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <div>
        <Typography.Title level={3} className="page-title">
          协作管理
        </Typography.Title>
        <Typography.Text type="secondary">停用成员会立即让会话和长期令牌失效；启用后请重新生成令牌。</Typography.Text>
      </div>

      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          action={
            <Button size="small" onClick={() => revalidator.revalidate()}>
              重试
            </Button>
          }
        />
      )}
      {notice && <Alert type="info" showIcon title={notice} />}

      <Form
        layout="inline"
        initialValues={{ role: "assistant" }}
        onFinish={(values: { name: string; role: "assistant" | "viewer" }) => void create(values)}
      >
        <Form.Item name="name">
          <Input placeholder="成员名称" />
        </Form.Item>
        <Form.Item name="role">
          <Select
            options={[
              { value: "assistant", label: "助理" },
              { value: "viewer", label: "查看者" },
            ]}
          />
        </Form.Item>
        <Form.Item>
          <Button color="primary" variant="solid" htmlType="submit" icon={<PlusOutlined />} disabled={busy} loading={busy}>
            {busy ? "创建中…" : "新增成员"}
          </Button>
        </Form.Item>
      </Form>

      <Card variant="outlined" title="助理访问地址">
        <Space orientation="vertical" size="small" className="list-block">
          {data.access?.lanUrls.length ? (
            data.access.lanUrls.map((url) => (
              <Flex key={url} align="center" justify="space-between" gap="small" wrap>
                <Typography.Text code>{url}</Typography.Text>
                <Button icon={<CopyOutlined />} onClick={() => copy(url, "访问地址")}>
                  复制
                </Button>
              </Flex>
            ))
          ) : (
            <Typography.Text type="secondary">
              未检测到局域网地址，请确认正式服务使用 <Typography.Text code>HOST=0.0.0.0</Typography.Text> 启动。
            </Typography.Text>
          )}
          <Typography.Text>
            {data.access?.warning ?? "仅允许同一局域网的助理访问；不要发送 127.0.0.1、0.0.0.0 或带令牌的链接。"}
          </Typography.Text>
        </Space>
      </Card>

      {token && (
        <Card variant="outlined" title="长期令牌（仅显示一次）">
          <Space orientation="vertical" size="small" className="list-block">
            <Typography.Text code style={{ wordBreak: "break-all" }}>
              {token}
            </Typography.Text>
            <Space size="small">
              <Button icon={<CopyOutlined />} onClick={() => copy(token, "长期令牌")}>
                复制令牌
              </Button>
              <Button icon={<CheckOutlined />} onClick={() => setToken(null)}>
                已安全保存
              </Button>
            </Space>
          </Space>
        </Card>
      )}

      <Table<Collaborator> rowKey="id" columns={memberColumns} dataSource={data.members} pagination={false} />
    </Space>
  );
}

import type React from "react";
import { Link, redirect, useActionData, useNavigation, useSubmit } from "react-router";
import { Alert, Avatar, Button, Card, Form, Input, Space, Typography } from "antd";
import { LockOutlined, MailOutlined, IdcardOutlined, UserOutlined } from "@ant-design/icons";
import { appConfig } from "../lib/context.server";
import { readPayload } from "../lib/form.server";
import { createSession, isSecureRequest, optionalUser, registerAccount, sessionCookie } from "../lib/session.server";

/**
 * 注册页（开放注册，D-20）。
 *
 * 客户端校验只用于即时提示，真正的规则在 session.server 的 registerAccount 里（用户名 3-32 位、
 * 邮箱唯一、密码 ≥8 位），失败时把服务端文案原样显示。
 * 注册成功后直接登录，新账号 role=member 且没有组织，因此落到 /join（D-24 / D-34）。
 */

/** 与 registerAccount 的 USERNAME_PATTERN 保持一致，仅用于表单提示 */
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/u;

function textField(data: unknown, key: string): string {
  if (data && typeof data === "object" && key in data) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return "";
}

export async function loader({ request }: { request: Request }) {
  const user = optionalUser(request, appConfig().sessionCookieName);
  if (user) {
    if (user.mustChangePassword) throw redirect("/password");
    throw redirect(user.orgId || user.role === "admin" ? "/" : "/join");
  }
  return null;
}

export async function action({ request }: { request: Request }): Promise<Response | { error: string }> {
  const payload = await readPayload(request);
  const result = await registerAccount({
    username: payload.username,
    email: payload.email,
    password: payload.password,
    name: payload.name,
  });
  if (!result.ok) return { error: result.message };

  const cookieName = appConfig().sessionCookieName;
  const response = redirect("/join");
  response.headers.append("set-cookie", sessionCookie(cookieName, createSession(result.user.id), isSecureRequest(request)));
  return response;
}

export default function RegisterRoute(): React.ReactElement {
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const busy = useNavigation().state !== "idle";
  const error = textField(actionData, "error");

  return (
    <div className="center-screen">
      <Card className="access-card">
        <Space orientation="vertical" size="large" className="access-stack">
          <Space orientation="vertical" size={4} align="center" className="access-brand">
            <Avatar shape="square" size={48} className="brand-avatar">
              台
            </Avatar>
            <Typography.Title level={4} className="access-title">
              注册新账号
            </Typography.Title>
            <Typography.Text type="secondary">注册后需要申请加入组织才能使用工作台</Typography.Text>
          </Space>

          {error && <Alert type="error" showIcon title={error} />}

          <Form
            layout="vertical"
            onFinish={(values: { username?: string; email?: string; password?: string; name?: string }) => {
              if (busy) return;
              submit(
                {
                  username: values.username ?? "",
                  email: values.email ?? "",
                  password: values.password ?? "",
                  name: values.name ?? "",
                },
                { method: "post", encType: "application/json" },
              );
            }}
          >
            <Form.Item
              name="username"
              label="用户名"
              rules={[
                { required: true, message: "请输入用户名" },
                { pattern: USERNAME_PATTERN, message: "用户名需为 3-32 位字母、数字、下划线或短横线" },
              ]}
            >
              <Input autoFocus prefix={<UserOutlined />} placeholder="3–32 位字母、数字、下划线或短横线" autoComplete="username" />
            </Form.Item>
            <Form.Item
              name="email"
              label="邮箱"
              rules={[
                { required: true, message: "请输入邮箱" },
                { type: "email", message: "邮箱格式不正确" },
              ]}
            >
              <Input prefix={<MailOutlined />} placeholder="请输入邮箱" autoComplete="email" />
            </Form.Item>
            <Form.Item name="name" label="显示名" extra="不填则直接用用户名">
              <Input prefix={<IdcardOutlined />} placeholder="显示名（可选）" autoComplete="name" />
            </Form.Item>
            <Form.Item
              name="password"
              label="密码"
              rules={[
                { required: true, message: "请输入密码" },
                { min: 8, message: "密码至少 8 位" },
              ]}
            >
              <Input.Password prefix={<LockOutlined />} placeholder="至少 8 位" autoComplete="new-password" />
            </Form.Item>
            <Button color="primary" variant="solid" htmlType="submit" block loading={busy}>
              注册并登录
            </Button>
          </Form>

          <div className="access-brand">
            <Typography.Text type="secondary">
              已经有账号？<Link to="/login">去登录</Link>
            </Typography.Text>
          </div>
        </Space>
      </Card>
    </div>
  );
}

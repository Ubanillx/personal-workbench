import type React from "react";
import { Link, redirect, useActionData, useNavigation, useSearchParams, useSubmit } from "react-router";
import { Alert, Avatar, Button, Card, Form, Input, Space, Typography } from "antd";
import { LockOutlined, UserOutlined } from "@ant-design/icons";
import type { UserRole } from "../../shared/types/domain";
import { appConfig } from "../lib/context.server";
import { readPayload } from "../lib/form.server";
import { authenticate, createSession, isSecureRequest, optionalUser, sessionCookie } from "../lib/session.server";

/**
 * 登录页（替代旧的 /access 令牌登录）。
 *
 * 三种「已经登录的人打开登录页」的落点，优先级从高到低：
 * 1. 强制改密 → /password（否则除了改密与登出什么都做不了）；
 * 2. 未加入组织的普通账号 → /join（D-34：它只能访问组织列表与我的申请）；
 * 3. 其余 → redirectTo（限站内路径），默认 /。
 */
function landingFor(user: { role: UserRole; orgId: string | null; mustChangePassword: boolean }, target: string): string {
  if (user.mustChangePassword) return "/password";
  if (!user.orgId && user.role !== "admin") return "/join";
  return target;
}

/** 只接受站内绝对路径：挡掉 `//evil.com`、`/\evil.com` 这类开放重定向 */
function safeRedirectTo(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^\/(?!\/)[^\\]*$/u.test(raw) ? raw : "/";
}

/** 从 actionData 里安全取一个字符串字段（action 也可能返回 Response，所以不能直接点属性） */
function textField(data: unknown, key: string): string {
  if (data && typeof data === "object" && key in data) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/** 已登录的人不必再看登录页，直接送回它该去的地方 */
export async function loader({ request }: { request: Request }) {
  const target = safeRedirectTo(new URL(request.url).searchParams.get("redirectTo"));
  const user = optionalUser(request, appConfig().sessionCookieName);
  if (user) throw redirect(landingFor(user, target));
  return null;
}

export async function action({ request }: { request: Request }): Promise<Response | { error: string }> {
  const payload = await readPayload(request);
  const username = typeof payload.username === "string" ? payload.username.trim() : "";
  const password = typeof payload.password === "string" ? payload.password : "";
  const target = safeRedirectTo(payload.redirectTo ?? new URL(request.url).searchParams.get("redirectTo"));
  if (!username || !password) return { error: "请输入用户名与密码" };

  const user = await authenticate(username, password);
  if (!user) return { error: "用户名或密码不正确" };

  const cookieName = appConfig().sessionCookieName;
  const response = redirect(landingFor(user, target));
  response.headers.append("set-cookie", sessionCookie(cookieName, createSession(user.id), isSecureRequest(request)));
  return response;
}

export default function LoginRoute(): React.ReactElement {
  const [params] = useSearchParams();
  const redirectTo = safeRedirectTo(params.get("redirectTo"));
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
              登录个人工作台
            </Typography.Title>
            <Typography.Text type="secondary">用用户名与密码登录</Typography.Text>
          </Space>

          {error && <Alert type="error" showIcon title={error} />}

          <Form
            layout="vertical"
            onFinish={(values: { username?: string; password?: string }) => {
              if (busy) return;
              submit(
                { username: values.username ?? "", password: values.password ?? "", redirectTo },
                { method: "post", encType: "application/json" },
              );
            }}
          >
            <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
              <Input autoFocus prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
            </Form.Item>
            <Button color="primary" variant="solid" htmlType="submit" block loading={busy}>
              登录
            </Button>
          </Form>

          <div className="access-brand">
            <Typography.Text type="secondary">
              还没有账号？<Link to={`/register?redirectTo=${encodeURIComponent(redirectTo)}`}>去注册</Link>
            </Typography.Text>
          </div>
          <Typography.Text type="secondary" className="access-brand">
            忘记密码只能在本机运行 <Typography.Text code>npm run user:passwd</Typography.Text> 重置。
          </Typography.Text>
        </Space>
      </Card>
    </div>
  );
}

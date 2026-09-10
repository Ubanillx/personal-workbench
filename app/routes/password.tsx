import type React from "react";
import { redirect, useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { Alert, Avatar, Button, Card, Form, Input, Space, Typography } from "antd";
import { KeyOutlined, LockOutlined } from "@ant-design/icons";
import { appConfig } from "../lib/context.server";
import { readPayload } from "../lib/form.server";
import { changeOwnPassword, readCookie, requireAuth } from "../lib/session.server";

/**
 * 改密页。`must_change_password=1` 时它是**唯一可达**的业务页面（其它页面一律重定向到这里）。
 *
 * 这里刻意不做「未入组 → /join」的重定向：改密是所有操作的前置条件，
 * 若本页也往外跳，会和 /join（未改密则跳回 /password）互相弹来弹去。
 */

function loginUrl(request: Request): string {
  const url = new URL(request.url);
  const target = `${url.pathname}${url.search}`;
  return target === "/" ? "/login" : `/login?redirectTo=${encodeURIComponent(target)}`;
}

function textField(data: unknown, key: string): string {
  if (data && typeof data === "object" && key in data) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return "";
}

export async function loader({ request }: { request: Request }) {
  // 页面要给人看，所以未登录是跳登录页而不是返回 401 JSON；skipPasswordGate 是本页存在的前提
  const auth = requireAuth(request, appConfig().sessionCookieName, { skipPasswordGate: true });
  if (!auth.ok) throw redirect(loginUrl(request));
  return {
    username: auth.user.username,
    name: auth.user.name,
    mustChangePassword: auth.user.mustChangePassword,
  };
}

export async function action({ request }: { request: Request }): Promise<Response | { error: string }> {
  const cookieName = appConfig().sessionCookieName;
  const auth = requireAuth(request, cookieName, { skipPasswordGate: true });
  if (!auth.ok) throw redirect(loginUrl(request));

  const payload = await readPayload(request);
  const currentPassword = typeof payload.currentPassword === "string" ? payload.currentPassword : "";
  const newPassword = typeof payload.newPassword === "string" ? payload.newPassword : "";
  const confirmPassword = typeof payload.confirmPassword === "string" ? payload.confirmPassword : "";
  if (newPassword !== confirmPassword) return { error: "两次输入的新密码不一致" };
  if (newPassword && newPassword === currentPassword) return { error: "新密码不能与当前密码相同" };

  // 成功后撤销该账号在其它设备上的会话，保留当前会话
  const result = await changeOwnPassword(auth.user.id, currentPassword, newPassword, readCookie(request, cookieName));
  if (!result.ok) return { error: result.message };
  return redirect("/");
}

export default function PasswordRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
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
              修改密码
            </Typography.Title>
            <Typography.Text type="secondary">
              {data.name}（{data.username}）
            </Typography.Text>
          </Space>

          {data.mustChangePassword && (
            <Alert type="warning" showIcon title="首次登录需要修改初始密码" description="改完之后才能访问工作台的其它页面。" />
          )}
          {error && <Alert type="error" showIcon title={error} />}

          <Form
            layout="vertical"
            onFinish={(values: { currentPassword?: string; newPassword?: string; confirmPassword?: string }) => {
              if (busy) return;
              submit(
                {
                  currentPassword: values.currentPassword ?? "",
                  newPassword: values.newPassword ?? "",
                  confirmPassword: values.confirmPassword ?? "",
                },
                { method: "post", encType: "application/json" },
              );
            }}
          >
            <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: "请输入当前密码" }]}>
              <Input.Password autoFocus prefix={<LockOutlined />} placeholder="当前密码" autoComplete="current-password" />
            </Form.Item>
            <Form.Item
              name="newPassword"
              label="新密码"
              rules={[
                { required: true, message: "请输入新密码" },
                { min: 8, message: "密码至少 8 位" },
              ]}
            >
              <Input.Password prefix={<KeyOutlined />} placeholder="至少 8 位" autoComplete="new-password" />
            </Form.Item>
            <Form.Item
              name="confirmPassword"
              label="确认新密码"
              dependencies={["newPassword"]}
              rules={[
                { required: true, message: "请再次输入新密码" },
                ({ getFieldValue }) => ({
                  validator(_rule, value: string) {
                    if (!value || getFieldValue("newPassword") === value) return Promise.resolve();
                    return Promise.reject(new Error("两次输入的新密码不一致"));
                  },
                }),
              ]}
            >
              <Input.Password prefix={<KeyOutlined />} placeholder="再次输入新密码" autoComplete="new-password" />
            </Form.Item>
            <Button color="primary" variant="solid" htmlType="submit" block loading={busy}>
              保存新密码
            </Button>
          </Form>

          <div className="access-brand">
            <form method="post" action="/logout">
              <Button variant="text" htmlType="submit">
                退出登录
              </Button>
            </form>
          </div>
        </Space>
      </Card>
    </div>
  );
}

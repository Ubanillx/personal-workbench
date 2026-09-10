import type React from "react";
import { Form, redirect, useActionData, useNavigation, useSearchParams } from "react-router";
import { Alert, Avatar, Button, Card, Input, Space, Typography } from "antd";
import { LockOutlined } from "@ant-design/icons";
import { appConfig } from "../lib/context.server";
import { createSession, isSecureRequest, sessionCookie, userByToken } from "../lib/session.server";
import { redirectIfAuthenticated } from "../lib/ui.server";

/** 登录页：未登录时 root 渲染它（不套外壳），已登录则直接送回目标页 */
export async function loader({ request }: { request: Request }) {
  redirectIfAuthenticated(request);
  return null;
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData();
  const token = String(form.get("token") ?? "").trim();
  const redirectTo = String(form.get("redirectTo") ?? "/") || "/";
  const user = token ? userByToken(token) : null;
  if (!user) return { error: "访问令牌无效" };
  const response = redirect(redirectTo);
  response.headers.append("set-cookie", sessionCookie(appConfig().sessionCookieName, createSession(user.id), isSecureRequest(request)));
  return response;
}

export default function AccessRoute(): React.ReactElement {
  const [params] = useSearchParams();
  const navigation = useNavigation();
  const actionData = useActionData<typeof action>();
  const error = actionData && typeof actionData === "object" && "error" in actionData ? actionData.error : null;

  return (
    <div className="center-screen">
      <Card className="access-card">
        <Space orientation="vertical" size="large" className="access-stack">
          <Space orientation="vertical" size={4} align="center" className="access-brand">
            <Avatar shape="square" size={48} className="brand-avatar">
              台
            </Avatar>
            <Typography.Title level={4} className="access-title">
              访问个人工作台
            </Typography.Title>
            <Typography.Text type="secondary">请输入主人或协作者的访问令牌</Typography.Text>
          </Space>

          {error && <Alert type="error" showIcon title={error} />}

          <Form method="post">
            <input type="hidden" name="redirectTo" value={params.get("redirectTo") ?? "/"} />
            <div className="field-block">
              <Typography.Text>访问令牌</Typography.Text>
              <Input autoFocus name="token" prefix={<LockOutlined />} placeholder="访问令牌" />
            </div>
            <Button color="primary" variant="solid" htmlType="submit" block loading={navigation.state === "submitting"}>
              进入工作台
            </Button>
          </Form>
        </Space>
      </Card>
    </div>
  );
}

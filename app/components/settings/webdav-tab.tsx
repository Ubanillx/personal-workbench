import type React from "react";
import { useEffect, useState } from "react";
import { Alert, App as AntdApp, Button, Card, Flex, Form, Input, InputNumber, Space, Tag, Typography } from "antd";
import { DeleteOutlined, ExperimentOutlined, FolderOpenOutlined, SaveOutlined } from "@ant-design/icons";
import type { ReportUploadSettingsView, WebDavSettingsView } from "../../../shared/types/domain";
import { confirmDanger } from "../crud-actions";
import { ReportUploadCard } from "./report-upload-card";
import { WebDavDirPicker } from "./webdav-dir-picker";
import type { PostPayload } from "./types";

/**
 * Tab「WebDAV」——远端通道的连接配置（见 docs/harness/WEBDAV.md 与 REPORTS_WEBDAV.md）。
 *
 * 这个 Tab 里有**两张卡**，管的是两份互不影响的配置：
 * 1. 「WebDAV 连接」（本文件，按账号）：「重要文件」页远端通道的连接配置；
 * 2. 「周报上传」（`ReportUploadCard`，**仅管理员可见**，全局单行）：所有人交周报时用的统一账号与上传根目录。
 *
 * 第一张卡里配置分两半，页面严格照这个分工来画：
 * - **地址是部署级的**，来自环境变量 `WEBDAV_URL`（一个团队共用一个 NAS），这里**只读展示**；
 * - **用户名 / 密码 / 浏览根目录 / 超时按账号**，在这里填、存进 `webdav_settings`。
 *
 * 「浏览根目录」刻意做成**选**而不是**填**：目录层级由 `WebDavDirPicker` 实时拉取，
 * 用户点出来即可，不必关心远端路径怎么写。
 *
 * 其它约定：
 * - **密码不回显**：页面只拿到 `hasPassword`，留空提交 = 保持已保存的密码；
 * - 「测试连接」用表单当前值直接 ping（不落库），保存是否成功与能不能连通分开反馈。
 */
type Props = {
  settings: WebDavSettingsView;
  /** 全局的「周报上传」配置（仅管理员渲染这张卡；组织管理者的 payload 里是未配置视图） */
  reportUpload: ReportUploadSettingsView;
  /** 管理员才能看/改「周报上传」——那是全局配置，组织管理者只维护自己那份凭据 */
  isAdmin: boolean;
  post: PostPayload;
  busy: boolean;
  /** 写操作成功时递增，用来清空密码输入框（不回显密码） */
  successTick: number;
};

type FormValues = { username?: string; password?: string; root?: string; timeoutMs?: number };

/** `"/work/报价"` → `"work/报价"`：选择器里的路径一律相对服务根，不带首尾斜杠 */
function toRelative(path: string): string {
  return path.replace(/^\/+/u, "").replace(/\/+$/u, "");
}

export function WebDavTab({ settings, reportUpload, isAdmin, post, busy, successTick }: Props): React.ReactElement {
  const { modal } = AntdApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPath, setPickerPath] = useState("");
  const [pickerValues, setPickerValues] = useState<Record<string, unknown>>({});
  // 地址没配好（缺 WEBDAV_URL 或它不合法）时，保存与试连都没有意义
  const addressReady = settings.addressConfigured;

  // 保存/清除成功后把表单同步成服务端口径，并清空密码框（密码永远不回显）
  useEffect(() => {
    if (successTick > 0) form.setFieldsValue({ ...settings, password: "" });
    // 只在写操作成功时同步；settings 变化本身（例如刷新）不该打断正在输入的内容
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [successTick]);

  const test = async (): Promise<void> => {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    post({ intent: "test-webdav", ...values });
  };

  /** 打开选择器：把表单当前值带上（凭据常常还没保存），并从当前根开始浏览 */
  const openPicker = (): void => {
    const values = form.getFieldsValue();
    setPickerValues(values as Record<string, unknown>);
    setPickerPath(toRelative(String(values.root ?? "")));
    setPickerOpen(true);
  };

  return (
    <Flex vertical gap="large">
      <Card
        variant="outlined"
        title="WebDAV 连接"
        extra={
          <Tag color={settings.configured ? "green" : "default"} variant="filled">
            {settings.configured ? "已保存到本账号" : addressReady ? "未配置本账号" : "未配置地址"}
          </Tag>
        }
      >
        {settings.addressError ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            title="环境变量里的 WEBDAV_URL 不合法"
            description={`${settings.addressError}。请改仓库根 .env 里的 WEBDAV_URL，然后重启服务。`}
          />
        ) : null}
        {!addressReady && !settings.addressError ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            title="还没配置 WebDAV 地址"
            description="地址是部署级的：请在仓库根的 .env 里设置 WEBDAV_URL，保存后重启服务。"
          />
        ) : null}

        <Form
          form={form}
          layout="vertical"
          initialValues={{
            username: settings.username,
            password: "",
            root: settings.root,
            timeoutMs: settings.timeoutMs,
          }}
          onFinish={(values) => post({ intent: "save-webdav", ...values })}
        >
          <Form.Item label="WebDAV 地址" tooltip="部署级配置，来自环境变量 WEBDAV_URL；全员共用，改地址请改 .env 并重启服务">
            <Input value={settings.url} placeholder="（未配置：请在 .env 里设置 WEBDAV_URL）" readOnly />
          </Form.Item>

          <Flex gap="middle" wrap>
            <Form.Item name="username" label="用户名" style={{ flex: 1, minWidth: 220 }} tooltip="本账号在 NAS 上的用户名">
              <Input autoComplete="off" placeholder="Basic 认证用户名（匿名访问可留空）" allowClear />
            </Form.Item>
            <Form.Item
              name="password"
              label="密码"
              style={{ flex: 1, minWidth: 220 }}
              tooltip="密码只在服务端读取；留空表示保持已保存的密码"
            >
              <Input.Password
                autoComplete="new-password"
                placeholder={settings.hasPassword ? "留空则保持已保存的密码" : "Basic 认证密码"}
              />
            </Form.Item>
          </Flex>

          <Flex gap="middle" wrap>
            <Form.Item label="浏览根目录" style={{ flex: 2, minWidth: 320 }} tooltip="只暴露这个子目录；点「选择目录」直接挑">
              <Space.Compact style={{ width: "100%" }}>
                <Form.Item name="root" noStyle>
                  <Input readOnly placeholder="点右侧「选择目录」挑一个" />
                </Form.Item>
                <Button icon={<FolderOpenOutlined />} onClick={openPicker} disabled={!addressReady}>
                  选择目录
                </Button>
              </Space.Compact>
            </Form.Item>
            <Form.Item name="timeoutMs" label="请求超时（毫秒）" style={{ flex: 1, minWidth: 180 }}>
              <InputNumber min={1000} max={120000} step={1000} style={{ width: "100%" }} />
            </Form.Item>
          </Flex>

          <Flex justify="space-between" wrap gap="small">
            <Space wrap>
              <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={busy} disabled={!addressReady}>
                保存
              </Button>
              <Button icon={<ExperimentOutlined />} onClick={() => void test()} loading={busy} disabled={!addressReady}>
                测试连接
              </Button>
            </Space>
            {settings.configured ? (
              <Button
                color="danger"
                variant="outlined"
                icon={<DeleteOutlined />}
                onClick={() =>
                  confirmDanger(modal, {
                    title: "清除 WebDAV 配置？",
                    content: "清除后「重要文件」页不再显示远端入口，只保留本机路径索引。",
                    okText: "清除",
                    onOk: () => post({ intent: "clear-webdav" }),
                  })
                }
              >
                清除配置
              </Button>
            ) : null}
          </Flex>
        </Form>
      </Card>

      <Typography.Text type="secondary">
        「重要文件」页的浏览与上传都用这里保存的账号与目录；密码明文存在本机数据库，请勿把服务暴露到公网。
      </Typography.Text>

      {isAdmin ? (
        <ReportUploadCard
          settings={reportUpload}
          addressConfigured={settings.addressConfigured}
          addressError={settings.addressError}
          url={settings.url}
          post={post}
          busy={busy}
          successTick={successTick}
        />
      ) : null}

      <WebDavDirPicker
        open={pickerOpen}
        initialPath={pickerPath}
        values={pickerValues}
        onClose={() => setPickerOpen(false)}
        onPick={(picked) => {
          form.setFieldsValue({ root: picked ? `/${picked}` : "/" });
          setPickerOpen(false);
        }}
      />
    </Flex>
  );
}

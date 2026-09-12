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
 * 这个 Tab 里有**两张卡**，D-52/D-53 之后它们的分工是「一份连接 + 每个组织一个目录」：
 * 1. 「WebDAV 连接」（本文件，按账号）：本账号的连接配置，「重要文件」用它浏览 / 上传；
 * 2. 「周报上传」（`ReportUploadCard`）：**本组织的**周报上传目录，组织管理者与管理员都能改
 *    （管理员可在卡里切换组织）。周报的**连接**是管理员那一份，不在这里配。
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
  /** 「周报上传」的视图：作用域是**当前组织**（D-53） */
  reportUpload: ReportUploadSettingsView;
  /** 管理员在「周报上传」卡里可切换的组织；组织管理者为空（固定为本组织） */
  reportOrgOptions: { value: string; label: string }[];
  onSelectOrg: (orgId: string) => void;
  /** 管理员才有的说明文案——组织管理者那份连接与周报无关，不能混为一谈 */
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

export function WebDavTab({
  settings,
  reportUpload,
  reportOrgOptions,
  onSelectOrg,
  isAdmin,
  post,
  busy,
  successTick,
}: Props): React.ReactElement {
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
            {settings.configured ? "已保存" : addressReady ? "未配置" : "未配置地址"}
          </Tag>
        }
      >
        {settings.addressError ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            title="WebDAV 地址无效"
            description={`${settings.addressError}。请修改 .env 中的 WEBDAV_URL 后重启服务。`}
          />
        ) : null}
        {!addressReady && !settings.addressError ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            title="未配置 WebDAV 地址"
            description="请在 .env 中设置 WEBDAV_URL 后重启服务。"
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
          <Form.Item label="WebDAV 地址" tooltip="全员共用，修改后需重启服务">
            <Input value={settings.url} placeholder="（未配置）" readOnly />
          </Form.Item>

          <Flex gap="middle" wrap>
            <Form.Item name="username" label="用户名" style={{ flex: 1, minWidth: 220 }} tooltip="本账号的 NAS 用户名">
              <Input autoComplete="off" placeholder="可留空（匿名访问）" allowClear />
            </Form.Item>
            <Form.Item name="password" label="密码" style={{ flex: 1, minWidth: 220 }} tooltip="留空则不修改">
              <Input.Password autoComplete="new-password" placeholder={settings.hasPassword ? "留空则不修改" : "Basic 认证密码"} />
            </Form.Item>
          </Flex>

          <Flex gap="middle" wrap>
            <Form.Item label="浏览根目录" style={{ flex: 2, minWidth: 320 }} tooltip="仅可访问该目录及其子目录">
              <Space.Compact style={{ width: "100%" }}>
                <Form.Item name="root" noStyle>
                  <Input readOnly placeholder="点右侧「选择目录」挑选" />
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
                    content: "「重要文件」页将不再显示远端文件。",
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
        用于「重要文件」的浏览与上传。密码保存在本机数据库，请勿将服务暴露到公网。
        {isAdmin ? "管理员这份连接同时用于周报上传。" : ""}
      </Typography.Text>

      <ReportUploadCard
        settings={reportUpload}
        addressConfigured={settings.addressConfigured}
        addressError={settings.addressError}
        orgOptions={reportOrgOptions}
        onSelectOrg={onSelectOrg}
        post={post}
        busy={busy}
        successTick={successTick}
      />

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

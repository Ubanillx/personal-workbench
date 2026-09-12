import type React from "react";
import { useEffect, useState } from "react";
import { Alert, App as AntdApp, Button, Card, Flex, Form, Input, InputNumber, Space, Tag, Typography } from "antd";
import { DeleteOutlined, ExperimentOutlined, FolderOpenOutlined, SaveOutlined } from "@ant-design/icons";
import type { ReportUploadSettingsView } from "../../../shared/types/domain";
import { confirmDanger } from "../crud-actions";
import { WebDavDirPicker } from "./webdav-dir-picker";
import type { PostPayload } from "./types";

/**
 * 「周报上传」配置卡片（仅管理员可见，D-46，见 docs/harness/REPORTS_WEBDAV.md）。
 *
 * 和上面那份**按账号**的 WebDAV 配置刻意分开，因为两者回答的是不同问题：
 * - 按账号那份 =「我这个人怎么访问 NAS」（「重要文件」页用它浏览/上传）；
 * - 这张卡 =「**所有人的**周报正文往哪写」，全局一份、统一账号，
 *   落点固定为 `<上传根目录>/<登录用户名>/<起止日期>/<原文件名>`。
 *
 * 三条与旁边那张卡一致的约定：
 * - 地址仍是部署级的（`.env` 的 `WEBDAV_URL`），这里只读展示；
 * - 密码不回显：只拿到 `hasPassword`，留空提交 = 保持已保存的密码；
 * - 「测试连接」用表单当前值直接连（不落库），能否连通与保存是否成功分开反馈。
 *
 * 「清除配置」在这里比旁边危险得多：清掉之后**所有人**都交不了周报、也下不了新式记录，
 * 所以文案里明确写出来，并走二次确认。
 */
type Props = {
  settings: ReportUploadSettingsView;
  addressConfigured: boolean;
  addressError: string | null;
  url: string;
  post: PostPayload;
  busy: boolean;
  /** 写操作成功时递增，用来清空密码输入框（密码不回显） */
  successTick: number;
};

type FormValues = { username?: string; password?: string; root?: string; timeoutMs?: number };

/** `"/周报"` → `"周报"`：目录选择器里的路径一律相对服务根，不带首尾斜杠 */
function toRelative(path: string): string {
  return path.replace(/^\/+/u, "").replace(/\/+$/u, "");
}

export function ReportUploadCard({ settings, addressConfigured, addressError, url, post, busy, successTick }: Props): React.ReactElement {
  const { modal } = AntdApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPath, setPickerPath] = useState("");
  const [pickerValues, setPickerValues] = useState<Record<string, unknown>>({});
  const addressReady = addressConfigured && !addressError;

  // 保存/清除成功后把表单同步成服务端口径，并清空密码框
  useEffect(() => {
    if (successTick > 0) form.setFieldsValue({ ...settings, password: "" });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [successTick]);

  const test = async (): Promise<void> => {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    post({ intent: "test-report-upload", ...values });
  };

  const openPicker = (): void => {
    const values = form.getFieldsValue();
    setPickerValues(values as Record<string, unknown>);
    setPickerPath(toRelative(String(values.root ?? "")));
    setPickerOpen(true);
  };

  return (
    <Card
      variant="outlined"
      title="周报上传"
      extra={
        <Tag color={settings.configured ? "green" : "default"} variant="filled">
          {settings.configured ? "已启用" : addressReady ? "未配置" : "未配置地址"}
        </Tag>
      }
    >
      {addressError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          title="环境变量里的 WEBDAV_URL 不合法"
          description={`${addressError}。请改仓库根 .env 里的 WEBDAV_URL，然后重启服务。`}
        />
      ) : null}
      {!addressConfigured && !addressError ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title="还没配置 WebDAV 地址"
          description="地址是部署级的：请在仓库根的 .env 里设置 WEBDAV_URL，保存后重启服务。"
        />
      ) : null}
      {!settings.configured && addressReady ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title="周报上传还没配置"
          description="配好之后成员才能提交周报：正文只写 NAS，不再落在本机磁盘上。"
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
        onFinish={(values) => post({ intent: "save-report-upload", ...values })}
      >
        <Form.Item label="WebDAV 地址" tooltip="与上面同一份部署级配置（环境变量 WEBDAV_URL），这里只读">
          <Input value={url} placeholder="（未配置：请在 .env 里设置 WEBDAV_URL）" readOnly />
        </Form.Item>

        <Flex gap="middle" wrap>
          <Form.Item
            name="username"
            label="统一上传账号"
            style={{ flex: 1, minWidth: 220 }}
            tooltip="所有成员提交周报都用这个 NAS 账号；普通成员不需要自己配 WebDAV"
          >
            <Input autoComplete="off" placeholder="Basic 认证用户名（匿名写入可留空）" allowClear />
          </Form.Item>
          <Form.Item name="password" label="密码" style={{ flex: 1, minWidth: 220 }} tooltip="密码只在服务端读取；留空表示保持已保存的密码">
            <Input.Password autoComplete="new-password" placeholder={settings.hasPassword ? "留空则保持已保存的密码" : "Basic 认证密码"} />
          </Form.Item>
        </Flex>

        <Flex gap="middle" wrap>
          <Form.Item label="上传根目录" style={{ flex: 2, minWidth: 320 }} tooltip="周报正文写到这里；点「选择目录」直接挑，默认 /周报">
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
                  title: "清除周报上传配置？",
                  content: "清除后所有人都无法提交周报，新式记录的下载也会失败（NAS 上的文件不受影响）。",
                  okText: "清除",
                  onOk: () => post({ intent: "clear-report-upload" }),
                })
              }
            >
              清除配置
            </Button>
          ) : null}
        </Flex>
      </Form>

      <Typography.Text type="secondary" style={{ display: "block", marginTop: 12 }}>
        落点：<Typography.Text code>{settings.root}</Typography.Text> / 登录用户名 / 起止日期 / 原文件名；退回重传会加{" "}
        <Typography.Text code>_v2</Typography.Text> 后缀，撞名自动加 <Typography.Text code>_2</Typography.Text>，远端已有文件不会被覆盖。
        {settings.updatedAt ? `最后修改：${settings.updatedByName ?? "（已删除的账号）"} · ${settings.updatedAt}` : ""}
      </Typography.Text>

      <WebDavDirPicker
        open={pickerOpen}
        title="选择周报上传根目录"
        intent="browse-report-upload"
        initialPath={pickerPath}
        values={pickerValues}
        onClose={() => setPickerOpen(false)}
        onPick={(picked) => {
          form.setFieldsValue({ root: picked ? `/${picked}` : "/周报" });
          setPickerOpen(false);
        }}
      />
    </Card>
  );
}

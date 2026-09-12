import type React from "react";
import { useEffect, useState } from "react";
import { Alert, App as AntdApp, Button, Card, Flex, Form, Input, Select, Space, Tag, Typography } from "antd";
import { ExperimentOutlined, FolderOpenOutlined, SaveOutlined, UndoOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { ReportUploadSettingsView } from "../../../shared/types/domain";
import { confirmAction } from "../crud-actions";
import { WebDavDirPicker } from "./webdav-dir-picker";
import type { PostPayload } from "./types";

/**
 * 「周报上传」配置卡片（组织管理者 / 管理员可见，D-53，见 docs/harness/REPORTS_WEBDAV.md）。
 *
 * 这张卡只有一件事：**本组织的周报写进哪个目录**。
 * - 作用域是**一个组织**（D-53）：组织管理者改本组织那份；管理员在卡里切换组织；
 * - **连接不回显**：周报用的是管理员在正上方「WebDAV 连接」里保存的那份 NAS 账号，
 *   它已经显示在那张卡里了，这里再画一遍只会打乱信息层级（没有连接时用一条 Alert 说明）；
 * - 默认（留空）= **用连接的浏览根目录**；挑过之后落点固定为那个目录；「恢复默认」＝删掉该组织那一行。
 *
 * 落点自 D-46 起没变：`<本组织的上传根目录>/<登录用户名>/<起止日期>/<原文件名>`；
 * 退回重传加 `_v2`，撞名自动加 `_2`，远端已有文件绝不覆盖。
 */
type Props = {
  settings: ReportUploadSettingsView;
  addressConfigured: boolean;
  addressError: string | null;
  /** 可切换的组织（管理员才有；空数组 = 固定为本组织，用只读文本展示） */
  orgOptions: { value: string; label: string }[];
  onSelectOrg: (orgId: string) => void;
  post: PostPayload;
  busy: boolean;
  /** 写操作成功时递增，用来把本地目录状态同步成服务端口径 */
  successTick: number;
};

export function ReportUploadCard({
  settings,
  addressConfigured,
  addressError,
  orgOptions,
  onSelectOrg,
  post,
  busy,
  successTick,
}: Props): React.ReactElement {
  const { modal } = AntdApp.useApp();
  // 目录只在「点选择器」时改：它是个只读字段，用本地状态比拉一个 Form 实例更直接
  const [ownRoot, setOwnRoot] = useState(settings.ownRoot);
  const [pickerOpen, setPickerOpen] = useState(false);
  const addressReady = addressConfigured && !addressError;
  // 组织 + 连接都就绪才算「能用」：缺哪一个，保存目录都没有意义
  const ready = addressReady && settings.connectionReady && settings.orgId !== null;

  // 切换组织 / 保存 / 恢复默认之后，把本地值同步成服务端口径。
  // 依赖的是具体值，所以「刚挑完还没保存」的本地选择不会被覆盖。
  useEffect(() => {
    setOwnRoot(settings.ownRoot);
  }, [settings.orgId, settings.ownRoot, successTick]);

  /** 实际生效的目录：本组织单独挑过就是它，否则就是连接的浏览根目录 */
  const effectiveRoot = ownRoot.trim() || settings.root;

  return (
    <Card
      variant="outlined"
      title="周报上传"
      extra={
        <Tag color={ready ? "green" : "default"} variant="filled">
          {ready ? "已启用" : addressReady ? "未配置连接" : "未配置地址"}
        </Tag>
      }
    >
      {addressError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          title="WebDAV 地址无效"
          description={`${addressError}。请修改 .env 中的 WEBDAV_URL 后重启服务。`}
        />
      ) : null}
      {!addressConfigured && !addressError ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title="未配置 WebDAV 地址"
          description="请在 .env 中设置 WEBDAV_URL 后重启服务。"
        />
      ) : null}
      {addressReady && !settings.connectionReady ? (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} title="未配置 WebDAV 连接" description="请先在上方保存连接。" />
      ) : null}
      {addressReady && settings.orgId === null ? (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} title="没有可用组织" description="请先在「组织总览」新建组织。" />
      ) : null}

      <Form layout="vertical" onFinish={() => post({ intent: "save-report-upload", orgId: settings.orgId, root: ownRoot })}>
        <Form.Item label="组织" tooltip="按组织分别设置" style={{ maxWidth: 420 }}>
          {orgOptions.length > 0 ? (
            <Select value={settings.orgId ?? ""} options={orgOptions} onChange={onSelectOrg} placeholder="选择要配置的组织" />
          ) : (
            <Input readOnly value={settings.orgName ?? ""} placeholder="（没有可配置的组织）" />
          )}
        </Form.Item>

        <Form.Item label="上传根目录" tooltip="留空则使用连接的浏览根目录">
          <Space.Compact style={{ width: "100%" }}>
            <Input
              readOnly
              value={ownRoot}
              placeholder={settings.connectionReady ? "留空则使用连接的浏览根目录" : "点右侧「选择目录」挑选"}
            />
            <Button icon={<FolderOpenOutlined />} onClick={() => setPickerOpen(true)} disabled={!ready}>
              选择目录
            </Button>
          </Space.Compact>
        </Form.Item>

        <Flex justify="space-between" wrap gap="small">
          <Space wrap>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={busy} disabled={!ready}>
              保存
            </Button>
            <Button icon={<ExperimentOutlined />} onClick={() => post({ intent: "test-report-upload" })} loading={busy} disabled={!ready}>
              测试连接
            </Button>
            {!settings.followsConnection || ownRoot ? (
              <Button
                icon={<UndoOutlined />}
                onClick={() =>
                  confirmAction(modal, {
                    title: "恢复默认目录？",
                    content: "将改回使用连接的浏览根目录。",
                    okText: "恢复默认",
                    onOk: () => {
                      setOwnRoot("");
                      post({ intent: "reset-report-upload", orgId: settings.orgId });
                    },
                  })
                }
              >
                恢复默认
              </Button>
            ) : null}
          </Space>
        </Flex>
      </Form>

      <Typography.Text type="secondary" style={{ display: "block", marginTop: 12 }}>
        保存位置：<Typography.Text code>{effectiveRoot || "（连接的浏览根目录）"}</Typography.Text>/用户名/周期/文件名，同名文件不会被覆盖。
        {settings.updatedAt
          ? `最后修改：${settings.updatedByName ?? "（已删除的账号）"} · ${dayjs(settings.updatedAt).format("YYYY-MM-DD HH:mm")}`
          : ""}
      </Typography.Text>

      <WebDavDirPicker
        open={pickerOpen}
        title="选择周报上传根目录"
        intent="browse-report-upload"
        initialPath={toRelativePickerPath(effectiveRoot)}
        values={{}}
        onClose={() => setPickerOpen(false)}
        onPick={(picked) => {
          // 选到根目录 = 用连接的浏览根目录（空串就是「不另外指定」的表达方式）
          setOwnRoot(picked ? `/${picked}` : "");
          setPickerOpen(false);
        }}
      />
    </Card>
  );
}

/** `"/阿尔法"` → `"阿尔法"`：选择器里的路径一律相对服务根，不带首尾斜杠 */
function toRelativePickerPath(path: string): string {
  return path.replace(/^\/+/u, "").replace(/\/+$/u, "");
}

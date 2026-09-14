import type React from "react";
import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { App as AntdApp, Button, Checkbox, Drawer, Flex, Input, Select, Typography, Upload } from "antd";
import { CheckOutlined, UploadOutlined } from "@ant-design/icons";
import type { WebDavBrowseEntry } from "../../shared/types/domain";
import { RowActions } from "./crud-actions";
import { WebDavBrowserBody, useWebDavBrowse, type WebDavResponse } from "./webdav-browser";

/**
 * 「浏览 WebDAV」抽屉（D-41，见 docs/harness/WEBDAV.md）。
 *
 * 三件事：浏览远端目录、**选中即登记**进重要文件索引、把本机文件上传到当前目录。
 * 与 `WebDavFilePicker` 的分工：那个是「选完还要接着填表单」，这个是「选完/传完就完事」。
 *
 * 数据走 `/api/webdav`（服务端在 app/lib/webdav.server.ts，与页面 loader 共用同一套配置与边界）；
 * 用 `useFetcher` 是为了**不触发整页导航**——浏览目录、上传都只刷新这个弹窗自己的数据。
 * 刻意没有「删除远端文件」：不可恢复，请用 NAS 自己的界面。
 */
type UploadResult = { path: string; size: number; registered: boolean };

export function WebDavUploadPicker({
  open,
  root,
  organizations,
  defaultOrgId,
  defaultCategory,
  initialPath = "",
  onClose,
  onRegister,
  onUploaded,
}: {
  open: boolean;
  /** 可浏览根（`loader` 里 `webdav.root`） */
  root: string;
  /** 管理员要选「登记到哪个组织」（非管理员为空数组，不渲染这个下拉） */
  organizations: { id: string; name: string }[];
  defaultOrgId: string;
  defaultCategory: string;
  /** 打开时定位到的目录（默认浏览根） */
  initialPath?: string;
  onClose: () => void;
  /** 选中一个文件：按当前填的分类 / 组织 / 可见范围直接登记进索引 */
  onRegister: (entry: WebDavBrowseEntry, values: { category: string; orgId: string; visibility: "org" | "private" }) => void;
  /** 上传成功后让页面刷新列表 */
  onUploaded: () => void;
}): React.ReactElement {
  const browse = useWebDavBrowse(open, initialPath);
  const uploader = useFetcher<WebDavResponse<UploadResult>>();
  const { message } = AntdApp.useApp();
  const [category, setCategory] = useState(defaultCategory);
  const [orgId, setOrgId] = useState(defaultOrgId);
  // 可见范围（D-55）：默认「给组织看」，与新建抽屉的默认值保持一致——三处入口同一口径
  const [visibility, setVisibility] = useState<"org" | "private">("org");
  const [register, setRegister] = useState(true);

  // 上传结果：成功提示并刷新列表，失败原样显示服务端文案
  useEffect(() => {
    const result = uploader.data;
    if (!result) return;
    if (!result.ok) {
      void message.error(result.error.message);
      return;
    }
    void message.success(`已上传「${result.data.path}」${result.data.registered ? "，并登记到重要文件索引" : ""}`);
    onUploaded();
    browse.reload();
  }, [uploader.data]);

  const uploading = uploader.state !== "idle";

  const upload = (file: File): void => {
    const form = new FormData();
    form.append("dir", browse.path);
    form.append("register", register ? "1" : "0");
    form.append("category", category);
    form.append("visibility", visibility);
    if (orgId) form.append("orgId", orgId);
    form.append("file", file, file.name);
    uploader.submit(form, { method: "post", action: "/api/webdav" });
  };

  return (
    <Drawer
      open={open}
      title="浏览 WebDAV"
      placement="right"
      size={720}
      onClose={onClose}
      footer={
        <Flex justify="space-between" align="center" gap="middle" wrap>
          <Typography.Text type="secondary">
            只提供浏览、选择与上传；删除远端文件请用 NAS 自己的界面。上传同名文件会覆盖远端已有文件。
          </Typography.Text>
          <Button onClick={onClose}>关闭</Button>
        </Flex>
      }
    >
      <WebDavBrowserBody
        browse={browse}
        root={root}
        fileAction={(entry) => (
          <RowActions
            actions={[
              {
                key: "select",
                label: "选择",
                icon: <CheckOutlined />,
                tone: "primary",
                onClick: () => onRegister(entry, { category, orgId, visibility }),
              },
            ]}
          />
        )}
        toolbarExtra={
          <>
            <Upload
              showUploadList={false}
              disabled={uploading}
              beforeUpload={(file) => {
                upload(file as unknown as File);
                return false;
              }}
            >
              <Button size="small" icon={<UploadOutlined />} loading={uploading}>
                上传到当前目录
              </Button>
            </Upload>
            <Checkbox checked={register} onChange={(event) => setRegister(event.target.checked)}>
              同时登记到索引
            </Checkbox>
            <Input
              size="small"
              placeholder="分类（可选）"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              maxLength={40}
              style={{ width: 150 }}
            />
            {/* 可见范围（D-55）：与新建 / 编辑抽屉同一套说法，选中即登记时一起生效 */}
            <Select
              size="small"
              aria-label="可见范围"
              value={visibility}
              onChange={(value: "org" | "private") => setVisibility(value)}
              style={{ width: 130 }}
              options={[
                { value: "org", label: "给组织看" },
                { value: "private", label: "给自己看" },
              ]}
            />
            {organizations.length ? (
              <Select
                size="small"
                value={orgId}
                onChange={setOrgId}
                style={{ width: 160 }}
                options={organizations.map((org) => ({ value: org.id, label: org.name }))}
              />
            ) : null}
          </>
        }
      />
    </Drawer>
  );
}

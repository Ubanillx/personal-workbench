import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Alert, Breadcrumb, Button, Drawer, Empty, Flex, Space, Table, Typography, type TableProps } from "antd";
import { ArrowUpOutlined, CheckOutlined, FolderOpenOutlined, ReloadOutlined } from "@ant-design/icons";
import type { WebDavBrowseEntry, WebDavBrowseListing } from "../../../shared/types/domain";

/**
 * 「浏览根目录」的目录选择器（见 docs/harness/WEBDAV.md）。
 *
 * 存在的理由：让用户**点**出目录，而不是自己拼路径。远端目录层级由服务端实时拉取，
 * 所以路径里的分隔符、盘符、共享名这些差异都不用用户操心。
 *
 * 三个刻意的设计：
 * 1. **用表单当前值去连**，不是用已保存的配置——第一次配置时凭据还没落库，
 *    这里走设置页 action 的 `browse-webdav`（内部复用 `resolveWebDavTestConfig`）；
 * 2. **从服务根开始浏览**（服务端把 basePath 固定成 `/`）：要挑一个根，就必须能往上走；
 * 3. 只列**目录**，文件与本次操作无关。
 */
type BrowseResult = { ok: true; browse: WebDavBrowseListing } | { error: string };

type Props = {
  open: boolean;
  /** 打开时定位到的目录（通常是当前已填的浏览根） */
  initialPath: string;
  /** 表单当前值；凭据常常还没保存，只有它能用来连远端 */
  values: Record<string, unknown>;
  onClose: () => void;
  /** 选中某个目录作为浏览根 */
  onPick: (path: string) => void;
  /**
   * 提交给设置页 action 的 intent，默认 `browse-webdav`（用**表单当前值**那份按账号配置去连）。
   * 「周报上传」区块传 `browse-report-upload`——那里没有表单凭据，服务端一律用**共用连接**
   * （管理员在「WebDAV 连接」里保存的那份），两者不能混。
   */
  intent?: string;
  /** Drawer 标题，默认「选择浏览根目录」 */
  title?: string;
};

export function WebDavDirPicker({
  open,
  initialPath,
  values,
  onClose,
  onPick,
  intent = "browse-webdav",
  title = "选择浏览根目录",
}: Props): React.ReactElement {
  const browse = useFetcher<BrowseResult>();
  const [path, setPath] = useState(initialPath);
  /** 上一次的 open：只在「打开」这一瞬间定位起点 */
  const opened = useRef(false);
  // 每次渲染都刷新一次快照，避免用到过期的表单值（凭据可能刚被改过）
  const latestValues = useRef(values);
  latestValues.current = values;

  /** 真正去拉某一层目录；**只由事件触发** */
  const load = (target: string): void => {
    browse.submit({ intent, ...latestValues.current, path: target }, { method: "post", encType: "application/json" });
  };

  /**
   * 跳到某个目录：改显示状态与拉那一层永远一起发生。
   *
   * 这里刻意**不做**「监听 path 变化再加载」：那个写法必须把调用方给的 `initialPath`
   * 排除在判断之外，一旦写进去（或写成「path 与 initialPath 不一致就回到 initialPath」），
   * 用户点进子目录就会被立刻弹回起点——「进入」看着像没反应。
   * 加载全部由事件驱动，effect 只用来看「是不是刚打开」，就没有这个坑。
   */
  const go = (target: string): void => {
    setPath(target);
    load(target);
  };

  // 打开时定位到调用方给的起点；之后用户怎么点都不再干预
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open && !opened.current) go(initialPath);
    opened.current = open;
  }, [open]);

  const listing = browse.data && "browse" in browse.data ? browse.data.browse : null;
  const error = browse.data && "error" in browse.data ? browse.data.error : null;
  const loading = browse.state !== "idle";
  const directories = (listing?.entries ?? []).filter((entry) => entry.isDirectory);
  const segments = path.split("/").filter(Boolean);
  const current = path ? `/${path}` : "/";

  const breadcrumbItems: { title: React.ReactNode }[] = [
    {
      title:
        segments.length === 0 ? (
          <Typography.Text strong>根目录</Typography.Text>
        ) : (
          <Typography.Link onClick={() => go("")}>根目录</Typography.Link>
        ),
    },
    ...segments.map((segment, index) => {
      const target = segments.slice(0, index + 1).join("/");
      return {
        title:
          index === segments.length - 1 ? (
            <Typography.Text strong>{segment}</Typography.Text>
          ) : (
            <Typography.Link onClick={() => go(target)}>{segment}</Typography.Link>
          ),
      };
    }),
  ];

  const columns: TableProps<WebDavBrowseEntry>["columns"] = [
    {
      title: "目录",
      dataIndex: "name",
      key: "name",
      render: (_value, entry) => (
        <Typography.Link onClick={() => go(entry.path)}>
          <Space size={6} align="center">
            <FolderOpenOutlined />
            {entry.name}
          </Space>
        </Typography.Link>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 150,
      align: "right",
      render: (_value, entry) => (
        <Space size={4}>
          <Button size="small" type="text" onClick={() => go(entry.path)}>
            进入
          </Button>
          <Button size="small" type="text" icon={<CheckOutlined />} onClick={() => onPick(entry.path)}>
            选它
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Drawer
      open={open}
      title={title}
      placement="right"
      size={640}
      onClose={onClose}
      footer={
        <Flex justify="end" gap="small">
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            icon={<CheckOutlined />}
            onClick={() => {
              onPick(path);
            }}
          >
            选择当前目录
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap="middle">
        <Space size="small" wrap align="center">
          <Button size="small" icon={<ArrowUpOutlined />} disabled={!listing?.parent} onClick={() => go(listing?.parent ?? "")}>
            上一级
          </Button>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => load(path)}>
            刷新
          </Button>
          <Typography.Text code>{current}</Typography.Text>
        </Space>

        <Breadcrumb items={breadcrumbItems} />

        {error ? <Alert type="error" showIcon title={error} /> : null}

        <Table<WebDavBrowseEntry>
          rowKey="path"
          size="small"
          columns={columns}
          dataSource={directories}
          loading={loading}
          pagination={false}
          scroll={{ y: 360 }}
          locale={{
            emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? "读取中" : "没有子目录，可直接选择此目录"} />,
          }}
        />
      </Flex>
    </Drawer>
  );
}

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Alert, Breadcrumb, Button, Empty, Flex, Input, Space, Table, Typography, type TableProps } from "antd";
import { ArrowUpOutlined, FileOutlined, FolderOpenOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { WEBDAV_PATH_PREFIX, type WebDavBrowseEntry, type WebDavBrowseResult } from "../../shared/types/domain";
import { RowActions } from "./crud-actions";

/**
 * 「重要文件」的远端浏览器（见 docs/harness/WEBDAV.md §3）。
 *
 * 一个 hook + 一个主体组件，**两处入口共用同一份列目录逻辑**，不搞第二套：
 * 1. `WebDavFilePicker`（`webdav-file-picker.tsx`）：新建 / 编辑抽屉里「选择文件」——选中的文件填进表单，保存才落库（D-48）；
 * 2. `WebDavUploadPicker`（`webdav-upload-picker.tsx`）：页头「浏览 WebDAV」——选中即登记，外加上传到当前目录。
 *
 * 数据全部走 `/api/webdav`（服务端在 app/lib/webdav.server.ts，与页面 loader 共用同一套配置与边界）；
 * 用 `useFetcher` 而不是导航，是为了**不触发整页跳转**——浏览目录只刷新弹窗自己的数据。
 *
 * 客户端专用的显示工具（`formatBytes` / `displayPath` / `remoteParentPath`）也放在这里：
 * `app/lib/webdav.server.ts` 是服务端模块，组件不能从那里取（同样的取舍见 shared/types/domain.ts 的注释）。
 */

/** `/api/webdav` 的信封（与 app/lib/http.server.ts 的 ok / fail 一致） */
export type WebDavResponse<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

/** 远端文件大小：null（远端没给 getcontentlength）显示「大小未知」 */
export function formatBytes(size: number | null): string {
  if (size === null) return "大小未知";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index] ?? "KB"}`;
}

/** `webdav:报价/x.xlsx` → `报价/x.xlsx`（展示用；本机路径原样返回） */
export function displayPath(filePath: string): string {
  return filePath.startsWith(WEBDAV_PATH_PREFIX) ? filePath.slice(WEBDAV_PATH_PREFIX.length) : filePath;
}

/**
 * 已选远端路径所在的目录：编辑已有远端条目时，让选择器**直接定位到它所在的那一层**，
 * 免得用户每次从浏览根一路点进去。本机路径（挑不到）与空值都回到根 ""。
 */
export function remoteParentPath(filePath: string): string {
  if (!filePath.startsWith(WEBDAV_PATH_PREFIX)) return "";
  return filePath.slice(WEBDAV_PATH_PREFIX.length).split("/").filter(Boolean).slice(0, -1).join("/");
}

export type WebDavBrowseState = {
  /** 当前目录（相对可浏览根，根为 ""） */
  path: string;
  listing: WebDavBrowseResult | null;
  error: string | null;
  loading: boolean;
  go: (path: string) => void;
  reload: () => void;
};

/**
 * 浏览状态机：打开时定位到 `initialPath`，之后目录跳转**全部由事件驱动**。
 *
 * 刻意**不做**「监听 path 变化再加载」：那个写法必须把调用方给的 `initialPath` 排除在判断之外，
 * 一旦写进去（或写成「path 与 initialPath 不一致就回到 initialPath」），用户点进子目录就会被立刻弹回起点
 * ——「进入」看着像没反应（`webdav-dir-picker.tsx` 里记过同一个坑）。
 */
export function useWebDavBrowse(open: boolean, initialPath: string): WebDavBrowseState {
  const browse = useFetcher<WebDavResponse<WebDavBrowseResult>>();
  const [path, setPath] = useState("");
  /** 上一次的 open：只在「打开」这一瞬间定位起点，之后用户怎么点都不再干预 */
  const opened = useRef(false);

  const load = (target: string): void => {
    void browse.load(`/api/webdav?path=${encodeURIComponent(target)}`);
  };

  const go = (target: string): void => {
    setPath(target);
    load(target);
  };

  useEffect(() => {
    if (open && !opened.current) {
      setPath(initialPath);
      load(initialPath);
    }
    opened.current = open;
  }, [open]);

  return {
    path,
    listing: browse.data?.ok ? browse.data.data : null,
    error: browse.data && !browse.data.ok ? browse.data.error.message : null,
    loading: browse.state !== "idle",
    go,
    reload: () => load(path),
  };
}

/**
 * 浏览器主体：工具栏（上一级 / 刷新 / 本目录筛选 / 调用方的额外按钮）+ 面包屑 + 目录表格。
 *
 * 目录行固定是「进入」；文件行做什么由调用方给（选进表单 / 直接登记索引）——
 * 两种入口的差别只有这一个函数，其余（列目录、导航、筛选、空态）都是同一份。
 */
export function WebDavBrowserBody({
  browse,
  root,
  fileAction,
  toolbarExtra,
}: {
  browse: WebDavBrowseState;
  /** 可浏览根（设置页里的「浏览根目录」），面包屑的起点 */
  root: string;
  /** 文件行右侧的操作（目录行固定是「进入」） */
  fileAction: (entry: WebDavBrowseEntry) => React.ReactNode;
  /** 工具栏右侧的额外内容（「浏览 WebDAV」用它放上传与登记选项） */
  toolbarExtra?: React.ReactNode;
}): React.ReactElement {
  const [filter, setFilter] = useState("");
  // 换目录就清掉筛选：留着上一次的关键字，新目录会莫名看起来是空的
  useEffect(() => setFilter(""), [browse.path]);

  const listing = browse.listing;
  const keyword = filter.trim().toLowerCase();
  const entries = (listing?.entries ?? []).filter((entry) => !keyword || entry.name.toLowerCase().includes(keyword));
  const rootLabel = root === "" ? "/" : root;
  const segments = browse.path.split("/").filter(Boolean);

  const breadcrumbItems: { title: React.ReactNode }[] = [
    {
      title:
        segments.length === 0 ? (
          <Typography.Text strong>{rootLabel}</Typography.Text>
        ) : (
          <Typography.Link onClick={() => browse.go("")}>{rootLabel}</Typography.Link>
        ),
    },
    ...segments.map((segment, index) => {
      const target = segments.slice(0, index + 1).join("/");
      return {
        title:
          index === segments.length - 1 ? (
            <Typography.Text strong>{segment}</Typography.Text>
          ) : (
            <Typography.Link onClick={() => browse.go(target)}>{segment}</Typography.Link>
          ),
      };
    }),
  ];

  const columns: TableProps<WebDavBrowseEntry>["columns"] = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      render: (_value, entry) =>
        entry.isDirectory ? (
          <Button
            color="primary"
            variant="link"
            className="link-button"
            icon={<FolderOpenOutlined />}
            onClick={() => browse.go(entry.path)}
          >
            {entry.name}
          </Button>
        ) : (
          <Space size={4} align="center">
            <FileOutlined />
            <Typography.Text>{entry.name}</Typography.Text>
          </Space>
        ),
    },
    {
      title: "大小",
      key: "size",
      width: 110,
      render: (_value, entry) =>
        entry.isDirectory ? (
          <Typography.Text type="secondary">目录</Typography.Text>
        ) : (
          <Typography.Text>{formatBytes(entry.size)}</Typography.Text>
        ),
    },
    {
      title: "修改时间",
      key: "lastModified",
      width: 160,
      render: (_value, entry) =>
        entry.lastModified ? (
          <Typography.Text>{dayjs(entry.lastModified).format("YYYY-MM-DD HH:mm")}</Typography.Text>
        ) : (
          <Typography.Text type="secondary">未知</Typography.Text>
        ),
    },
    {
      title: "操作",
      key: "actions",
      width: 150,
      align: "right",
      render: (_value, entry) =>
        entry.isDirectory ? (
          <RowActions actions={[{ key: "open", label: "进入", icon: <FolderOpenOutlined />, onClick: () => browse.go(entry.path) }]} />
        ) : (
          fileAction(entry)
        ),
    },
  ];

  return (
    <Flex vertical gap="middle">
      <Space size="small" wrap align="center">
        <Button size="small" icon={<ArrowUpOutlined />} disabled={!listing?.parent} onClick={() => browse.go(listing?.parent ?? "")}>
          上一级
        </Button>
        <Button size="small" icon={<ReloadOutlined />} loading={browse.loading} onClick={browse.reload}>
          刷新
        </Button>
        <Input
          size="small"
          allowClear
          placeholder="在本目录内筛选"
          style={{ width: 180 }}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        {toolbarExtra}
      </Space>

      <Breadcrumb items={breadcrumbItems} />

      {browse.error ? <Alert type="error" showIcon title={browse.error} /> : null}

      <Table<WebDavBrowseEntry>
        rowKey="path"
        size="small"
        columns={columns}
        dataSource={entries}
        loading={browse.loading}
        pagination={false}
        scroll={{ y: 320 }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={browse.loading ? "读取中" : keyword ? `本目录没有名称含「${filter.trim()}」的条目` : "这个目录是空的"}
            />
          ),
        }}
      />
    </Flex>
  );
}

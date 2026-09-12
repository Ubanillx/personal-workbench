import type React from "react";
import { Button, Drawer, Flex, Tag, Typography } from "antd";
import { CheckOutlined } from "@ant-design/icons";
import type { WebDavBrowseEntry } from "../../shared/types/domain";
import { RowActions } from "./crud-actions";
import { WebDavBrowserBody, useWebDavBrowse } from "./webdav-browser";

/**
 * 「从 WebDAV 选择文件」抽屉（D-48，见 docs/harness/WEBDAV.md §2）。
 *
 * 存在的理由：把「文件名称 / 文件路径」里的**路径**从**填**变成**选**（与「浏览根目录」的 D-45 同一思路）。
 * 新建与编辑抽屉里的「选择文件」都用它——选中的文件只填进表单，**保存才落库**，
 * 所以名称、分类、所属组织还能在保存前改（这也是它与「浏览 WebDAV」刻意分开的原因：
 * 后者是选中即登记 + 上传）。
 *
 * 三件事交给共用件，这里只管「选完做什么」：
 * 1. 列目录、导航、筛选、空态 → `WebDavBrowserBody`（`webdav-browser.tsx`）；
 * 2. 打开时定位到 `initialPath`（编辑远端条目时是它所在目录）；
 * 3. `currentFilePath` 命中的那一行显示「当前」而不是「选择」，一眼看出这条索引现在指向哪个文件。
 */
export function WebDavFilePicker({
  open,
  root,
  initialPath,
  currentFilePath,
  title,
  onClose,
  onPick,
}: {
  open: boolean;
  /** 可浏览根（`loader` 里 `webdav.root`） */
  root: string;
  /** 打开时定位到的目录（相对可浏览根，根为 ""） */
  initialPath: string;
  /** 表单里当前已填的路径：命中的行显示「当前」，不传则每行都可选 */
  currentFilePath?: string;
  title?: string;
  onClose: () => void;
  onPick: (entry: WebDavBrowseEntry) => void;
}): React.ReactElement {
  const browse = useWebDavBrowse(open, initialPath);

  return (
    <Drawer
      open={open}
      title={title ?? "从 WebDAV 选择文件"}
      placement="right"
      size={720}
      onClose={onClose}
      footer={
        <Flex justify="space-between" align="center" gap="middle" wrap>
          <Typography.Text type="secondary">
            选中的文件只登记路径索引，原文件留在 NAS 上；要上传新文件请用页头的「浏览 WebDAV」。
          </Typography.Text>
          <Button onClick={onClose}>关闭</Button>
        </Flex>
      }
    >
      <WebDavBrowserBody
        browse={browse}
        root={root}
        fileAction={(entry) =>
          currentFilePath && entry.filePath === currentFilePath ? (
            <Tag color="blue" variant="filled">
              当前
            </Tag>
          ) : (
            <RowActions
              actions={[{ key: "pick", label: "选择", icon: <CheckOutlined />, tone: "primary", onClick: () => onPick(entry) }]}
            />
          )
        }
      />
    </Drawer>
  );
}

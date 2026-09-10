import type React from "react";
import { App as AntdApp, Button, Dropdown, Space, type MenuProps } from "antd";
import { EllipsisOutlined } from "@ant-design/icons";

type ModalApi = ReturnType<typeof AntdApp.useApp>["modal"];

/**
 * 表格行操作区：左侧 `extra` 放 0~2 个高频动作用文字按钮，
 * 其余低频/危险动作收进「更多」下拉，避免一行堆四五个按钮把表格撑乱。
 */
export function RowActions({
  extra,
  items,
  disabled,
}: {
  extra?: React.ReactNode;
  items?: MenuProps["items"];
  disabled?: boolean;
}): React.ReactElement {
  const hasMore = Array.isArray(items) && items.length > 0;
  return (
    <div className="row-actions" onClick={(event) => event.stopPropagation()}>
      <Space size={4}>
        {extra}
        {hasMore ? (
          <Dropdown menu={{ items }} trigger={["click"]} placement="bottomRight" {...(disabled === undefined ? {} : { disabled })}>
            <Button size="small" color="default" variant="text" icon={<EllipsisOutlined />} aria-label="更多操作" />
          </Dropdown>
        ) : null}
      </Space>
    </div>
  );
}

/**
 * 危险操作二次确认（删除 / 归档 / 解散）：统一「取消在左、危险按钮带 danger」，
 * 并强制写明影响范围（`content`），避免只有一句「确定吗？」的无效确认。
 */
export function confirmDanger(
  modal: ModalApi,
  options: { title: string; content?: React.ReactNode; okText: string; onOk: () => void },
): void {
  modal.confirm({
    title: options.title,
    okText: options.okText,
    cancelText: "取消",
    okButtonProps: { danger: true },
    ...(options.content === undefined ? {} : { content: options.content }),
    onOk: options.onOk,
  });
}

/** 普通确认（通过审批、启用/停用等）：同样统一文案与按钮顺序，但不使用危险色 */
export function confirmAction(
  modal: ModalApi,
  options: { title: string; content?: React.ReactNode; okText: string; onOk: () => void },
): void {
  modal.confirm({
    title: options.title,
    okText: options.okText,
    cancelText: "取消",
    ...(options.content === undefined ? {} : { content: options.content }),
    onOk: options.onOk,
  });
}

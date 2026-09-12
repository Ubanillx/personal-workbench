import type React from "react";
import { forwardRef } from "react";
import { App as AntdApp, Button, Space, Tooltip } from "antd";

type ModalApi = ReturnType<typeof AntdApp.useApp>["modal"];

/** 行内动作语气：默认中性文字、`primary` 强调主操作、`danger` 标出危险操作 */
export type RowActionTone = "default" | "primary" | "danger";

/**
 * 一个行内动作。按钮**只显示图标**，文字收进悬停提示（Tooltip）；
 * 需要自定义结构（Upload / Popconfirm 包裹按钮）时改用 `render`，并复用 `IconActionButton` 保持同一视觉。
 */
export type RowAction = {
  key: string;
  /** 按钮文字：不直接渲染，作为悬停 `Tooltip` 与 `aria-label` 的文案 */
  label: string;
  /** 统一必给图标，让一列操作在视觉上可快速扫读 */
  icon?: React.ReactNode;
  tone?: RowActionTone;
  disabled?: boolean;
  onClick?: () => void;
  /** 自定义节点（如 Upload / Popconfirm 包裹按钮），优先级高于 icon + label + onClick */
  render?: React.ReactNode;
};

export type IconActionButtonProps = {
  /** 动作文案：不渲染成文字，只作为悬停 Tooltip 与 `aria-label` */
  label: string;
  icon: React.ReactNode;
  tone?: RowActionTone;
  disabled?: boolean;
  onClick?: () => void;
};

/**
 * 图标动作按钮：**只显示图标**，文字放进 `Tooltip`，鼠标移上去才出现。
 *
 * 结构为 `span > Tooltip > Button`：
 * - 外层 `span` 是原生元素且转发 `ref`，可以直接当作 `Popconfirm` / `Upload` 的包裹子节点
 *   （这两个组件要求子节点能接住 ref 与注入的事件），从而避免「Tooltip 套 Popconfirm」两层浮层互相抢事件；
 * - Tooltip 直接挂在 antd Button 上，悬停一定被接住；二者互不干扰。
 */
export const IconActionButton = forwardRef<HTMLSpanElement, IconActionButtonProps>(function IconActionButton(
  { label, icon, tone = "default", disabled, onClick, ...rest },
  ref,
): React.ReactElement {
  return (
    <span ref={ref} {...rest} className="row-action-icon">
      <Tooltip title={label}>
        <Button
          size="small"
          variant="text"
          color={tone}
          aria-label={label}
          icon={icon}
          disabled={Boolean(disabled)}
          {...(onClick ? { onClick } : {})}
        />
      </Tooltip>
    </span>
  );
});

/**
 * 表格行操作区：**所有动作直接平铺展示**，不再收进「更多」下拉。
 *
 * 视觉规范统一为 `size="small"` + `variant="text"`（链接式）+ **纯图标**：
 * 文字不占位，鼠标悬停时才以 Tooltip 出现（读屏仍靠 `aria-label` 拿到文案）；
 * 通过 `tone` 区分语义：中性（灰）、强调（蓝）、危险（红）；一列按钮按顺序排列、必要时自动换行。
 */
export function RowActions({ actions, disabled }: { actions: RowAction[]; disabled?: boolean }): React.ReactElement {
  return (
    <div className="row-actions" onClick={(event) => event.stopPropagation()}>
      <Space size={4} wrap>
        {actions.map((action) => {
          if (action.render) {
            return (
              <span key={action.key} className="row-action-custom">
                {action.render}
              </span>
            );
          }
          const isDisabled = Boolean(disabled || action.disabled);
          // 有图标才收成纯图标；万一调用方漏给图标，退回文字按钮，避免留下一个点不动的空白按钮
          if (!action.icon) {
            return (
              <Tooltip key={action.key} title={action.label}>
                <span className="row-action-icon">
                  <Button
                    size="small"
                    variant="text"
                    color={action.tone ?? "default"}
                    aria-label={action.label}
                    disabled={isDisabled}
                    {...(action.onClick ? { onClick: action.onClick } : {})}
                  >
                    {action.label}
                  </Button>
                </span>
              </Tooltip>
            );
          }
          return (
            <IconActionButton
              key={action.key}
              label={action.label}
              icon={action.icon}
              tone={action.tone ?? "default"}
              disabled={isDisabled}
              {...(action.onClick ? { onClick: action.onClick } : {})}
            />
          );
        })}
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

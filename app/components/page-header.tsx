import type React from "react";
import { Flex, Space, Typography } from "antd";

/**
 * 页面标题区（Ant Design 中后台 PageHeader 规范的最小实现）。
 *
 * 规范要点（与 Ant Design 设计语言一致）：
 * - 左侧固定为「栏目标识（可选）→ 页面标题 → 一句话说明」，标题用 20px/600 的 `level={4}`；
 * - 右侧 `extra` 只放本页动作，全页**最多一个** `color="primary" variant="solid"` 主按钮；
 * - 只做结构（Flex + Typography），间距与颜色全部走 Design Token，不引入手写样式。
 */
export function PageHeader({
  title,
  eyebrow,
  description,
  extra,
}: {
  title: React.ReactNode;
  eyebrow?: string;
  description?: React.ReactNode;
  extra?: React.ReactNode;
}): React.ReactElement {
  return (
    <Flex className="page-head" align="flex-start" justify="space-between" gap="middle" wrap>
      <Flex vertical gap={4} className="page-head-copy">
        {eyebrow ? (
          <Typography.Text type="secondary" className="page-eyebrow">
            {eyebrow}
          </Typography.Text>
        ) : null}
        <Typography.Title level={4} className="page-title">
          {title}
        </Typography.Title>
        {description ? <Typography.Text type="secondary">{description}</Typography.Text> : null}
      </Flex>
      {extra ? (
        <Space size="small" wrap>
          {extra}
        </Space>
      ) : null}
    </Flex>
  );
}

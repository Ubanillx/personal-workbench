import type React from "react";
import { Flex, Space, Tooltip, Typography } from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";

/**
 * 页面标题区（Ant Design 中后台 PageHeader 规范的最小实现）。
 *
 * 规范要点（与 Ant Design 设计语言一致）：
 * - 左侧固定为「栏目标识（可选）→ 页面标题（+可选帮助提示）→ 一句话说明」，标题用 20px/600 的 `level={4}`；
 * - 右侧 `extra` 只放本页动作，全页**最多一个** `color="primary" variant="solid"` 主按钮；
 * - 标题旁的 `help` 用 `Tooltip` 承载「这页是做什么的 / 数据口径」等长说明，
 *   让一句话说明保持简短，详细口径按需展开；
 * - 只做结构（Flex + Typography），间距与颜色全部走 Design Token，不引入手写样式。
 */
export function PageHeader({
  title,
  eyebrow,
  description,
  extra,
  help,
}: {
  title: React.ReactNode;
  eyebrow?: string;
  description?: React.ReactNode;
  extra?: React.ReactNode;
  help?: React.ReactNode;
}): React.ReactElement {
  return (
    <Flex className="page-head" align="flex-start" justify="space-between" gap="middle" wrap>
      <Flex vertical gap={4} className="page-head-copy">
        {eyebrow ? (
          <Typography.Text type="secondary" className="page-eyebrow">
            {eyebrow}
          </Typography.Text>
        ) : null}
        <Space size={6} align="center">
          <Typography.Title level={4} className="page-title">
            {title}
          </Typography.Title>
          {help ? (
            <Tooltip title={help}>
              <Typography.Text type="secondary" className="page-help" aria-label="查看页面说明">
                <QuestionCircleOutlined />
              </Typography.Text>
            </Tooltip>
          ) : null}
        </Space>
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

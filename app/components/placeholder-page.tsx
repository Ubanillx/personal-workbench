import type React from "react";
import { Card, Result } from "antd";

/** Phase 3 占位页：页面迁移完成后会被真实实现替换（冒烟脚本以是否含「迁移中」判断页面是否已迁移） */
export function PlaceholderPage({ title }: { title: string }): React.ReactElement {
  return (
    <Card variant="outlined">
      <Result status="info" title={title} subTitle="该页面正在迁移中（Phase 3），功能稍后可用。" />
    </Card>
  );
}

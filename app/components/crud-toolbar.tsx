import type React from "react";
import { Alert, Button, Flex, Space } from "antd";

/**
 * 列表工具栏：左侧放筛选条件（搜索框 / 下拉 / 开关），右侧放低频动作（刷新 / 导出等）。
 * 与 Ant Design 中后台表格页的「筛选区 + 动作区」结构一致，宽度自适应并自动换行。
 */
export function TableToolbar({ children, extra }: { children?: React.ReactNode; extra?: React.ReactNode }): React.ReactElement {
  return (
    <Flex className="table-toolbar" align="center" justify="space-between" gap="small" wrap>
      <Flex align="center" gap="small" wrap>
        {children}
      </Flex>
      {extra ? (
        <Space size="small" wrap>
          {extra}
        </Space>
      ) : null}
    </Flex>
  );
}

/**
 * 批量操作提示条：选中行后出现在表格上方，左侧说明选中数量，右侧是批量动作 + 取消选择。
 * 这是中后台「先选后批」的标准交互：没有选中行时完全不占位。
 */
export function SelectionAlert({
  count,
  noun,
  children,
  onClear,
}: {
  count: number;
  noun: string;
  children?: React.ReactNode;
  onClear: () => void;
}): React.ReactElement | null {
  if (count <= 0) return null;
  return (
    <Alert
      type="info"
      showIcon
      title={`已选择 ${count} ${noun}`}
      action={
        <Space size="small" wrap>
          {children}
          <Button size="small" color="default" variant="text" onClick={onClear}>
            取消选择
          </Button>
        </Space>
      }
    />
  );
}

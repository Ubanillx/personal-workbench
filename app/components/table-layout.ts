import type React from "react";
import type { TablePaginationConfig, TableProps } from "antd";
import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from "../lib/paging";

/**
 * 表格排版基线（自动省略 + 自动排版）：**所有列表页的 `Table` 都经过 `dataTable()` 生成 props**。
 *
 * 为什么需要它：`Table` 默认 `tableLayout="auto"`，列宽由内容宽度决定。只要某一列出现一条长内容
 * （任务说明、文件路径、备注），浏览器就会把这一列撑到内容宽度，整张表被一起推挤——列头与单元格
 * 错位、超出单元格的文字被直接裁掉（没有省略号），窄屏还看不到底部滚动条。`scroll={{ x: 数字 }}`
 * 也治不了：数字是**手写的**，列一多一少就对不上，而且 auto 布局下它只是把表格整体缩放。
 *
 * 本模块给出的是一条规则，而不是每个页面各写一遍：
 *
 * 1. **自动排版**：`tableLayout="fixed"` + 由列宽算出的 `scroll.x`。定宽布局下每列只吃自己那份宽度，
 *    长内容不会再撑宽整张表；列宽之和超过可视宽度时自动出现横向滚动条（窄屏不挤坏布局）。
 * 2. **自动省略**：除「行内动作列」外，每列自动带上 `ellipsis: true`——antd 会给单元格加
 *    `overflow: hidden` + `text-overflow: ellipsis`，纯文本列由此出省略号（并把全文写进 `title`），
 *    自定义 `render` 的列（按钮 / 标签 / 进度条 / 多行结构）则被**裁在自己的列宽里**，不再顶破单元格。
 *    （实测 `rc-table` 的 `ellipsis` 只加样式、不重写 children，所以按钮和标签照常渲染。）
 * 3. **不动的列**：行内动作列（`key: "actions"` / 列头「操作」）必须 `ellipsis: false`——
 *    它们是一排图标按钮，需要能自动换行，加上省略号会被压成豆腐块。
 *
 * 列宽约定（新页面照这个量级给 `width`，自动排版才有意义）：
 * - 主内容列（标题 / 内容 / 说明）：不写 `width`，吃掉剩余空间；定宽布局会把剩余空间按比例分给它。
 * - 短文本列（状态 / 优先级 / 角色 / 人数 / 分类）：100 ~ 140。
 * - 中等列（负责人 / 组织 / 日期 / 时间 / 周期）：140 ~ 180。
 * - 宽列（进度 / 文档 / 文件情况 / 多标签）：180 ~ 240。
 * - 操作列（`RowActions` 图标按钮平铺）：每个图标按钮约 36px，按动作个数给；不给会被压成豆腐块。
 */

/** 未显式声明宽度的文本列按这个宽度参与总宽计算（不是渲染宽度，只用于估算滚动条阈值） */
const DEFAULT_COLUMN_WIDTH = 160;
/** 勾选列的实测宽度（`rc-table` 的 `SELECTION_COLUMN_WIDTH` 是 32，加两侧单元格内边距） */
const SELECTION_COLUMN_WIDTH = 64;
/** 没有任何可计算宽度时的兜底最小宽度：给表格一个横向滚动的下限，而不是让列被压到不可读 */
const FALLBACK_TABLE_WIDTH = 320;

/** 列数组类型：`columns` 在 `TableProps` 上是可选的，这里统一收成「一定是数组」 */
type Columns<T> = NonNullable<TableProps<T>["columns"]>;

/** 单个列（非分组列）的联合类型：`TableProps` 只导出 columns，这里按索引取出元素类型 */
type Column<T> = NonNullable<Columns<T>>[number];
type PlainColumn<T> = Exclude<Column<T>, { children: unknown }>;

/** 分组列的子列（非空数组）：表头分组时列宽要按子列递归统计 */
function groupChildren<T>(col: Column<T>): Columns<T> | null {
  return "children" in col && Array.isArray(col.children) && col.children.length > 0 ? col.children : null;
}

/** 分组列（带 `children` 的表头）与普通列共有的字段 */
function shared(col: Column<unknown>): { key?: React.Key; dataIndex?: unknown; width?: string | number; hidden?: boolean } {
  return col as { key?: React.Key; dataIndex?: unknown; width?: string | number; hidden?: boolean };
}

/** 取列的稳定标识：`key` 优先，其次 `dataIndex`（与 antd 生成单元格的规则一致） */
function columnKey(col: Column<unknown>): string {
  const { key, dataIndex } = shared(col);
  if (key !== undefined && key !== null) return String(key);
  if (Array.isArray(dataIndex)) return dataIndex.map(String).join(".");
  return dataIndex === undefined || dataIndex === null ? "" : String(dataIndex);
}

/** 是不是行内动作列：动作列由调用方显式收口（`ellipsis: false`），这里只作为兜底判据 */
function isPlainColumn<T>(col: Column<T>): col is PlainColumn<T> {
  return !groupChildren(col) && !/(^|\.)(actions?|操作)$/u.test(columnKey(col as Column<unknown>));
}

/**
 * 一列的声明宽度（数字）。没写 `width` 的按 `DEFAULT_COLUMN_WIDTH` 估算，只用于算总宽。
 * 返回 `null` 表示这一列不参与总宽计算（`hidden` 的列不占位）。
 */
function declaredWidth(col: Column<unknown>): number | null {
  const { width, hidden } = shared(col);
  if (hidden) return null;
  if (typeof width === "number") return width;
  // 百分比 / "auto" 这类宽度没法参与求和：主内容列不写 width，就落到这里按估算值算
  if (typeof width !== "string") return DEFAULT_COLUMN_WIDTH;
  const parsed = Number.parseFloat(width);
  return Number.isFinite(parsed) && width.trim().endsWith("px") ? parsed : DEFAULT_COLUMN_WIDTH;
}

function sumWidths<T>(columns: Columns<T>): number {
  return (columns ?? []).reduce((total, col) => {
    const children = groupChildren(col);
    if (children) return total + sumWidths(children);
    const width = declaredWidth(col as Column<unknown>);
    return width === null ? total : total + width;
  }, 0);
}

/**
 * 把「列定义」补齐成一份可直接交给 `Table` 的排版方案。
 *
 * `scrollX` 是**算出来的**：列宽之和 + 勾选列宽度。宽屏下它小于容器宽度，表格按容器铺满（`minWidth: 100%`）；
 * 窄屏下超出容器，`Table` 自动给出横向滚动条——两种情况都不需要页面自己写数字。
 */
export function resolveTableLayout<T>(columns: Columns<T> | undefined, selectable = false): { columns: Columns<T>; scrollX?: number } {
  const resolved = (columns ?? []).map((col) => {
    if (!isPlainColumn(col)) return col;
    // 已经自己声明过 ellipsis 的列（例如 `ellipsis: { showTitle: false }`）保持原样
    if (col.ellipsis !== undefined) return col;
    // 用 `Object.assign({}, col)` 而不是对象展开：列对象要复制（不能改调用方传进来的定义），
    // 但 `map` 里逐个对象展开会触发 `no-map-spread`（明确要求 copy-on-write 时用前者）
    return Object.assign({}, col, { ellipsis: true }) satisfies Column<T>;
  }) as Columns<T>;
  const total = sumWidths(resolved) + (selectable ? SELECTION_COLUMN_WIDTH : 0);
  return total > 0 ? { columns: resolved, scrollX: total } : { columns: resolved };
}

/**
 * 生成 `Table` 的排版 props：`columns`（补齐省略号）、`tableLayout`、`scroll`、`className`。
 *
 * ```tsx
 * const table = useMemo(() => dataTable<TaskRow>({ columns, selectable: canManage }), [columns, canManage]);
 * <Table<TaskRow> {...table} rowKey="id" dataSource={rows} />
 * ```
 *
 * 调用方**不要**再写 `scroll={{ x: 数字 }}`（手写数字正是当初错位的来源），
 * 也不要重复传 `className` / `tableLayout`。要纵向滚动（`scroll.y`）时合并而不是覆盖：
 * `scroll={{ ...table.scroll, y: 320 }}`。
 */
export function dataTable<T>({
  columns,
  selectable = false,
  layout = "fixed",
}: {
  columns: Columns<T> | undefined;
  /** 是否启用 `rowSelection`：勾选列会占掉一格宽度，总宽计算要带上它 */
  selectable?: boolean;
  /**
   * 列宽分配方式，默认 `fixed`（每列只吃自己那份宽度，长内容不再撑宽整张表）。
   *
   * 列**没有**声明宽度、又需要按可视化宽度自适应时用 `auto`（例：各种组织下的「组织列表」，
   * 同一张表在不同页面的容器宽度差一倍）。`auto` 下仍然会自动省略：`colgroup` 里的
   * `width` 会退化成浏览器的最小宽度提示，长文本由 `ellipsis` 裁掉。
   */
  layout?: "fixed" | "auto";
}): Pick<TableProps<T>, "columns" | "tableLayout" | "scroll" | "className"> {
  const { columns: resolved, scrollX } = resolveTableLayout(columns, selectable);
  // `exactOptionalPropertyTypes` 下不能把 `undefined` 塞进可选属性，所以两种形态分开构造
  if (scrollX === undefined) {
    return { columns: resolved, tableLayout: "auto", scroll: {}, className: "data-table" };
  }
  return {
    columns: resolved,
    tableLayout: layout,
    scroll: { x: Math.max(scrollX, FALLBACK_TABLE_WIDTH) },
    className: "data-table",
  };
}

/**
 * 分页条的**展示基线**（受控与非受控共用）：可切换条数 + 「第 x-y 条 / 共 n 条」。
 *
 * 条数选项直接取 `PAGE_SIZES`：它同时是服务端解析 `?size=` 的白名单，页面上能选的与服务端认的
 * 必须是同一个集合（见 `app/lib/paging.ts`）。这里只管**长什么样**；
 * 服务端分页的数据接线（`current` / `pageSize` / `total` / 翻页与排序回写 URL）在
 * `useServerTable`（`app/components/crud-hooks.ts`）。
 */
export const paginationBase = {
  showSizeChanger: true,
  pageSizeOptions: [...PAGE_SIZES],
  showTotal: (total: number, range: [number, number]) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 条`,
} satisfies TablePaginationConfig;

/**
 * **纯前端**表格的分页（目前只有企微导入抽屉里的校对表：数据是还没入库的草稿，服务端没有可翻的页）。
 *
 * 这里必须是 `defaultPageSize` 而不是 `pageSize`：`Table` 把 `pageSize` 当**受控值**
 * （内部 `mergeProps(innerPagination, paginationObj)`——props 覆盖内部 state，再透给 `Pagination`
 * 的 `useControlledState`）。只传 `pageSize` 而不接管 `onChange` 自己更新它，用户切换「多少条/页」
 * 时内部 setState 会被 props 覆盖回去，表现就是**点了没反应**；
 * 受控分页只在服务端分页那一侧（`useServerTable`）成立，因为那里有 `total` 与 URL 兜着。
 */
export const clientPagination = {
  ...paginationBase,
  defaultPageSize: DEFAULT_PAGE_SIZE,
  showSizeChanger: false,
} satisfies TablePaginationConfig;

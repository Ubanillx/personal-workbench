import { useEffect, useRef } from "react";
import { App as AntdApp } from "antd";
import type { TablePaginationConfig, TableProps } from "antd";
import { useSearchParams } from "react-router";
import { LIST_PARAMS, VIEW_PARAMS, type Paged } from "../lib/paging";
import { paginationBase } from "./table-layout";

/** antd 表头的排序箭头：受控（唯一真相在 URL），组件里不再存一份 */
type SortArrow = "ascend" | "descend" | null;

/** 页面 action 的统一信封：成功可带 `notice`（提示文案），失败一律是 `error` */
export type CrudEnvelope = { ok?: true; error?: string; notice?: string };

/**
 * 写操作反馈：**成功走全局提示 + 关闭表单抽屉，失败留给页面用 Alert 常驻展示**。
 *
 * 为什么失败不弹 toast：失败通常是「校验没过 / 没权限 / 跨组织」这类需要用户读完再改的
 * 信息，常驻 Alert 不会消失、还能带「重试」按钮；成功则是瞬时反馈，toast 更合适。
 * 依据 `actionData` 的对象标识去重，同一次提交只提示一次（含组件重挂载）。
 */
export function useCrudFeedback(actionData: unknown, onSuccess?: () => void): { error: string; notice: string } {
  const { message } = AntdApp.useApp();
  const handled = useRef<unknown>(null);
  const envelope = (actionData ?? null) as CrudEnvelope | null;
  const error = typeof envelope?.error === "string" ? envelope.error : "";
  const notice = typeof envelope?.notice === "string" ? envelope.notice : "";

  useEffect(() => {
    if (!envelope || handled.current === actionData) return;
    handled.current = actionData;
    if (error) return;
    void message.success(notice || "操作成功");
    onSuccess?.();
    // 只在 actionData 变化时触发：onSuccess / message 每次渲染都是新引用，纳入依赖会重复提示
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  return { error, notice };
}

/**
 * 列表筛选条件统一放在 URL 查询串里：可刷新、可分享、可回退，
 * 并且与 RR8 的 loader 天然同步（改参数即重跑 loader，页面不维护第二份筛选 state）。
 *
 * 分页/排序（`?page=` / `?size=` / `?sort=` / `?order=`）也走这里，因此**改任何筛选都会自动回到第 1 页**：
 * 筛选后命中数变少、原来那一页很可能已经越界（列表只会显示末页或空表），
 * 让每个调用点自己记得清 `page` 是不可靠的，规则写在这里只写一次。
 */
export function useListParams(): {
  params: URLSearchParams;
  get: (key: string, fallback?: string) => string;
  patch: (changes: Record<string, string | null>) => void;
  reset: () => void;
} {
  const [params, setParams] = useSearchParams();
  const patch = (changes: Record<string, string | null>): void => {
    const next = new URLSearchParams(params);
    // 只改页码（点分页条）或只改视图参数（打开详情抽屉）时保留当前页；动了别的参数就回第 1 页
    const keepsPage = Object.keys(changes).every((key) => key === LIST_PARAMS.page || (VIEW_PARAMS as readonly string[]).includes(key));
    if (!keepsPage) next.delete(LIST_PARAMS.page);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };
  return {
    params,
    get: (key, fallback = "") => params.get(key) ?? fallback,
    patch,
    reset: () => setParams(new URLSearchParams(), { replace: true }),
  };
}

/**
 * 服务端分页 + 服务端排序的表格接线：`total/page/size/sort` 全部来自 loader（`Paged<T>`），
 * 翻页、改条数、点表头都只做一件事——**写回 URL**，由 loader 重跑并决定这一页是谁。
 *
 * 为什么不用表格自己的 state：客户端分页与「服务端只给一页」是互斥的。
 * 一旦 `pagination.current` 与 `total` 由服务端给，表格就必须是**受控**的；
 * 反过来若还留着 `sorter: (a, b) => ...` 这类客户端比较器，它只会排当前这一页——
 * 所以表头排序也一并受控（列上写 `sorter: true` + `sortOrder: sortOrderOf("key")`）。
 *
 * ```tsx
 * const table = useServerTable<TaskRow>(data.tasks);
 * <Table<TaskRow> {...tableProps} pagination={table.pagination} onChange={table.onTableChange} />
 * ```
 */
export function useServerTable<T>(list: Paged<T>): {
  pagination: TablePaginationConfig;
  onTableChange: NonNullable<TableProps<T>["onChange"]>;
  /** 列上写 `sortOrder: sortOrderOf("title")`：箭头跟着**服务端实际采用**的排序走 */
  sortOrderOf: (key: string) => SortArrow;
} {
  const { patch } = useListParams();
  const onTableChange: NonNullable<TableProps<T>["onChange"]> = (next, _filters, sorter) => {
    const changes: Record<string, string | null> = {};
    const nextSize = next.pageSize ?? list.size;
    if (nextSize !== list.size) {
      changes[LIST_PARAMS.size] = String(nextSize);
      // 条数变了，原来的页码没有意义（第 3 页在每页 50 条下可能根本不存在）
      changes[LIST_PARAMS.page] = "1";
    } else {
      changes[LIST_PARAMS.page] = String(next.current ?? list.page);
    }
    const single = Array.isArray(sorter) ? sorter[0] : sorter;
    // 表头点击：箭头清空（第三次点击）等于回到服务端默认排序，所以把参数删掉而不是写个空值
    const key = single?.columnKey ?? single?.field;
    if (key !== undefined && key !== null) {
      const order = single?.order;
      changes[LIST_PARAMS.sort] = order ? String(key) : null;
      changes[LIST_PARAMS.order] = order === "descend" ? "desc" : order ? "asc" : null;
      changes[LIST_PARAMS.page] = "1";
    }
    patch(changes);
  };
  return {
    pagination: {
      ...paginationBase,
      current: list.page,
      pageSize: list.size,
      total: list.total,
    },
    onTableChange,
    sortOrderOf: (key: string): SortArrow => (list.sort.key === key ? (list.sort.direction === "desc" ? "descend" : "ascend") : null),
  };
}

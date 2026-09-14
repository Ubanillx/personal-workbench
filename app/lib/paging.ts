/**
 * 列表分页 / 排序的**参数口径**：客户端（URL 参数、分页控件、表头排序）与服务端（loader 解析）共用一份定义。
 *
 * 为什么单独一个模块：`PAGE_SIZES` 既是分页控件的 `pageSizeOptions`，也是服务端解析 `?size=` 的白名单。
 * 两边各写一份必然会漂移（页面上能选 20 条，服务端却只认 10 条），这里把口径收在一处。
 * 本模块**不 import 任何服务端模块**，所以页面组件可以直接引用；真正读写数据库的部分在 `paging.server.ts`。
 *
 * 为什么每页条数是白名单而不是「任意数字」：`?size=100000` 这种 URL 会变成一次全表拉取，分页就白做了；
 * 白名单同时保证分页控件与服务端对「合法条数」的理解完全一致。
 *
 * 分页/排序状态**只存在于 URL**（`?page=` / `?size=` / `?sort=` / `?order=`）：可刷新、可分享、可回退，
 * 并且与 RR8 的 loader 天然同步——改参数即重跑 loader，页面不维护第二份 state（与筛选器同一口径）。
 */

/** 允许的每页条数（分页控件的可选项 = 服务端接受的白名单） */
export const PAGE_SIZES = [10, 20, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
/** 默认每页条数（URL 上不写 `?size=` 时两边都用它） */
export const DEFAULT_PAGE_SIZE: PageSize = 10;

/** `?page=` / `?size=` 的解析结果；`offset` 直接喂给 SQL 的 `LIMIT ? OFFSET ?` */
export type Paging = { page: number; size: PageSize; offset: number };

/** 排序方向；与 URL 上的 `?order=` 取值一致（antd 的 `ascend`/`descend` 在接线处翻译） */
export type SortDirection = "asc" | "desc";
export type SortSpec = { key: string; direction: SortDirection };

/**
 * 列表查询的统一信封：**loader 返回它、页面直接把它交给分页控件**。
 *
 * 定义在客户端可引用的本模块（而不是 `paging.server.ts`）：页面组件要拿 `total/page/size` 渲染分页条，
 * 而 `*.server.ts` 不允许被客户端 import（RR8 的构建期约束）。
 */
export type Paged<T> = {
  /** 当页的行；服务端已按排序与筛选处理完，页面**不要再过滤/排序**（否则又变回客户端分页） */
  rows: T[];
  /** 命中总数（筛选之后、分页之前）：分页条与「共 n 条」用它 */
  total: number;
  /** 钳制后的当前页（URL 上的页码越界时它是末页） */
  page: number;
  /** 当页条数 */
  size: number;
  /** 服务端**实际采用**的排序（URL 没写或写了白名单外的 key 时就是默认排序），表头箭头据此渲染 */
  sort: SortSpec;
};

/** 中文文本的排序规则：与页面原来 `localeCompare(..., "zh-Hans-CN")` 逐字一致（拼音序） */
export const compareZh = (a: string, b: string): number => a.localeCompare(b, "zh-Hans-CN");

function toPageSize(value: string | null): PageSize {
  const numeric = Number(value);
  return (PAGE_SIZES as readonly number[]).includes(numeric) ? (numeric as PageSize) : DEFAULT_PAGE_SIZE;
}

/**
 * `?page=` / `?size=` → 分页参数。
 *
 * 非法值一律回退（页码非正整数当 1，条数不在白名单用默认），**越界不在这里判**：
 * 「第 99 页但只有 3 页」要看总数才知道，由 `paging.server.ts` 的 `pageOf()` 钳到末页
 * （列表随时会被删到不足一页，钳制是常态而不是异常）。
 */
export function pagingOf(searchParams: URLSearchParams): Paging {
  const page = Number.parseInt(searchParams.get("page") ?? "", 10);
  const size = toPageSize(searchParams.get("size"));
  const safePage = Number.isFinite(page) && page > 0 ? page : 1;
  return { page: safePage, size, offset: (safePage - 1) * size };
}

/**
 * `?sort=` / `?order=` → 排序参数。`allowed` 是**该表允许排序的列 key 白名单**：
 * URL 上的值绝不直接进 SQL（`ORDER BY` 片段只能是服务端常量），白名单外的 key 一律退回 `fallback`。
 */
export function sortOf(searchParams: URLSearchParams, allowed: readonly string[], fallback: SortSpec): SortSpec {
  const key = searchParams.get("sort") ?? "";
  const direction = searchParams.get("order");
  if (!allowed.includes(key)) return fallback;
  return { key, direction: direction === "asc" || direction === "desc" ? direction : fallback.direction };
}

/** URL 上「分页 + 排序」四个参数的统一名字（客户端写入与服务端读取共用，避免两边写错字） */
export const LIST_PARAMS = { page: "page", size: "size", sort: "sort", order: "order" } as const;

/**
 * URL 上**不影响「这一页是谁」**的视图参数：目前只有任务详情抽屉的 `?task=`。
 *
 * 为什么要单独列出来：`useListParams().patch` 的规则是「动了筛选就回第 1 页」，
 * 而打开/关闭详情抽屉只是换个视图（`/tasks` 的第 3 页还是第 3 页），
 * 若把它也当成筛选，用户点开一条任务就会被弹回第 1 页。
 */
export const VIEW_PARAMS = ["task"] as const;

/**
 * 空的一页：loader 在「没有可查的数据源」时用它（例如设置页切换到了不存在的组织、
 * 或当前账号看不到账号总览）。分页控件拿到 `total: 0` 自己会隐藏，
 * 页面不必再为「有没有列表」写一套分支。
 */
export function emptyPage<T>(paging: Paging, sort: SortSpec): Paged<T> {
  return { rows: [], total: 0, page: 1, size: paging.size, sort };
}

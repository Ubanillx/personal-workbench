import { one, rows, type Db } from "./db.server";
import { compareZh, type Paged, type Paging, type SortSpec } from "./paging";

/**
 * 服务端分页的**唯一入口**：先 `COUNT(*)` 拿总数，再 `LIMIT/OFFSET` 取当页，只把一页的行发给浏览器。
 *
 * 为什么要有这个模块：8 个列表页各自的 SQL（可见性条件、筛选条件、JOIN）都不一样，
 * 但「怎么翻页、越界怎么办、总数从哪来、排序键怎么算」必须是**一套**——
 * 各页自己拼 `LIMIT` 的后果是每页的边界行为都不一样（有的返回空表、有的钳到末页）。
 *
 * 两条不变式：
 * 1. **越界钳到末页**，永不返回空表。列表随时会被删到不足一页（筛选后从第 3 页变 1 页），
 *    URL 里那个 `?page=3` 就成了一条「合法但越界」的请求；「空表 + 分页条说共 2 页」是明确的错状态。
 * 2. **排序片段只能是服务端常量**。URL 上的 `?sort=` 只是**列 key**，经 `paging.ts` 的
 *    `sortOf()` 白名单校验后映射成本模块的 `by` / `column`，绝不把用户输入拼进 SQL。
 */

/** 列表查询的「数据源」三件套：列清单、FROM/JOIN、WHERE —— 各页只提供这三样，翻页逻辑共用 */
export type ListSource = {
  database: Db;
  /**
   * **完整**的选择语句，含 FROM/JOIN 与别名（例如 `SELECT t.id, ... FROM tasks t LEFT JOIN ...`）。
   * 取值查询直接用它 + `where`；`COUNT(*)` 不能用它，见 `source`。
   */
  select: string;
  /**
   * **只含 FROM/JOIN**（不带列清单），`COUNT(*)` 用它。
   * 两个原因：`select` 里可能有自己的占位符（重要文件的 `owned`），COUNT 用不上它、更不能替它占位；
   * 而且 `${select} ${source}` 会拼出两个 FROM（`near "FROM": syntax error`）——
   * 取值查询只用 `select`，绝不能再加上它。
   */
  source: string;
  /** `WHERE ...` 或空串 */
  where: string;
  /** `where` 里的参数，顺序与占位符一致 */
  params: unknown[];
};

/**
 * 排序方式。两条路都对，按列的类型选：
 *
 * - `kind: "sql"`：日期 / 数字 / 状态这类列，SQLite 的排序与页面原来的比较器**完全一致**
 *   （`NULL` 当最小值，与原来 `String(x ?? "")` 的写法同序），交给数据库排，`LIMIT/OFFSET` 直接生效。
 * - `kind: "key"`：中文文本列。**SQLite 没有 ICU / 自定义 collation**（本机 `node:sqlite` 不暴露
 *   `create_collation`），拼音序在 SQL 里表达不出来；这里改为把「id + 排序键」扫一遍在服务端
 *   用同一个 `localeCompare(..., "zh-Hans-CN")` 排，再按 id 取当页的行——
 *   **排序在服务端完成，浏览器仍然只拿到一页**，行为与改动前逐字一致。
 */
export type OrderSpec =
  | { kind: "sql"; by: string }
  | {
      kind: "key";
      /** 参与比较的列（服务端常量，例如 `t.title`） */
      column: string;
      /**
       * 主键列（**必须带表别名**，例如 `t.id`）。
       *
       * key 模式要先扫一遍「id + 排序键」，再按 id 取当页的行；`MEMBER_SOURCE` / `TASK_SOURCE`
       * 这类带 JOIN 的来源里 `id` 是歧义列名（`users.id` 与 `organizations.id` 同时存在），
       * 不带别名会直接报 "ambiguous column name"。
       */
      id: string;
      /** 与页面原来的比较器一致（中文列用 `compareZh`） */
      compare: (a: string, b: string) => number;
      /**
       * 排序键相同时的稳定次序（SQL 片段，通常就是该表的默认排序）。
       *
       * 必须有：`?page=2` 时若并列行的次序不确定，同一条记录可能在两页里各出现一次、
       * 也可能一次都不出现——注意 JS 的 `sort` 是稳定的，这里给什么次序，并列行就按什么次序排。
       */
      tieBreak: string;
    };

/**
 * 关键词 → `LIKE` 的匹配串。
 *
 * 为什么必须转义：用户输入的 `%` / `_` 在 LIKE 里是通配符，直接拼进去会让「搜索 100%」命中所有行。
 * 原来的实现是浏览器里的 `includes()`（纯字面匹配），这里保持同样的语义——
 * 调用方记得在 SQL 里写 `LIKE ? ESCAPE '\'`，转义才生效。
 */
export function likeTerm(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/gu, (char) => `\\${char}`)}%`;
}

/**
 * 该表**允许排序的列**：列 key → 怎么排。key 与页面列的 `key` 一一对应，
 * 两张表（`sortOf` 的白名单、`orderOf` 的翻译）都从这一份声明里出来，不会漂移。
 *
 * - `by`：SQL 片段，`{dir}` 会被替换成 `ASC`/`DESC`（**只能是服务端常量**，不含任何用户输入）；
 * - `column`：中文文本列，走 key 模式（SQLite 没有 collation API，见 `OrderSpec` 的说明）。
 */
export type SortableColumns = Record<string, { by?: string; column?: string }>;

/** 允许排序的列 key 列表（喂给 `sortOf()` 的白名单） */
export function sortableKeys(sortable: SortableColumns): string[] {
  return Object.keys(sortable);
}

/**
 * 「列 key + 方向」→ `pageOf()` 要的排序描述。
 *
 * 两条硬规则：
 * 1. `{dir}` 直接决定升降序，**不拼接任何 URL 内容**（key 已由 `sortOf()` 白名单校验过）；
 * 2. 末尾一律补 `tieBreak`（该表的稳定次序）：并列行次序不定时，翻页会出现「同一条记录在两页各出现一次」
 *    或「一条都没出现」——稳定的次序是分页正确性的一部分，不是锦上添花。
 */
export function orderOf(options: { sortable: SortableColumns; sort: SortSpec; tieBreak: string; id: string }): OrderSpec {
  const column = options.sortable[options.sort.key];
  const desc = options.sort.direction === "desc";
  const dir = desc ? "DESC" : "ASC";
  if (!column || (!column.by && !column.column)) return { kind: "sql", by: options.tieBreak };
  if (column.by) return { kind: "sql", by: `${column.by.replace("{dir}", dir)}, ${options.tieBreak}` };
  return {
    kind: "key",
    column: String(column.column),
    id: options.id,
    // 反向比较用「交换入参」而不是取负：比较器可能返回 ±1 之外的值，交换入参才是严格的反序
    compare: desc ? (a: string, b: string) => compareZh(b, a) : compareZh,
    tieBreak: options.tieBreak,
  };
}

/**
 * 取列表的一页。
 *
 * `selectParams` 是**只出现在 `select` 里**的占位符（目前只有重要文件的 `owned`）。
 * COUNT 查询不带列清单，所以它的参数必须是 `[...params]` 而不是 `[...selectParams, ...params]`。
 */
export function pageOf<T>(
  options: ListSource & {
    selectParams?: unknown[];
    /** 本次实际采用的排序：跟着结果一起回给页面，表头箭头据此渲染（页面不再维护第二份排序状态） */
    sort: SortSpec;
    order: OrderSpec;
    paging: Paging;
    map: (row: Record<string, unknown>) => T;
  },
): Paged<T> {
  const { database, select, source, where, params, selectParams = [], sort, order, paging, map } = options;
  const total = Number(one<{ n: number }>(database, `SELECT COUNT(*) AS n ${source} ${where}`, ...params)?.n ?? 0);
  // 越界钳到末页：`total=0` 时末页是第 1 页（空表也显示「共 0 条」，而不是「第 0 页」）
  const page = Math.min(Math.max(1, paging.page), Math.max(1, Math.ceil(total / paging.size)));
  const offset = (page - 1) * paging.size;
  const slice = { total, page, size: paging.size, sort };

  if (order.kind === "sql") {
    // `select` 自带 FROM/JOIN，这里只补 WHERE；`source` 只给 COUNT 用（见 ListSource 的说明）
    const pageRows = rows(
      database,
      `${select} ${where} ORDER BY ${order.by} LIMIT ? OFFSET ?`,
      ...selectParams,
      ...params,
      paging.size,
      offset,
    );
    return { ...slice, rows: pageRows.map(map) };
  }

  const keyed = rows<{ id: unknown; k: unknown }>(
    database,
    `SELECT ${order.id} AS id, ${order.column} AS k ${source} ${where} ORDER BY ${order.tieBreak}`,
    ...params,
  );
  keyed.sort((a, b) => order.compare(String(a.k ?? ""), String(b.k ?? "")));
  const pageIds = keyed.slice(offset, offset + paging.size).map((item) => String(item.id));
  if (pageIds.length === 0) return { ...slice, rows: [] };

  // 按 id 取回当页的行：`where` 可能为空，所以 "AND ... IN" 与 "WHERE ... IN" 分开拼
  const marks = pageIds.map(() => "?").join(",");
  const scoped = where ? `${where} AND ${order.id} IN (${marks})` : `WHERE ${order.id} IN (${marks})`;
  const found = rows<Record<string, unknown>>(database, `${select} ${scoped}`, ...selectParams, ...params, ...pageIds);
  // 取回的次序由 `IN (...)` 决定，必须按服务端算好的次序重排（当页内部的顺序也是用户看得见的行为）
  const position = new Map(pageIds.map((id, index) => [id, index]));
  found.sort((a, b) => (position.get(String(a.id)) ?? 0) - (position.get(String(b.id)) ?? 0));
  return { ...slice, rows: found.map(map) };
}

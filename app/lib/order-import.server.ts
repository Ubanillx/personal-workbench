import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import dayjs from "dayjs";
import { db, now, one, rows, run, type User } from "./db.server";
import {
  DEFAULT_ORDER_STEP_RULES,
  orderStepDeadline,
  ruleAnchorLabel,
  ruleLeadLabel,
  type OrderDates,
  type OrderRuleAnchor,
  type OrderRuleDayType,
  type OrderStepRule,
} from "./order-rules";

/* ------------------------------------------------------------------ 解析 */

export type ParsedOrder = {
  contract: string;
  customerDue: string | null;
  factoryDue: string | null;
  factoryName: string;
  /** 节点名 → deadline（无法计算时为 null） */
  deadlines: Record<string, string | null>;
  issues: string[];
};

export type ParsedWorkbook = {
  sheetName: string;
  headers: string[];
  rows: ParsedOrder[];
  errors: string[];
};

const ORDER_HEADER_ALIASES: Record<"contract" | "customerDue" | "factoryDue" | "factoryName", string[]> = {
  contract: ["合同号", "合同编号", "订单号", "订单编号", "contract", "contractno"],
  customerDue: ["客户交期", "客人交期", "客户交货期", "客交期", "客户交货日期"],
  factoryDue: ["工厂交期", "工厂货期", "工厂交货期", "厂交期", "工厂交货日期"],
  factoryName: ["工厂名", "工厂名称", "工厂", "供应商", "factory", "factoryname"],
};

const RULE_HEADER_ALIASES: Record<"name" | "anchor" | "leadDays" | "dayType", string[]> = {
  name: ["节点", "节点名称", "步骤", "步骤名称", "名称", "rule", "step"],
  anchor: ["基准", "基准交期", "基准日期", "anchor"],
  leadDays: ["提前天数", "提前", "天数", "leaddays", "days"],
  dayType: ["计算方式", "日类型", "日期类型", "daytype", "type"],
};

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .replace(/[\s:：()（）[\]【】/\\_\-.·]/gu, "")
    .toLowerCase();
}

function cellText(cell: ExcelJS.Cell | undefined): string {
  if (!cell) return "";
  return String(cell.text ?? cell.value ?? "").trim();
}

function pad2(value: string): string {
  return value.padStart(2, "0");
}

function toDateString(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return dayjs(value).format("YYYY-MM-DD");
  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel 序列日期（1900 基准）
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000);
    return `${date.getUTCFullYear()}-${pad2(String(date.getUTCMonth() + 1))}-${pad2(String(date.getUTCDate()))}`;
  }
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return toDateString(value.text as ExcelJS.CellValue);
    if ("result" in value) return toDateString(value.result as ExcelJS.CellValue);
    if ("richText" in value) return toDateString(value.richText.map((item) => item.text).join(""));
  }
  const text = String(value).trim();
  if (!text) return null;
  const ymd = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/u);
  if (ymd) {
    const formatted = `${ymd[1]}-${pad2(ymd[2]!)}-${pad2(ymd[3]!)}`;
    return dayjs(formatted).isValid() && dayjs(formatted).format("YYYY-MM-DD") === formatted ? formatted : null;
  }
  const mdy = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/u);
  if (mdy) {
    const formatted = `${mdy[3]}-${pad2(mdy[1]!)}-${pad2(mdy[2]!)}`;
    return dayjs(formatted).isValid() && dayjs(formatted).format("YYYY-MM-DD") === formatted ? formatted : null;
  }
  return null;
}

function findHeader(
  sheet: ExcelJS.Worksheet,
  aliases: Record<string, string[]>,
  required: string[],
): { rowNumber: number; columns: Map<string, number> } | null {
  const max = Math.min(sheet.rowCount, 20);
  for (let rowNumber = 1; rowNumber <= max; rowNumber += 1) {
    const columns = new Map<string, number>();
    sheet.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const text = normalizeHeader(cell.text ?? cell.value);
      if (!text) return;
      for (const [key, list] of Object.entries(aliases)) {
        if (columns.has(key)) continue;
        if (list.some((alias) => text === alias) || list.some((alias) => alias.length >= 3 && text.includes(alias))) {
          columns.set(key, columnNumber);
        }
      }
    });
    if (required.every((key) => columns.has(key))) return { rowNumber, columns };
  }
  return null;
}

/** 手动映射：表头所在行 + 各字段所在列（1 基） */
export type OrderColumnMapping = {
  sheetName?: string;
  headerRow: number;
  columns: { contract: number; customerDue?: number; factoryDue?: number; factoryName?: number };
};

export type WorkbookSheetPreview = { name: string; rows: string[][] };

function parseSheet(
  sheet: ExcelJS.Worksheet,
  header: { rowNumber: number; columns: Map<string, number> },
  rules: readonly OrderStepRule[],
): ParsedWorkbook {
  const rowsResult: ParsedOrder[] = [];
  const errors: string[] = [];
  const firstSeen = new Map<string, number>();
  for (let rowNumber = header.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const container = (key: keyof typeof ORDER_HEADER_ALIASES): ExcelJS.Cell | undefined => {
      const column = header.columns.get(key);
      return column ? row.getCell(column) : undefined;
    };
    const contract = cellText(container("contract"));
    if (!contract) continue;
    const customerDue = toDateString(container("customerDue")?.value ?? null);
    const factoryDue = toDateString(container("factoryDue")?.value ?? null);
    const factoryName = cellText(container("factoryName"));
    const issues: string[] = [];
    if (!customerDue) issues.push("缺少客户交期");
    if (!factoryDue) issues.push("缺少工厂交期");
    const seenKey = `${contract}\u0000${factoryName}`;
    if (firstSeen.has(seenKey)) {
      const label = factoryName ? "合同号+工厂重复" : "合同号重复";
      issues.push(`${label}（首次在第 ${firstSeen.get(seenKey)} 行），后一行会覆盖前一行`);
    } else {
      firstSeen.set(seenKey, rowNumber);
    }
    const dates: OrderDates = { customerDue, factoryDue };
    const deadlines: Record<string, string | null> = {};
    for (const rule of rules) {
      const deadline = orderStepDeadline(rule, dates);
      deadlines[rule.name] = deadline;
      if (!deadline) issues.push(`${rule.name}缺少基准日期，无法计算`);
    }
    if (customerDue && factoryDue && customerDue > factoryDue) issues.push("客户交期晚于工厂交期，请人工核对");
    rowsResult.push({ contract, customerDue, factoryDue, factoryName, deadlines, issues });
  }
  return { sheetName: sheet.name, headers: Array.from(header.columns.keys()), rows: rowsResult, errors };
}

/** 解析亿星导出的订单 Excel；mapping 存在时按用户指定的表头行与列解析 */
export async function parseOrderWorkbook(
  buffer: Buffer,
  rules: readonly OrderStepRule[],
  mapping?: OrderColumnMapping,
): Promise<ParsedWorkbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  if (mapping) {
    const sheet = (mapping.sheetName ? workbook.getWorksheet(mapping.sheetName) : undefined) ?? workbook.worksheets[0];
    if (!sheet) return { sheetName: "", headers: [], rows: [], errors: ["没有找到指定的工作表"] };
    const columns = new Map<string, number>();
    columns.set("contract", mapping.columns.contract);
    if (mapping.columns.customerDue) columns.set("customerDue", mapping.columns.customerDue);
    if (mapping.columns.factoryDue) columns.set("factoryDue", mapping.columns.factoryDue);
    if (mapping.columns.factoryName) columns.set("factoryName", mapping.columns.factoryName);
    if (!columns.has("customerDue") && !columns.has("factoryDue")) {
      return { sheetName: sheet.name, headers: [], rows: [], errors: ["请至少映射客户交期或工厂交期"] };
    }
    return parseSheet(sheet, { rowNumber: mapping.headerRow, columns }, rules);
  }
  for (const sheet of workbook.worksheets) {
    const header = findHeader(sheet, ORDER_HEADER_ALIASES, ["contract"]);
    if (!header || (!header.columns.has("factoryDue") && !header.columns.has("customerDue"))) continue;
    return parseSheet(sheet, header, rules);
  }
  return {
    sheetName: "",
    headers: [],
    rows: [],
    errors: ["没有找到包含「合同号 / 客户交期 / 工厂交期」表头的工作表"],
  };
}

/** 读取各工作表前 20 行 × 30 列，表头识别失败时给用户手动映射 */
export async function inspectOrderWorkbook(buffer: Buffer): Promise<{ sheets: WorkbookSheetPreview[] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheets = workbook.worksheets.map((sheet) => {
    const preview: string[][] = [];
    const maxRow = Math.min(sheet.rowCount, 20);
    for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const cells: string[] = [];
      const maxColumn = Math.min(Math.max(sheet.columnCount, 1), 30);
      for (let column = 1; column <= maxColumn; column += 1) cells.push(cellText(row.getCell(column)));
      preview.push(cells);
    }
    return { name: sheet.name, rows: preview };
  });
  return { sheets };
}

/* ------------------------------------------------------------------ 规则 */

export type ParsedRules = { rules: OrderStepRule[]; errors: string[] };

function parseAnchor(value: string): OrderRuleAnchor {
  if (/较早|两者|最小|earlier/iu.test(value)) return "earliest";
  if (/客户|客人|customer/iu.test(value)) return "customer";
  return "factory";
}

/** 解析节点规则 Excel：节点名称 / 基准交期（客户、工厂、较早者） / 提前天数 */
export async function parseRulesWorkbook(buffer: Buffer): Promise<ParsedRules> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const errors: string[] = [];
  for (const sheet of workbook.worksheets) {
    const header = findHeader(sheet, RULE_HEADER_ALIASES, ["name", "leadDays"]);
    if (!header) continue;
    const rules: OrderStepRule[] = [];
    const seen = new Set<string>();
    for (let rowNumber = header.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const cell = (key: keyof typeof RULE_HEADER_ALIASES): ExcelJS.Cell | undefined => {
        const column = header.columns.get(key);
        return column ? row.getCell(column) : undefined;
      };
      const name = cellText(cell("name"));
      if (!name) continue;
      if (seen.has(name)) {
        errors.push(`第 ${rowNumber} 行节点「${name}」重复，已保留第一次出现的规则`);
        continue;
      }
      const leadText = cellText(cell("leadDays"));
      const leadDays = Number(leadText);
      if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > 365) {
        errors.push(`第 ${rowNumber} 行「${name}」的提前天数无效：${leadText || "空"}`);
        continue;
      }
      const anchor = parseAnchor(cellText(cell("anchor")));
      const dayType: OrderRuleDayType = /工作日|workday/iu.test(cellText(cell("dayType"))) ? "workday" : "calendar";
      seen.add(name);
      rules.push({ name, anchor, leadDays, dayType });
    }
    if (rules.length) return { rules, errors };
    errors.push("规则文件里没有有效的节点行");
    return { rules: [], errors };
  }
  return { rules: [], errors: ["没有找到包含「节点 / 提前天数」表头的规则工作表"] };
}

/** 用导入的规则**整体替换**本人规则；未导入时继续使用默认的两条 */
export function saveOrderRules(user: User, rules: readonly OrderStepRule[]): void {
  const database = db();
  const stamp = now();
  database.exec("SAVEPOINT order_rules");
  try {
    run(database, "DELETE FROM order_step_rules WHERE user_id=?", user.id);
    for (const rule of rules) {
      run(
        database,
        "INSERT INTO order_step_rules(id,user_id,name,anchor,lead_days,day_type,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        randomUUID(),
        user.id,
        rule.name,
        rule.anchor,
        rule.leadDays,
        rule.dayType,
        stamp,
        stamp,
      );
    }
    database.exec("RELEASE order_rules");
  } catch (error) {
    database.exec("ROLLBACK TO order_rules; RELEASE order_rules");
    throw error;
  }
}

/* ------------------------------------------------------------------ 导入 */

export type OrderImportResult = { created: number; updated: number; skipped: number; dimensions: string[] };
type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string; status: number };
const done = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = (code: string, message: string, status: number): Result<never> => ({ ok: false, code, message, status });

/**
 * 按「合同号 + 工厂 + 节点」生成任务：同一合同号下的多个工厂分别建任务；
 * 重复导入只更新标题/说明/截止日，不重复建；已归档的任务不动；
 * 任务归属导入人，自动加入本人的节点维度（维度名 = 规则名）。
 */
export function importOrders(
  user: User,
  orders: ParsedOrder[],
  orgIdInput: string,
  rules: readonly OrderStepRule[],
): Result<OrderImportResult> {
  const database = db();
  const effective = rules.length ? [...rules] : [...DEFAULT_ORDER_STEP_RULES];
  const orgId = user.role === "admin" ? orgIdInput.trim() : (user.orgId ?? "");
  if (!orgId) {
    return fail("FORBIDDEN", user.role === "admin" ? "请选择订单所属组织" : "你还没有加入组织，无法导入订单", 403);
  }
  if (!one(database, "SELECT id FROM organizations WHERE id=? AND status='active'", orgId)) {
    return fail("VALIDATION_ERROR", "组织不存在或已解散，不能导入订单", 400);
  }

  const stamp = now();
  const dimensions = new Map<string, string>();
  for (const rule of effective) {
    const existing = one<{ id: string; ruleKey: string | null }>(
      database,
      "SELECT id, rule_key AS ruleKey FROM task_dimensions WHERE user_id=? AND name=?",
      user.id,
      rule.name,
    );
    let id = existing?.id;
    if (!id) {
      id = randomUUID();
      run(
        database,
        "INSERT INTO task_dimensions(id,user_id,name,rule_key,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        id,
        user.id,
        rule.name,
        rule.name,
        stamp,
        stamp,
      );
    } else if (existing && existing.ruleKey !== rule.name) {
      run(database, "UPDATE task_dimensions SET rule_key=?,updated_at=? WHERE id=? AND user_id=?", rule.name, stamp, id, user.id);
    }
    dimensions.set(rule.name, id);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  database.exec("SAVEPOINT order_import");
  try {
    for (const order of orders) {
      for (const rule of effective) {
        const deadline = order.deadlines[rule.name];
        if (!deadline) {
          skipped += 1;
          continue;
        }
        const orderKey = `${order.contract}|${rule.name}`;
        const factory = order.factoryName.trim();
        const title = `【${factory ? `${order.contract} ${factory}` : order.contract}】${rule.name}`.slice(0, 240);
        const description = [
          `客户交期：${order.customerDue ?? "—"}`,
          `工厂交期：${order.factoryDue ?? "—"}`,
          `工厂：${factory || "—"}`,
          `${rule.name}要求：${ruleAnchorLabel(rule)}前 ${ruleLeadLabel(rule)}完成（截止 ${deadline}）`,
        ].join("\n");
        const sameKey = rows<{ id: string; archivedAt: string | null; orderFactory: string | null }>(
          database,
          "SELECT id,archived_at AS archivedAt,order_factory AS orderFactory FROM tasks WHERE created_by=? AND order_key=?",
          user.id,
          orderKey,
        );
        const existing =
          sameKey.find((candidate) => (candidate.orderFactory ?? "") === factory) ??
          (factory ? sameKey.find((candidate) => candidate.orderFactory === null) : undefined);
        let taskId = existing?.id;
        if (existing) {
          if (existing.archivedAt) {
            skipped += 1;
          } else {
            run(
              database,
              "UPDATE tasks SET title=?,description=?,due_date=?,order_factory=?,updated_at=? WHERE id=?",
              title,
              description,
              deadline,
              factory || null,
              stamp,
              taskId,
            );
            updated += 1;
          }
        } else {
          taskId = randomUUID();
          run(
            database,
            "INSERT INTO tasks(id,org_id,title,description,priority,status,progress,due_date,owner_id,created_by,source,is_private,order_key,order_factory,created_at,updated_at,completed_at,archived_at,wecom_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            taskId,
            orgId,
            title,
            description,
            "P1",
            "todo",
            0,
            deadline,
            user.id,
            user.id,
            "api",
            0,
            orderKey,
            factory || null,
            stamp,
            stamp,
            null,
            null,
            null,
          );
          created += 1;
        }
        run(
          database,
          "INSERT OR IGNORE INTO task_dimension_links(user_id,task_id,dimension_id) VALUES(?,?,?)",
          user.id,
          taskId,
          dimensions.get(rule.name)!,
        );
      }
    }
    database.exec("RELEASE order_import");
  } catch (error) {
    database.exec("ROLLBACK TO order_import; RELEASE order_import");
    throw error;
  }
  return done({ created, updated, skipped, dimensions: effective.map((rule) => rule.name) });
}

import { appConfig } from "../lib/context.server";
import { fail, ok } from "../lib/http.server";
import { importOrders, inspectOrderWorkbook, parseOrderWorkbook, parseRulesWorkbook, saveOrderRules } from "../lib/order-import.server";
import type { OrderColumnMapping } from "../lib/order-import.server";
import type { OrderStepRule } from "../lib/order-rules";
import { listOrderRules } from "../lib/order-rules.server";
import { requireAuth } from "../lib/session.server";

const MAX_BYTES = 10 * 1024 * 1024;

async function readWorkbook(form: FormData | null, key: string): Promise<{ file: File; buffer: Buffer } | null> {
  const file = form?.get(key);
  if (!(file instanceof File)) return null;
  if (!/\.xlsx$/iu.test(file.name)) throw new Error(`${key === "file" ? "订单" : "规则"}文件仅支持 .xlsx`);
  if (file.size > MAX_BYTES) throw new Error("文件不能超过 10MB");
  return { file, buffer: Buffer.from(await file.arrayBuffer()) };
}

/**
 * POST /api/order-import —— 亿星订单导入（multipart：file + 可选 rulesFile + confirm + orgId）。
 * 不带 confirm=1 时只解析并返回预览（含节点 deadline 与问题），确认后才写库。
 * rulesFile 存在时用它整体替换本人的节点规则；否则沿用本人已有规则（没有则用默认唛头/验货）。
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  if (request.method !== "POST") return fail("METHOD_NOT_ALLOWED", "不支持该请求方法", 405);

  const form = await request.formData().catch(() => null);
  if (!form) return fail("VALIDATION_ERROR", "请上传订单文件", 400);

  let orderUpload;
  let rulesUpload;
  try {
    orderUpload = await readWorkbook(form, "file");
    rulesUpload = await readWorkbook(form, "rulesFile");
  } catch (error) {
    return fail("VALIDATION_ERROR", error instanceof Error ? error.message : "文件不合法", 400);
  }
  if (!orderUpload) return fail("VALIDATION_ERROR", "请上传 .xlsx 订单文件", 400);

  let rules: OrderStepRule[] = listOrderRules(auth.user);
  let rulesErrors: string[] = [];
  if (rulesUpload) {
    let parsedRules;
    try {
      parsedRules = await parseRulesWorkbook(rulesUpload.buffer);
    } catch {
      return fail("VALIDATION_ERROR", "规则文件解析失败，请确认是有效的 Excel", 400);
    }
    if (!parsedRules.rules.length) {
      return fail("VALIDATION_ERROR", parsedRules.errors[0] ?? "规则文件没有有效行", 400);
    }
    rules = parsedRules.rules;
    rulesErrors = parsedRules.errors;
  }

  const mappingRaw = form.get("mapping");
  let mapping: OrderColumnMapping | undefined;
  if (typeof mappingRaw === "string" && mappingRaw.trim()) {
    try {
      const parsedMapping = JSON.parse(mappingRaw) as OrderColumnMapping;
      if (
        !parsedMapping ||
        !Number.isInteger(parsedMapping.headerRow) ||
        parsedMapping.headerRow < 1 ||
        !parsedMapping.columns ||
        !Number.isInteger(parsedMapping.columns.contract) ||
        parsedMapping.columns.contract < 1
      ) {
        return fail("VALIDATION_ERROR", "列映射格式不正确", 400);
      }
      mapping = parsedMapping;
    } catch {
      return fail("VALIDATION_ERROR", "列映射格式不正确", 400);
    }
  }

  let parsed;
  try {
    parsed = await parseOrderWorkbook(orderUpload.buffer, rules, mapping);
  } catch {
    return fail("VALIDATION_ERROR", "订单文件解析失败，请确认是有效的 Excel", 400);
  }

  if (String(form.get("confirm") ?? "") !== "1") {
    // 自动识别表头失败：返回工作表前几行，让用户手动映射列
    if (!mapping && parsed.sheetName === "" && !parsed.rows.length) {
      let inspected;
      try {
        inspected = await inspectOrderWorkbook(orderUpload.buffer);
      } catch {
        return fail("VALIDATION_ERROR", "订单文件解析失败，请确认是有效的 Excel", 400);
      }
      return ok({ needsMapping: true, sheets: inspected.sheets, rules, errors: [...parsed.errors, ...rulesErrors] });
    }
    if (!parsed.rows.length) return fail("VALIDATION_ERROR", parsed.errors[0] ?? "没有解析到订单行", 400);
    return ok({ sheet: parsed.sheetName, rows: parsed.rows, errors: [...parsed.errors, ...rulesErrors], rules });
  }

  if (!parsed.rows.length) return fail("VALIDATION_ERROR", parsed.errors[0] ?? "没有解析到订单行", 400);
  if (rulesUpload) saveOrderRules(auth.user, rules);
  const result = importOrders(auth.user, parsed.rows, String(form.get("orgId") ?? ""), rules);
  return result.ok ? ok(result.data) : fail(result.code, result.message, result.status);
}

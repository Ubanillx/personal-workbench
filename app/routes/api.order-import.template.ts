import ExcelJS from "exceljs";
import { appConfig } from "../lib/context.server";
import { requireAuth } from "../lib/session.server";

/**
 * GET /api/order-import/template?kind=orders|rules —— 下载导入模板。
 * 模板只包含表头与两行示例；列名与解析器里的别名保持一致。
 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") === "rules" ? "rules" : "orders";
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(kind === "rules" ? "规则" : "订单");

  if (kind === "rules") {
    sheet.addRow(["节点名称", "基准交期", "提前天数", "计算方式"]);
    sheet.addRow(["唛头", "工厂交期", 30, "自然日"]);
    sheet.addRow(["验货", "较早者", 7, "自然日"]);
    sheet.addRow(["订舱", "客户交期", 14, "自然日"]);
  } else {
    sheet.addRow(["合同号", "客户交期", "工厂交期", "工厂名"]);
    sheet.addRow(["JJA-001", "2026-12-20", "2026-12-10", "宁波华艺"]);
    sheet.addRow(["JJA-002", "2027-01-10", "2026-12-30", "嘉兴箱包"]);
    sheet.getColumn(2).numFmt = "yyyy-mm-dd";
    sheet.getColumn(3).numFmt = "yyyy-mm-dd";
  }
  sheet.getRow(1).font = { bold: true };

  const filename = kind === "rules" ? "order-rules-template.xlsx" : "order-import-template.xlsx";
  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

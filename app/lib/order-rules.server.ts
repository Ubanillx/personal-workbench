import { db, rows, type User } from "./db.server";
import { DEFAULT_ORDER_STEP_RULES, type OrderRuleAnchor, type OrderRuleDayType, type OrderStepRule } from "./order-rules";

/** 读取本人节点规则；没有自定义规则时返回默认「唛头 / 验货」。只查库，不引入 Excel 解析依赖。 */
export function listOrderRules(user: User): OrderStepRule[] {
  const found = rows<{ name: string; anchor: string; leadDays: number; dayType: string }>(
    db(),
    "SELECT name, anchor, lead_days AS leadDays, day_type AS dayType FROM order_step_rules WHERE user_id=? ORDER BY created_at, id",
    user.id,
  );
  if (!found.length) return [...DEFAULT_ORDER_STEP_RULES];
  return found.map((row) => ({
    name: row.name,
    anchor: row.anchor as OrderRuleAnchor,
    leadDays: Number(row.leadDays),
    dayType: (row.dayType === "workday" ? "workday" : "calendar") as OrderRuleDayType,
  }));
}

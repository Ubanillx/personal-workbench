import dayjs from "dayjs";

/** 节点规则的倒推基准 */
export type OrderRuleAnchor = "customer" | "factory" | "earliest";

/** 提前量的计算方式：自然日 / 工作日（跳过周六周日） */
export type OrderRuleDayType = "calendar" | "workday";

export type OrderStepRule = {
  /** 节点名，同时作为任务维度名（唛头 / 验货 / 订舱……） */
  name: string;
  /** 倒推基准：客户交期、工厂交期，或两者较早 */
  anchor: OrderRuleAnchor;
  /** 提前量（天数 / 工作日数） */
  leadDays: number;
  /** 提前量按自然日还是工作日算 */
  dayType: OrderRuleDayType;
};

/** 没有导入自定义规则时使用的默认两条（第一张截图里被框住的两段） */
export const DEFAULT_ORDER_STEP_RULES: readonly OrderStepRule[] = [
  { name: "唛头", anchor: "factory", leadDays: 30, dayType: "calendar" },
  { name: "验货", anchor: "earliest", leadDays: 7, dayType: "calendar" },
];

export const ANCHOR_LABELS: Record<OrderRuleAnchor, string> = {
  customer: "客户交期",
  factory: "工厂交期",
  earliest: "客户/工厂交期较早者",
};

export type OrderDates = { customerDue: string | null; factoryDue: string | null };

function subtractWorkdays(anchor: string, days: number): string {
  let date = dayjs(anchor);
  let remaining = days;
  while (remaining > 0) {
    date = date.subtract(1, "day");
    const weekday = date.day();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return date.format("YYYY-MM-DD");
}

/** 计算节点 deadline；没有可用的基准日期时返回 null（该节点不生成任务） */
export function orderStepDeadline(rule: OrderStepRule, dates: OrderDates): string | null {
  const candidates: string[] = [];
  if (rule.anchor === "factory") {
    if (!dates.factoryDue) return null;
    candidates.push(dates.factoryDue);
  } else if (rule.anchor === "customer") {
    if (!dates.customerDue) return null;
    candidates.push(dates.customerDue);
  } else {
    if (dates.customerDue) candidates.push(dates.customerDue);
    if (dates.factoryDue) candidates.push(dates.factoryDue);
    if (!candidates.length) return null;
  }
  const anchor = candidates.toSorted()[0];
  if (!anchor) return null;
  if (rule.dayType === "workday") return subtractWorkdays(anchor, rule.leadDays);
  return dayjs(anchor).subtract(rule.leadDays, "day").format("YYYY-MM-DD");
}

export function ruleAnchorLabel(rule: OrderStepRule): string {
  return ANCHOR_LABELS[rule.anchor];
}

/** 示例：30 天 / 5 个工作日 */
export function ruleLeadLabel(rule: OrderStepRule): string {
  return rule.dayType === "workday" ? `${rule.leadDays} 个工作日` : `${rule.leadDays} 天`;
}

export type OrderTaskDates = { customerDue: string | null; factoryDue: string | null };

/** 从订单任务的说明里取回客户/工厂交期（说明由导入时写入；被手动改掉时返回 null） */
export function orderDatesFromDescription(description: string): OrderTaskDates {
  return {
    customerDue: description.match(/客户交期：(\d{4}-\d{2}-\d{2})/u)?.[1] ?? null,
    factoryDue: description.match(/工厂交期：(\d{4}-\d{2}-\d{2})/u)?.[1] ?? null,
  };
}

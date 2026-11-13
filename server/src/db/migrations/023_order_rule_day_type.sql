-- 节点规则支持按工作日倒推（默认自然日，保持旧规则不变）。
ALTER TABLE order_step_rules ADD COLUMN day_type TEXT NOT NULL DEFAULT 'calendar' CHECK (day_type IN ('calendar', 'workday'));

-- 订单节点自动任务（亿星订单导入）：
-- order_key 由「合同号|节点」组成，按导入人唯一，重复导入走更新而不是新建；
-- rule_key 标记自动创建的维度（唛头/验货），看板据此只显示未来 7 天的订单任务。
ALTER TABLE tasks ADD COLUMN order_key TEXT;

CREATE UNIQUE INDEX idx_tasks_order_key ON tasks(created_by, order_key) WHERE order_key IS NOT NULL;

ALTER TABLE task_dimensions ADD COLUMN rule_key TEXT;

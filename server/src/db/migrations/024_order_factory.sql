-- 同一合同号可能对应多个工厂，唛头与验货需要按「合同号 + 工厂」分别生成：
-- 去重键从 (created_by, order_key) 扩展为 (created_by, order_key, order_factory)；
-- 旧任务的 order_factory 为 NULL，重新导入同工厂数据时会补写该列而不是重复建任务。
ALTER TABLE tasks ADD COLUMN order_factory TEXT;

DROP INDEX IF EXISTS idx_tasks_order_key;

CREATE UNIQUE INDEX idx_tasks_order_key ON tasks(created_by, order_key, COALESCE(order_factory, '')) WHERE order_key IS NOT NULL;

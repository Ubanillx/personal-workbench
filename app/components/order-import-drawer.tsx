import type React from "react";
import { useState } from "react";
import { Alert, App as AntdApp, Button, Drawer, Flex, Select, Space, Table, Tag, Typography, Upload } from "antd";
import { FileExcelOutlined, InboxOutlined } from "@ant-design/icons";
import { ANCHOR_LABELS, type OrderStepRule } from "../lib/order-rules";

type Rule = OrderStepRule;

type PreviewRow = {
  contract: string;
  customerDue: string | null;
  factoryDue: string | null;
  factoryName: string;
  customerName?: string;
  poNumber?: string;
  deadlines: Record<string, string | null>;
  issues: string[];
};

type Preview = { sheet: string; rows: PreviewRow[]; errors: string[]; rules: Rule[] };
type NeedsMapping = { needsMapping: true; sheets: Array<{ name: string; rows: string[][] }>; errors: string[]; rules: Rule[] };

type MappingField = "contract" | "customerDue" | "factoryDue" | "factoryName";
type MappingSelection = {
  sheetName: string;
  headerRow: number;
  columns: Partial<Record<MappingField, number | undefined>>;
};

type OrgOption = { id: string; name: string };

/**
 * 订单导入抽屉：上传亿星订单 .xlsx（可选再上传节点规则），
 * 服务端解析预览（每个节点一列 deadline）→ 确认生成任务。
 * 表头无法自动识别时，展示前几行让用户手动映射列。
 */
export function OrderImportDrawer({
  open,
  onClose,
  isAdmin,
  organizations,
  rules,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  isAdmin: boolean;
  organizations: OrgOption[];
  rules: OrderStepRule[];
  onImported: () => void;
}): React.ReactElement {
  const { message } = AntdApp.useApp();
  const [file, setFile] = useState<File | null>(null);
  const [rulesFile, setRulesFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mappingPrompt, setMappingPrompt] = useState<NeedsMapping | null>(null);
  const [mapping, setMapping] = useState<MappingSelection | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [orgId, setOrgId] = useState(organizations[0]?.id ?? "");

  const reset = (): void => {
    setFile(null);
    setRulesFile(null);
    setPreview(null);
    setMappingPrompt(null);
    setMapping(null);
    setError("");
    setLoading(false);
    setOrgId(organizations[0]?.id ?? "");
  };
  const close = (): void => {
    reset();
    onClose();
  };

  const post = async (
    orders: File,
    rulesUpload: File | null,
    confirm: boolean,
    mappingArg?: MappingSelection | null,
  ): Promise<{ ok?: boolean; data?: unknown; error?: { message?: string } } | null> => {
    const form = new FormData();
    form.append("file", orders);
    if (rulesUpload) form.append("rulesFile", rulesUpload);
    if (mappingArg) form.append("mapping", JSON.stringify(mappingArg));
    if (confirm) {
      form.append("confirm", "1");
      form.append("orgId", orgId);
    }
    const response = await fetch("/api/order-import", { method: "POST", body: form });
    return (await response.json().catch(() => null)) as { ok?: boolean; data?: unknown; error?: { message?: string } } | null;
  };

  const previewWith = async (orders: File, rulesUpload: File | null, mappingArg?: MappingSelection | null): Promise<void> => {
    setError("");
    setLoading(true);
    try {
      const payload = await post(orders, rulesUpload, false, mappingArg);
      if (!payload?.ok || !payload.data) {
        setError(payload?.error?.message ?? "解析失败，请稍后重试");
        return;
      }
      const data = payload.data as Preview | NeedsMapping;
      if ("needsMapping" in data && data.needsMapping) {
        setPreview(null);
        setMappingPrompt(data);
        const first = data.sheets[0];
        setMapping(first ? { sheetName: first.name, headerRow: 1, columns: {} } : null);
        return;
      }
      setPreview(data as Preview);
      if (mappingArg) setMapping(mappingArg);
      else {
        setMapping(null);
        setMappingPrompt(null);
      }
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  const chooseOrders = (selected: File): void => {
    setFile(selected);
    setMappingPrompt(null);
    setMapping(null);
    void previewWith(selected, rulesFile, null);
  };
  const chooseRules = (selected: File): void => {
    setRulesFile(selected);
    if (file) void previewWith(file, selected, mapping);
  };

  const confirmImport = async (): Promise<void> => {
    if (!file || !preview) return;
    if (isAdmin && !orgId) {
      setError("请选择订单所属组织");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const payload = await post(file, rulesFile, true, mapping);
      if (!payload?.ok) {
        setError(payload?.error?.message ?? "导入失败，请稍后重试");
        return;
      }
      const result = payload.data as { created: number; updated: number; skipped: number; dimensions: string[] };
      void message.success(`已生成 ${result.created} 条、更新 ${result.updated} 条订单任务`);
      onImported();
      close();
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  const mappingSheet = mappingPrompt?.sheets.find((sheet) => sheet.name === mapping?.sheetName) ?? mappingPrompt?.sheets[0];
  const headerCells = mappingSheet?.rows[(mapping?.headerRow ?? 1) - 1] ?? [];
  const columnOptions = headerCells.map((text, index) => ({
    value: index + 1,
    label: `${index + 1}. ${text || "（空）"}`,
  }));
  const canPreviewMapping = Boolean(mapping?.columns.contract && (mapping.columns.customerDue || mapping.columns.factoryDue));
  const setColumn = (key: MappingField, value: number | undefined): void => {
    setMapping((previous) => (previous ? { ...previous, columns: { ...previous.columns, [key]: value } } : previous));
  };

  const activeRules = preview?.rules?.length ? preview.rules : rules;
  const ruleSummary = activeRules
    .map((rule) => `${rule.name}（${ANCHOR_LABELS[rule.anchor]}前 ${rule.leadDays} ${rule.dayType === "workday" ? "个工作日" : "天"}）`)
    .join("、");

  // 「跟单跟进表」带客户名/PO 号时多显示两列；通用文件不显示空列
  const hasCustomer = (preview?.rows ?? []).some((row) => row.customerName);
  const hasPo = (preview?.rows ?? []).some((row) => row.poNumber);
  const baseColumns = [
    { title: "合同号", dataIndex: "contract", key: "contract", width: 120, ellipsis: true },
    ...(hasCustomer ? [{ title: "客户", dataIndex: "customerName", key: "customerName", width: 110, ellipsis: true }] : []),
    ...(hasPo ? [{ title: "PO号", dataIndex: "poNumber", key: "poNumber", width: 110, ellipsis: true }] : []),
    { title: "客户交期", dataIndex: "customerDue", key: "customerDue", width: 95, render: (value: string | null) => value ?? "—" },
    { title: "工厂交期", dataIndex: "factoryDue", key: "factoryDue", width: 95, render: (value: string | null) => value ?? "—" },
    { title: "工厂名", dataIndex: "factoryName", key: "factoryName", width: 110, ellipsis: true, render: (value: string) => value || "—" },
  ];
  const ruleColumns = (preview?.rules ?? []).map((rule) => ({
    title: `${rule.name}截止`,
    key: `deadline-${rule.name}`,
    width: 95,
    render: (_value: unknown, row: PreviewRow) => row.deadlines[rule.name] ?? "—",
  }));
  const issueColumn = {
    title: "提示",
    key: "issues",
    width: 200,
    render: (_value: unknown, row: PreviewRow) =>
      row.issues.length ? <Typography.Text type="warning">{row.issues.join("；")}</Typography.Text> : <Tag color="green">可导入</Tag>,
  };

  return (
    <Drawer
      open={open}
      onClose={close}
      size={960}
      title="导入订单"
      footer={
        <Flex justify="flex-end" gap="small">
          <Button onClick={close} disabled={loading}>
            取消
          </Button>
          <Button color="primary" variant="solid" onClick={confirmImport} loading={loading} disabled={!preview}>
            确认导入
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap="middle">
        <Typography.Text type="secondary">
          上传亿星导出的订单 Excel（.xlsx）。支持「跟单跟进表」：一个客户一个工作表，表头含
          客户合同号、工厂、工厂合同交货期、客户合同ETD；也兼容单表的 合同号 / 客户交期 / 工厂交期 / 工厂名。
          同一合同号由多个工厂生产时，请按「一行一个工厂」导出，会分别生成各自的唛头 / 验货任务。
          节点规则可在第二个文件里覆盖默认值；不传则沿用本人已保存的规则，没有则用默认「唛头 / 验货」。
        </Typography.Text>
        <Typography.Text type="secondary">当前规则：{ruleSummary || "—"}</Typography.Text>

        {isAdmin ? (
          <Space align="center">
            <Typography.Text>订单所属组织</Typography.Text>
            <Select
              style={{ width: 220 }}
              value={orgId}
              onChange={setOrgId}
              options={organizations.map((item) => ({ value: item.id, label: item.name }))}
              placeholder="请选择组织"
            />
          </Space>
        ) : null}

        {error ? <Alert type="error" showIcon title={error} /> : null}

        <Upload.Dragger
          accept=".xlsx"
          maxCount={1}
          showUploadList={false}
          disabled={loading}
          beforeUpload={(selected) => {
            chooseOrders(selected as File);
            return false;
          }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">点击或拖拽订单 .xlsx 到这里</p>
          <p className="ant-upload-hint">{file ? `已选择：${file.name}` : "解析后先预览，确认后才写入任务"}</p>
        </Upload.Dragger>

        <Upload
          accept=".xlsx"
          maxCount={1}
          showUploadList={false}
          disabled={loading}
          beforeUpload={(selected) => {
            chooseRules(selected as File);
            return false;
          }}
        >
          <Button icon={<FileExcelOutlined />} disabled={loading}>
            {rulesFile ? `规则文件：${rulesFile.name}` : "可选：选择节点规则文件"}
          </Button>
        </Upload>
        <Typography.Text type="secondary" style={{ marginTop: -8 }}>
          规则文件列：节点名称、基准交期（客户交期 / 工厂交期 / 较早者）、提前天数、计算方式（自然日 / 工作日，可省略）。
        </Typography.Text>
        <Flex gap="middle" style={{ marginTop: -8 }}>
          <Typography.Link href="/api/order-import/template?kind=orders">下载订单模板</Typography.Link>
          <Typography.Link href="/api/order-import/template?kind=rules">下载规则模板</Typography.Link>
        </Flex>

        {mappingPrompt && !preview ? (
          <Flex vertical gap="small">
            <Alert
              type="warning"
              showIcon
              title="没有自动识别到表头，请手动指定表头行与列"
              description="选择表头所在行，再把四个字段对应到列；至少指定合同号和客户/工厂交期之一。"
            />
            <Space wrap>
              <Typography.Text>工作表</Typography.Text>
              <Select
                style={{ width: 180 }}
                value={mapping?.sheetName ?? mappingPrompt.sheets[0]?.name ?? ""}
                onChange={(sheetName: string) =>
                  setMapping((previous) => (previous ? { ...previous, sheetName, headerRow: 1, columns: {} } : previous))
                }
                options={mappingPrompt.sheets.map((sheet) => ({ value: sheet.name, label: sheet.name }))}
              />
              <Typography.Text>表头所在行</Typography.Text>
              <Select
                style={{ width: 120 }}
                value={mapping?.headerRow ?? 1}
                onChange={(headerRow: number) => setMapping((previous) => (previous ? { ...previous, headerRow } : previous))}
                options={(mappingSheet?.rows ?? []).map((_row, index) => ({ value: index + 1, label: `第 ${index + 1} 行` }))}
              />
            </Space>
            <Space wrap>
              {(
                [
                  ["contract", "合同号"],
                  ["customerDue", "客户交期"],
                  ["factoryDue", "工厂交期"],
                  ["factoryName", "工厂名"],
                ] as Array<[MappingField, string]>
              ).map(([key, label]) => (
                <Space key={key} size={4}>
                  <Typography.Text>{label}</Typography.Text>
                  <Select
                    style={{ width: 150 }}
                    allowClear
                    placeholder="选择列"
                    options={columnOptions}
                    {...(mapping?.columns[key] !== undefined ? { value: mapping.columns[key] } : {})}
                    onChange={(value) => setColumn(key, typeof value === "number" ? value : undefined)}
                  />
                </Space>
              ))}
            </Space>
            <Flex gap="small">
              <Button
                color="primary"
                variant="solid"
                disabled={!canPreviewMapping || !file}
                loading={loading}
                onClick={() => {
                  if (file && mapping) void previewWith(file, rulesFile, mapping);
                }}
              >
                按此映射预览
              </Button>
              <Typography.Text type="secondary">映射只用于本次导入，不会保存。</Typography.Text>
            </Flex>
          </Flex>
        ) : null}

        {preview ? (
          <>
            {mapping ? (
              <Flex gap="small" align="center">
                <Typography.Text type="secondary">
                  已手动映射：{mapping.sheetName} 第 {mapping.headerRow} 行
                </Typography.Text>
                <Typography.Link onClick={() => setPreview(null)}>重新映射</Typography.Link>
              </Flex>
            ) : null}
            <Typography.Text>
              工作表「{preview.sheet}」共 {preview.rows.length} 个订单
            </Typography.Text>
            {preview.errors.length ? <Alert type="warning" showIcon title={preview.errors.join("；")} /> : null}
            <Table<PreviewRow>
              rowKey={(row, index) => `${row.contract}-${index ?? 0}`}
              size="small"
              columns={[...baseColumns, ...ruleColumns, issueColumn]}
              dataSource={preview.rows}
              pagination={false}
              scroll={{ x: 900, y: 360 }}
            />
          </>
        ) : null}
      </Flex>
    </Drawer>
  );
}

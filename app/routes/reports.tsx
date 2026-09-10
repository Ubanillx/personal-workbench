import type React from "react";
import { useMemo, useState } from "react";
import { useLoaderData, useNavigation, useRevalidator } from "react-router";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Empty,
  Flex,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
  type TableProps,
  type UploadFile,
} from "antd";
import { DownloadOutlined, ReloadOutlined, UploadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { UserRole } from "../../shared/types/domain";
import { confirmAction, RowActions } from "../components/crud-actions";
import { useListParams } from "../components/crud-hooks";
import { FormModal } from "../components/crud-modal";
import { TableToolbar } from "../components/crud-toolbar";
import { PageHeader } from "../components/page-header";
import { listReportOwnersFor, listReportsFor } from "../lib/reports.server";
import { requireUserOrRedirect } from "../lib/ui.server";

type ReportDocTypeLike = "weekly_report" | "summary" | "other";
type ReportStatusLike = "submitted" | "approved" | "returned";
type ReportFileLike = { id: string; version: number; originalName: string };
type ReportLike = {
  id: string;
  ownerId: string;
  ownerName: string | null;
  periodStart: string;
  periodEnd: string;
  docType: ReportDocTypeLike;
  note: string;
  status: ReportStatusLike;
  reviewNote: string | null;
  files: ReportFileLike[];
};
type MeLike = { id: string; name: string; role: UserRole; orgId: string | null; orgName: string | null };
type OwnerLike = { id: string; name: string; orgName: string | null };
type UploadValues = {
  ownerId?: string;
  period?: [dayjs.Dayjs, dayjs.Dayjs];
  docType?: ReportDocTypeLike;
  note?: string;
  file?: UploadFile[];
};

const DOC_TYPE_LABEL: Record<ReportDocTypeLike, string> = { weekly_report: "周报", summary: "总结", other: "其他" };
const STATUS_LABEL: Record<ReportStatusLike, string> = { submitted: "待审核", approved: "已通过", returned: "已退回" };
const STATUS_COLOR: Record<ReportStatusLike, string> = { submitted: "processing", approved: "green", returned: "red" };
const ACCEPTED_DOCS = ".xlsx,.xls,.docx,.doc";

const DOC_TYPE_OPTIONS = [
  { value: "all", label: "全部类型" },
  { value: "weekly_report", label: "周报" },
  { value: "summary", label: "总结" },
  { value: "other", label: "其他" },
];
const STATUS_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "submitted", label: "待审核" },
  { value: "approved", label: "已通过" },
  { value: "returned", label: "已退回" },
];
const UPLOAD_DOC_TYPE_OPTIONS = [
  { value: "weekly_report", label: "周报" },
  { value: "summary", label: "总结" },
  { value: "other", label: "其他" },
];

/**
 * 周报页 loader：列表逻辑与 GET /api/reports 共用 app/lib/reports.server.ts 的实现，
 * 页面不通过 HTTP 调自己的 API。列表已按组织范围过滤：管理员看全部组织，
 * 组织管理者看本组织，普通用户只看自己提交的。
 * 未登录 / 待改密 / 未入组三类账号由 requireUserOrRedirect 统一挡在前面（ui.server.ts 的三道门）。
 */
export async function loader({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  return {
    user: user as MeLike,
    reports: listReportsFor(user) as unknown as ReportLike[],
    owners: listReportOwnersFor(user),
  };
}

/** 管理员跨组织指派归属人时补上组织名，避免同名成员分不清 */
function ownerLabel(me: MeLike, owner: OwnerLike): string {
  return me.role === "admin" && owner.orgName ? `${owner.name}（${owner.orgName}）` : owner.name;
}

/** 从 API 信封里取数据；失败时抛出与旧 apiClient 同文案的错误 */
async function unwrap(response: Response): Promise<ReportLike> {
  const payload = (await response.json().catch(() => null)) as
    { ok: true; data: ReportLike } | { ok: false; error: { message: string } } | null;
  if (!response.ok || !payload || !payload.ok) {
    throw new Error(payload && !payload.ok ? payload.error.message : "请求失败");
  }
  return payload.data;
}

async function postJson(path: string, body?: unknown): Promise<ReportLike> {
  return unwrap(
    await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body ?? {}),
    }),
  );
}

async function postForm(path: string, form: FormData): Promise<ReportLike> {
  return unwrap(await fetch(path, { method: "POST", credentials: "include", body: form }));
}

export default function ReportsRoute(): React.ReactElement {
  const { message, modal } = AntdApp.useApp();
  const { user, reports, owners } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const list = useListParams();
  const [uploadForm] = Form.useForm<UploadValues>();
  const [returnForm] = Form.useForm<{ note?: string }>();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [returnTarget, setReturnTarget] = useState<ReportLike | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [rowBusy, setRowBusy] = useState("");
  const busy = navigation.state !== "idle" || revalidator.state !== "idle" || uploading;
  // 管理员与组织管理者可以指派/筛选归属人，普通用户只能提交自己的
  const canPickOwner = user.role !== "member";

  const type = list.get("type", "all");
  const status = list.get("status", "all");
  const owner = list.get("owner", "all");
  const rows = useMemo(
    () =>
      reports.filter(
        (report) =>
          (type === "all" || report.docType === type) &&
          (status === "all" || report.status === status) &&
          (owner === "all" || report.ownerId === owner),
      ),
    [reports, type, status, owner],
  );
  const ownerOptions = useMemo(
    () => [{ value: "all", label: "全部成员" }, ...owners.map((item) => ({ value: item.id, label: ownerLabel(user, item) }))],
    [owners, user],
  );
  const filtered = type !== "all" || status !== "all" || owner !== "all";
  const refresh = (): void => {
    void revalidator.revalidate();
  };

  /** 行内动作统一走这里：忙碌标记 + 统一的错误提示 + 成功后刷新列表 */
  const run = (id: string, fn: () => Promise<ReportLike>, notice: string): void => {
    setError("");
    setRowBusy(id);
    void fn()
      .then(() => {
        void message.success(notice);
        refresh();
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "操作失败"))
      .finally(() => setRowBusy(""));
  };

  const submitUpload = (values: UploadValues): void => {
    const file = values.file?.[0]?.originFileObj;
    const range = values.period;
    if (!file || !range?.[0] || !range[1]) return;
    setError("");
    setUploading(true);
    const body = new FormData();
    body.append("periodStart", range[0].format("YYYY-MM-DD"));
    body.append("periodEnd", range[1].format("YYYY-MM-DD"));
    body.append("docType", values.docType ?? "weekly_report");
    body.append("note", (values.note ?? "").trim());
    body.append("ownerId", canPickOwner ? (values.ownerId ?? "") : user.id);
    body.append("file", file);
    void postForm("/api/reports", body)
      .then(() => {
        void message.success("已上传并提交审核");
        setUploadOpen(false);
        refresh();
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "上传失败"))
      .finally(() => setUploading(false));
  };

  const columns: TableProps<ReportLike>["columns"] = [
    {
      title: "归属人",
      dataIndex: "ownerName",
      key: "ownerName",
      width: 150,
      render: (_value, report) => <Typography.Text strong>{report.ownerName ?? "未分配"}</Typography.Text>,
    },
    {
      title: "类型",
      dataIndex: "docType",
      key: "docType",
      width: 100,
      filters: UPLOAD_DOC_TYPE_OPTIONS.map((item) => ({ text: item.label, value: item.value })),
      onFilter: (value, report) => report.docType === value,
      render: (_value, report) => (
        <Tag color="blue" variant="filled">
          {DOC_TYPE_LABEL[report.docType]}
        </Tag>
      ),
    },
    {
      title: "周期",
      key: "period",
      width: 200,
      sorter: (a, b) => a.periodStart.localeCompare(b.periodStart),
      render: (_value, report) => `${report.periodStart} ~ ${report.periodEnd}`,
    },
    {
      title: "备注",
      dataIndex: "note",
      key: "note",
      render: (_value, report) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text>{report.note || "—"}</Typography.Text>
          {report.reviewNote ? <Typography.Text type="secondary">审核批注：{report.reviewNote}</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: "文档",
      key: "files",
      width: 220,
      render: (_value, report) =>
        report.files.length ? (
          <Space orientation="vertical" size={2}>
            {report.files.map((item) => (
              <Typography.Link key={item.id} href={`/api/reports/${report.id}/file/${item.version}`}>
                v{item.version} · {item.originalName}
              </Typography.Link>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">暂无文档</Typography.Text>
        ),
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (_value, report) => (
        <Tag color={STATUS_COLOR[report.status]} variant="filled">
          {STATUS_LABEL[report.status]}
        </Tag>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 200,
      align: "right",
      render: (_value, report) => {
        const latest = report.files.at(-1);
        const canReview = canPickOwner;
        const isOwnerOfReport = report.ownerId === user.id;
        const canResubmit = report.status === "returned" && (canReview || isOwnerOfReport);
        const rowDisabled = rowBusy === report.id || busy;
        return (
          <RowActions
            disabled={rowDisabled}
            extra={
              report.status === "submitted" && canReview ? (
                <Button
                  size="small"
                  color="primary"
                  variant="solid"
                  onClick={() =>
                    confirmAction(modal, {
                      title: `通过 ${report.ownerName ?? "该成员"} 的${DOC_TYPE_LABEL[report.docType]}？`,
                      content: "通过后该文档进入已通过状态，如需修改需重新上传。",
                      okText: "通过",
                      onOk: () => run(report.id, () => postJson(`/api/reports/${report.id}/approve`), "已通过审核"),
                    })
                  }
                >
                  通过
                </Button>
              ) : canResubmit ? (
                <Upload
                  accept={ACCEPTED_DOCS}
                  maxCount={1}
                  showUploadList={false}
                  disabled={rowDisabled}
                  beforeUpload={(file) => {
                    const body = new FormData();
                    body.append("file", file);
                    run(report.id, () => postForm(`/api/reports/${report.id}/file`, body), "已重新提交");
                    return false;
                  }}
                >
                  <Button size="small" icon={<UploadOutlined />} disabled={rowDisabled}>
                    重新上传
                  </Button>
                </Upload>
              ) : latest ? (
                <Button
                  size="small"
                  color="default"
                  variant="text"
                  href={`/api/reports/${report.id}/file/${latest.version}`}
                  icon={<DownloadOutlined />}
                >
                  下载
                </Button>
              ) : null
            }
            items={
              [
                latest
                  ? {
                      key: "download",
                      label: `下载 v${latest.version}`,
                      icon: <DownloadOutlined />,
                      onClick: () => window.open(`/api/reports/${report.id}/file/${latest.version}`, "_blank"),
                    }
                  : null,
                report.status === "submitted" && canReview
                  ? {
                      key: "return",
                      label: "退回修改",
                      onClick: () => setReturnTarget(report),
                    }
                  : null,
              ].filter((item) => item !== null) as NonNullable<Parameters<typeof RowActions>[0]["items"]>
            }
          />
        );
      },
    },
  ];

  return (
    <Flex vertical gap="large" className="page-stack">
      <PageHeader
        title="周报/总结"
        description="提交工作周报与总结，查看审核结果。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={busy}>
              刷新
            </Button>
            <Button
              color="primary"
              variant="solid"
              icon={<UploadOutlined />}
              onClick={() => {
                setError("");
                setUploadOpen(true);
              }}
            >
              上传周报
            </Button>
          </>
        }
      />

      {error ? (
        <Alert
          type="error"
          showIcon
          title={error}
          action={
            <Button size="small" onClick={() => setError("")}>
              知道了
            </Button>
          }
        />
      ) : null}

      <Card variant="outlined">
        <Flex vertical gap="middle">
          <TableToolbar
            extra={
              <Typography.Text type="secondary">
                共 {rows.length} 份{filtered ? `（总计 ${reports.length} 份）` : ""}
              </Typography.Text>
            }
          >
            <Select
              value={type}
              options={DOC_TYPE_OPTIONS}
              style={{ width: 140 }}
              onChange={(value: string) => list.patch({ type: value === "all" ? null : value })}
            />
            <Select
              value={status}
              options={STATUS_OPTIONS}
              style={{ width: 140 }}
              onChange={(value: string) => list.patch({ status: value === "all" ? null : value })}
            />
            {canPickOwner ? (
              <Select
                value={owner}
                options={ownerOptions}
                style={{ width: 180 }}
                onChange={(value: string) => list.patch({ owner: value === "all" ? null : value })}
              />
            ) : null}
            {filtered ? (
              <Button color="default" variant="text" onClick={() => list.reset()}>
                重置
              </Button>
            ) : null}
          </TableToolbar>

          <Table<ReportLike>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={rows}
            loading={busy && !uploading}
            scroll={{ x: 1120 }}
            pagination={{
              pageSize: 10,
              showSizeChanger: true,
              showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 条`,
            }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    <Space orientation="vertical" size={2}>
                      <Typography.Text strong>{filtered ? "没有符合条件的周报" : "暂无周报"}</Typography.Text>
                      <Typography.Text type="secondary">
                        {filtered ? "调整筛选条件，或重置后查看全部。" : "点击右上角「上传周报」提交第一份文档。"}
                      </Typography.Text>
                    </Space>
                  }
                >
                  {filtered ? (
                    <Button onClick={() => list.reset()}>重置筛选</Button>
                  ) : (
                    <Button
                      onClick={() => {
                        setError("");
                        setUploadOpen(true);
                      }}
                    >
                      上传周报
                    </Button>
                  )}
                </Empty>
              ),
            }}
          />
        </Flex>
      </Card>

      <FormModal
        open={uploadOpen}
        title="上传周报 / 总结"
        okText="上传并提交"
        width={620}
        form={uploadForm}
        submitting={uploading}
        error={error}
        initialValues={{
          docType: "weekly_report",
          ownerId: canPickOwner ? "" : user.id,
          period: [dayjs().startOf("week"), dayjs().endOf("week")],
          file: [],
        }}
        onCancel={() => setUploadOpen(false)}
        onFinish={submitUpload}
      >
        {canPickOwner ? (
          <Form.Item name="ownerId" label="归属人" rules={[{ required: true, message: "请选择归属人" }]}>
            <Select
              placeholder="选择归属人"
              showSearch={{ optionFilterProp: "label" }}
              options={owners.map((item) => ({ value: item.id, label: ownerLabel(user, item) }))}
            />
          </Form.Item>
        ) : null}
        <Form.Item name="period" label="周期" rules={[{ required: true, message: "请选择周期" }]}>
          <DatePicker.RangePicker style={{ width: "100%" }} format="YYYY-MM-DD" />
        </Form.Item>
        <Flex gap="middle" wrap>
          <Form.Item name="docType" label="类型" style={{ minWidth: 160, flex: 1 }}>
            <Select options={UPLOAD_DOC_TYPE_OPTIONS} />
          </Form.Item>
          <Form.Item name="note" label="备注" style={{ minWidth: 220, flex: 2 }}>
            <Input placeholder="例如：第八周（可选）" maxLength={80} />
          </Form.Item>
        </Flex>
        <Form.Item
          name="file"
          label="文档"
          valuePropName="fileList"
          getValueFromEvent={(event: { fileList?: UploadFile[] } | UploadFile[]) =>
            Array.isArray(event) ? event : (event?.fileList ?? [])
          }
          rules={[{ required: true, message: "请选择要上传的文档" }]}
          tooltip="支持 .xlsx / .xls / .docx / .doc，单次一份"
        >
          <Upload accept={ACCEPTED_DOCS} maxCount={1} beforeUpload={() => false}>
            <Button icon={<UploadOutlined />}>选择文档</Button>
          </Upload>
        </Form.Item>
      </FormModal>

      <FormModal
        open={returnTarget !== null}
        title={`退回「${returnTarget?.ownerName ?? "该成员"}」的${returnTarget ? DOC_TYPE_LABEL[returnTarget.docType] : ""}`}
        okText="确认退回"
        form={returnForm}
        formKey={returnTarget?.id ?? "none"}
        initialValues={{ note: "" }}
        onCancel={() => setReturnTarget(null)}
        onFinish={(values) => {
          const target = returnTarget;
          const note = values.note?.trim() ?? "";
          if (!target || !note) return;
          setReturnTarget(null);
          run(target.id, () => postJson(`/api/reports/${target.id}/return`, { note }), "已退回");
        }}
      >
        <Alert type="warning" showIcon title="退回后提交人需要重新上传文档，退回原因会写入审核批注并通知对方。" />
        <Form.Item name="note" label="退回原因" rules={[{ required: true, message: "请填写退回原因" }]} style={{ marginTop: 16 }}>
          <Input.TextArea rows={3} maxLength={200} showCount placeholder="例如：缺少本周客户拜访记录，请补充后重新提交" />
        </Form.Item>
      </FormModal>
    </Flex>
  );
}

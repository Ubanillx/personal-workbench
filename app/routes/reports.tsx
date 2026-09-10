import type React from "react";
import { useMemo, useState } from "react";
import { useLoaderData, useNavigation, useRevalidator } from "react-router";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  Listy,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  Upload,
  type DescriptionsProps,
  type UploadFile,
} from "antd";
import { DownloadOutlined, ReloadOutlined, UploadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { listReportOwnersFor, listReportsFor } from "../lib/reports.server";
import { requireUserOrRedirect } from "../lib/ui.server";
import type { UserRole } from "../../shared/types/domain";

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

const docTypeLabels: Record<ReportDocTypeLike, string> = { weekly_report: "周报", summary: "总结", other: "其他" };
const statusLabels: Record<ReportStatusLike, string> = { submitted: "已提交", approved: "已通过", returned: "已退回" };
const statusColors: Record<ReportStatusLike, string> = { submitted: "blue", approved: "green", returned: "red" };
const ACCEPTED_DOCS = ".xlsx,.xls,.docx,.doc";

const typeOptions = [
  { value: "all", label: "全部类型" },
  { value: "weekly_report", label: "周报" },
  { value: "summary", label: "总结" },
  { value: "other", label: "其他" },
];
const statusOptions = [
  { value: "all", label: "全部状态" },
  { value: "submitted", label: "已提交" },
  { value: "approved", label: "已通过" },
  { value: "returned", label: "已退回" },
];
const docTypeOptions: Array<{ value: ReportDocTypeLike; label: string }> = [
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
  const { message } = AntdApp.useApp();
  const { user, reports, owners } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [error, setError] = useState("");
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const [owner, setOwner] = useState("all");
  const busy = navigation.state !== "idle" || revalidator.state !== "idle";
  // 管理员与组织管理者可以指派/筛选归属人，普通用户只能提交自己的
  const canPickOwner = user.role !== "member";

  const filtered = useMemo(
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

  const refresh = (): void => {
    void revalidator.revalidate();
  };
  const shownError = error;

  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <Space align="center" className="page-head" size="middle">
        <div>
          <Typography.Text type="secondary">WEEKLY REPORTS</Typography.Text>
          <Typography.Title level={3} className="page-title">
            周报 / 总结
          </Typography.Title>
          <Typography.Text type="secondary">存放成员的每周周报与总结文档（Excel / Word），上传后由管理员或组织管理者审核。</Typography.Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={refresh} loading={busy}>
          刷新
        </Button>
      </Space>

      {shownError ? (
        <Alert
          type="error"
          showIcon
          title={shownError}
          action={
            <Button size="small" onClick={refresh}>
              重试
            </Button>
          }
        />
      ) : null}

      <UploadForm
        me={user}
        owners={owners}
        onDone={(asProxy) => {
          void message.success(asProxy ? "已上传并提交审核" : "已提交审核");
          refresh();
        }}
        onError={setError}
      />

      <Card variant="outlined" title="周报列表" className="fill-card">
        <Space orientation="vertical" size="middle" className="page-stack">
          <Space wrap size="small">
            <Select value={type} onChange={setType} options={typeOptions} style={{ width: 132 }} />
            <Select value={status} onChange={setStatus} options={statusOptions} style={{ width: 132 }} />
            {canPickOwner ? <Select value={owner} onChange={setOwner} options={ownerOptions} style={{ width: 160 }} /> : null}
          </Space>

          {navigation.state === "loading" ? (
            <Spin description="正在加载周报…" />
          ) : filtered.length ? (
            <Listy<ReportLike>
              items={filtered}
              rowKey="id"
              itemRender={(report) => (
                <ReportItem
                  report={report}
                  me={user}
                  onChanged={refresh}
                  onError={setError}
                  onNotice={(text) => void message.success(text)}
                />
              )}
            />
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Space orientation="vertical" size={2}>
                  <Typography.Text strong>暂无周报</Typography.Text>
                  <Typography.Text type="secondary">上传第一份周报或总结开始使用。</Typography.Text>
                </Space>
              }
            />
          )}
        </Space>
      </Card>
    </Space>
  );
}

function UploadForm({
  me,
  owners,
  onDone,
  onError,
}: {
  me: MeLike;
  owners: OwnerLike[];
  onDone: (asProxy: boolean) => void;
  onError: (message: string) => void;
}): React.ReactElement {
  const [ownerId, setOwnerId] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [docType, setDocType] = useState<ReportDocTypeLike>("weekly_report");
  const [note, setNote] = useState("");
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [busy, setBusy] = useState(false);
  // 管理员与组织管理者可以代传（服务端按组织范围校验归属人），普通用户只能提交自己的
  const canPickOwner = me.role !== "member";
  // Upload 由本页手动提交（beforeUpload 返回 false），因此文件从 fileList 的 originFileObj 取
  const rawFile = fileList[0]?.originFileObj ?? null;

  const submit = (): void => {
    if (!rawFile || !periodStart || !periodEnd || busy) return;
    if (canPickOwner && !ownerId) {
      onError("请选择归属人");
      return;
    }
    setBusy(true);
    const form = new FormData();
    form.append("periodStart", periodStart);
    form.append("periodEnd", periodEnd);
    form.append("docType", docType);
    form.append("note", note.trim());
    form.append("ownerId", canPickOwner ? ownerId : me.id);
    form.append("file", rawFile);
    void postForm("/api/reports", form)
      .then(() => {
        onDone(canPickOwner);
        setOwnerId("");
        setPeriodStart("");
        setPeriodEnd("");
        setDocType("weekly_report");
        setNote("");
        setFileList([]);
      })
      .catch((reason: unknown) => onError(reason instanceof Error ? reason.message : "上传失败"))
      .finally(() => setBusy(false));
  };

  return (
    <Card variant="outlined" title="上传周报 / 总结">
      <Form layout="vertical" onFinish={submit}>
        <Row gutter={[16, 0]}>
          {canPickOwner ? (
            <Col xs={24} sm={12} lg={6}>
              <Form.Item label="归属人" required>
                <Select
                  value={ownerId || null}
                  onChange={(value: string) => setOwnerId(value)}
                  placeholder="选择归属人"
                  options={owners.map((item) => ({ value: item.id, label: ownerLabel(me, item) }))}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </Col>
          ) : null}
          <Col xs={24} sm={12} lg={6}>
            <Form.Item label="周期开始" required>
              <DatePicker
                value={periodStart ? dayjs(periodStart) : null}
                onChange={(date) => setPeriodStart(date ? date.format("YYYY-MM-DD") : "")}
                placeholder="周期开始"
                style={{ width: "100%" }}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Form.Item label="周期结束" required>
              <DatePicker
                value={periodEnd ? dayjs(periodEnd) : null}
                onChange={(date) => setPeriodEnd(date ? date.format("YYYY-MM-DD") : "")}
                placeholder="周期结束"
                style={{ width: "100%" }}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Form.Item label="类型">
              <Select
                value={docType}
                onChange={(value: ReportDocTypeLike) => setDocType(value)}
                options={docTypeOptions}
                style={{ width: "100%" }}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={14} lg={18}>
            <Form.Item label="备注">
              <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="备注（可选）" allowClear />
            </Form.Item>
          </Col>
          <Col xs={24} sm={10} lg={6}>
            <Form.Item label="文档" required>
              <Upload
                accept={ACCEPTED_DOCS}
                maxCount={1}
                fileList={fileList}
                beforeUpload={() => false}
                onChange={({ fileList: nextFileList }) => setFileList(nextFileList)}
                disabled={busy}
              >
                <Button icon={<UploadOutlined />} disabled={busy}>
                  选择文档
                </Button>
              </Upload>
            </Form.Item>
          </Col>
        </Row>
        <Button
          color="primary"
          variant="solid"
          htmlType="submit"
          icon={<UploadOutlined />}
          loading={busy}
          disabled={!rawFile || !periodStart || !periodEnd || busy || (canPickOwner && !ownerId)}
        >
          {busy ? "上传中…" : "上传并提交"}
        </Button>
      </Form>
    </Card>
  );
}

function ReportItem({
  report,
  me,
  onChanged,
  onError,
  onNotice,
}: {
  report: ReportLike;
  me: MeLike;
  onChanged: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnNote, setReturnNote] = useState("");
  // 管理员与组织管理者可以审批/退回本组织周报；普通用户只能看自己提交的
  const canReview = me.role !== "member";
  const isOwnerOfReport = report.ownerId === me.id;
  const canResubmit = report.status === "returned" && (canReview || isOwnerOfReport);
  const latest = report.files[report.files.length - 1];

  const run = (fn: () => Promise<ReportLike>): void => {
    if (busy) return;
    setBusy(true);
    void fn()
      .then(() => onChanged())
      .catch((reason: unknown) => onError(reason instanceof Error ? reason.message : "操作失败"))
      .finally(() => setBusy(false));
  };

  const items: DescriptionsProps["items"] = [
    { key: "period", label: "周期", children: `${report.periodStart} ~ ${report.periodEnd}` },
    ...(report.note ? [{ key: "note", label: "备注", children: report.note }] : []),
    ...(report.reviewNote ? [{ key: "reviewNote", label: "审核批注", children: report.reviewNote }] : []),
    ...(report.files.length
      ? [
          {
            key: "files",
            label: "文档",
            children: (
              <Space wrap size="small" separator={<Divider orientation="vertical" />}>
                {report.files.map((item) => (
                  <Typography.Link key={item.id} href={`/api/reports/${report.id}/file/${item.version}`}>
                    v{item.version} · {item.originalName}
                  </Typography.Link>
                ))}
              </Space>
            ),
          },
        ]
      : []),
  ];

  return (
    <Space orientation="vertical" size="small" className="list-block">
      <Space align="center" className="list-row" size="small">
        <Typography.Text strong>
          {report.ownerName ?? "未分配"} · {docTypeLabels[report.docType]}
        </Typography.Text>
        <Tag variant="filled" color={statusColors[report.status]}>
          {statusLabels[report.status]}
        </Tag>
      </Space>
      <Descriptions size="small" column={1} colon={false} items={items} />
      <Space wrap size="small">
        {canReview && report.status === "submitted" ? (
          <>
            <Button disabled={busy} onClick={() => run(() => postJson(`/api/reports/${report.id}/approve`))}>
              通过
            </Button>
            <Button disabled={busy} onClick={() => setReturnOpen(true)}>
              退回
            </Button>
          </>
        ) : null}
        {canResubmit ? <ResubmitButton report={report} onChanged={onChanged} onError={onError} onNotice={onNotice} /> : null}
        {latest ? (
          <Button href={`/api/reports/${report.id}/file/${latest.version}`} icon={<DownloadOutlined />}>
            下载
          </Button>
        ) : null}
      </Space>
      <Modal
        open={returnOpen}
        title="请填写退回原因"
        okText="确认退回"
        cancelText="取消"
        destroyOnHidden
        okButtonProps={{ disabled: !returnNote.trim() }}
        onOk={() => {
          const nextNote = returnNote.trim();
          if (!nextNote) return;
          setReturnOpen(false);
          setReturnNote("");
          run(() => postJson(`/api/reports/${report.id}/return`, { note: nextNote }));
        }}
        onCancel={() => {
          setReturnOpen(false);
          setReturnNote("");
        }}
      >
        <Input value={returnNote} onChange={(event) => setReturnNote(event.target.value)} maxLength={200} placeholder="退回原因" />
      </Modal>
    </Space>
  );
}

function ResubmitButton({
  report,
  onChanged,
  onError,
  onNotice,
}: {
  report: ReportLike;
  onChanged: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);

  const choose = (file: File): void => {
    setBusy(true);
    const form = new FormData();
    form.append("file", file);
    void postForm(`/api/reports/${report.id}/file`, form)
      .then(() => {
        onChanged();
        onNotice("已重新提交");
      })
      .catch((reason: unknown) => onError(reason instanceof Error ? reason.message : "重新上传失败"))
      .finally(() => setBusy(false));
  };

  return (
    <Upload
      accept={ACCEPTED_DOCS}
      maxCount={1}
      showUploadList={false}
      disabled={busy}
      beforeUpload={(next) => {
        choose(next);
        return false;
      }}
    >
      <Button loading={busy}>重新上传</Button>
    </Upload>
  );
}

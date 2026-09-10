import type React from "react";
import { useEffect, useMemo, useState } from "react";
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
import {
  approveReport,
  getMe,
  getReports,
  getUsers,
  reportFileUrl,
  returnReport,
  uploadReport,
  uploadReportVersion,
  type Collaborator,
  type Report,
  type ReportDocType,
} from "../services/apiClient";

const docTypeLabels: Record<ReportDocType, string> = { weekly_report: "周报", summary: "总结", other: "其他" };
const statusLabels: Record<Report["status"], string> = { submitted: "已提交", approved: "已通过", returned: "已退回" };
const statusColors: Record<Report["status"], string> = { submitted: "blue", approved: "green", returned: "red" };
const ACCEPTED_DOCS = ".xlsx,.xls,.docx,.doc";

type Me = { id: string; role: "owner" | "assistant" | "viewer" };

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

const docTypeOptions: Array<{ value: ReportDocType; label: string }> = [
  { value: "weekly_report", label: "周报" },
  { value: "summary", label: "总结" },
  { value: "other", label: "其他" },
];

export function ReportsPage(): React.ReactElement {
  const { message } = AntdApp.useApp();
  const [reports, setReports] = useState<Report[]>([]);
  const [members, setMembers] = useState<Collaborator[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const [owner, setOwner] = useState("all");

  const load = (): void => {
    setLoading(true);
    setError("");
    void Promise.all([getReports(), getMe(), getUsers().catch(() => [] as Collaborator[])])
      .then(([items, current, users]) => {
        setReports(items);
        setMe(current.user);
        setMembers(users);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "周报加载失败"))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const assistants = useMemo(() => members.filter((member) => member.role === "assistant" && member.isActive), [members]);
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
    () => [{ value: "all", label: "全部成员" }, ...assistants.map((member) => ({ value: member.id, label: member.name }))],
    [assistants],
  );

  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <Space align="center" className="page-head" size="middle">
        <div>
          <Typography.Text type="secondary">WEEKLY REPORTS</Typography.Text>
          <Typography.Title level={3} className="page-title">
            周报 / 总结
          </Typography.Title>
          <Typography.Text type="secondary">存放助理或实习生的每周周报与总结文档（Excel / Word），上传后提交主人审核。</Typography.Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
          刷新
        </Button>
      </Space>

      {error ? (
        <Alert
          type="error"
          showIcon
          title={error}
          action={
            <Button size="small" onClick={load}>
              重试
            </Button>
          }
        />
      ) : null}

      {me ? (
        <UploadForm
          me={me}
          assistants={assistants}
          onDone={(next) => {
            setReports((items) => [next, ...items.filter((item) => item.id !== next.id)]);
            void message.success(me.role === "owner" ? "已上传并提交审核" : "已提交审核");
          }}
          onError={setError}
        />
      ) : null}

      <Card variant="outlined" title="周报列表" className="fill-card">
        <Space orientation="vertical" size="middle" className="page-stack">
          <Space wrap size="small">
            <Select value={type} onChange={setType} options={typeOptions} style={{ width: 132 }} />
            <Select value={status} onChange={setStatus} options={statusOptions} style={{ width: 132 }} />
            {me?.role === "owner" ? <Select value={owner} onChange={setOwner} options={ownerOptions} style={{ width: 160 }} /> : null}
          </Space>

          {loading ? (
            <Spin description="正在加载周报…" />
          ) : me && filtered.length ? (
            <Listy<Report>
              items={filtered}
              rowKey="id"
              itemRender={(report) => (
                <ReportItem
                  report={report}
                  me={me}
                  onChanged={(updated) => setReports((items) => items.map((item) => (item.id === updated.id ? updated : item)))}
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
  assistants,
  onDone,
  onError,
}: {
  me: Me;
  assistants: Collaborator[];
  onDone: (report: Report) => void;
  onError: (message: string) => void;
}): React.ReactElement {
  const [ownerId, setOwnerId] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [docType, setDocType] = useState<ReportDocType>("weekly_report");
  const [note, setNote] = useState("");
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [busy, setBusy] = useState(false);
  const isOwner = me.role === "owner";
  // Upload 由本页手动提交（beforeUpload 返回 false），因此文件从 fileList 的 originFileObj 取
  const rawFile = fileList[0]?.originFileObj ?? null;

  const submit = (): void => {
    if (!rawFile || !periodStart || !periodEnd || busy) return;
    if (isOwner && !ownerId) {
      onError("请选择归属人");
      return;
    }
    setBusy(true);
    const nextOwnerId = isOwner ? ownerId : me.id;
    void uploadReport({ file: rawFile, ownerId: nextOwnerId, periodStart, periodEnd, docType, note: note.trim() })
      .then((report) => {
        onDone(report);
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
          {isOwner ? (
            <Col xs={24} sm={12} lg={6}>
              <Form.Item label="归属人" required>
                <Select
                  value={ownerId || null}
                  onChange={(value: string) => setOwnerId(value)}
                  placeholder="选择归属人（助理）"
                  options={assistants.map((member) => ({ value: member.id, label: member.name }))}
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
                onChange={(value: ReportDocType) => setDocType(value)}
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
          disabled={!rawFile || !periodStart || !periodEnd || busy || (isOwner && !ownerId)}
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
  report: Report;
  me: Me;
  onChanged: (report: Report) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnNote, setReturnNote] = useState("");
  const isOwner = me.role === "owner";
  const isOwnerOfReport = report.ownerId === me.id;
  const canResubmit = !isOwner && isOwnerOfReport && report.status === "returned";
  const latest = report.files[report.files.length - 1];

  const run = (fn: () => Promise<Report>): void => {
    if (busy) return;
    setBusy(true);
    void fn()
      .then((updated) => onChanged(updated))
      .catch((reason: unknown) => onError(reason instanceof Error ? reason.message : "操作失败"))
      .finally(() => setBusy(false));
  };

  const items: DescriptionsProps["items"] = [
    { key: "period", label: "周期", children: `${report.periodStart} ~ ${report.periodEnd}` },
    ...(report.note ? [{ key: "note", label: "备注", children: report.note }] : []),
    ...(report.reviewNote ? [{ key: "reviewNote", label: "主人批注", children: report.reviewNote }] : []),
    ...(report.files.length
      ? [
          {
            key: "files",
            label: "文档",
            children: (
              <Space wrap size="small" separator={<Divider orientation="vertical" />}>
                {report.files.map((item) => (
                  <Typography.Link key={item.id} href={reportFileUrl(report.id, item.version)}>
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
        {isOwner && report.status === "submitted" ? (
          <>
            <Button disabled={busy} onClick={() => run(() => approveReport(report.id))}>
              通过
            </Button>
            <Button disabled={busy} onClick={() => setReturnOpen(true)}>
              退回
            </Button>
          </>
        ) : null}
        {canResubmit ? <ResubmitButton report={report} onChanged={onChanged} onError={onError} onNotice={onNotice} /> : null}
        {latest ? (
          <Button href={reportFileUrl(report.id, latest.version)} icon={<DownloadOutlined />}>
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
          run(() => returnReport(report.id, nextNote));
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
  report: Report;
  onChanged: (report: Report) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);

  const choose = (file: File): void => {
    setBusy(true);
    void uploadReportVersion(report.id, file)
      .then((updated) => {
        onChanged(updated);
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

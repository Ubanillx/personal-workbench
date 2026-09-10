import type React from "react";
import { useMemo, useState } from "react";
import { useLoaderData } from "react-router";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Empty,
  Flex,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  type TableProps,
} from "antd";
import { ClearOutlined, ImportOutlined, ThunderboltOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { UserRole } from "../../shared/types/domain";
import { TableToolbar } from "../components/crud-toolbar";
import { PageHeader } from "../components/page-header";
import { listAllAccounts, listMembers, listOrganizations } from "../lib/organization.server";
import { requireUserOrRedirect } from "../lib/ui.server";

type MemberRow = { id: string; name: string; role: UserRole; isActive: number | boolean; orgId?: string | null };

type Draft = {
  id: string;
  title: string;
  dueDate: string | null;
  ownerId: string;
  priority: "P0" | "P1" | "P2";
  sender: string;
  messageAt: string;
  fingerprint: string;
  selected: boolean;
  duplicate: boolean;
};

const PRIORITY_OPTIONS = [
  { value: "P0", label: "P0 · 最高" },
  { value: "P1", label: "P1 · 普通" },
  { value: "P2", label: "P2 · 较低" },
];

/**
 * 收件箱 loader：负责人候选与目标组织都按角色收窄（§4 的「企微收件箱导入」一行）——
 * 管理员看全部有组织的账号（跨组织合并视图），组织管理者看本组织成员，普通成员只能指派给自己。
 * 管理员是全局角色、不隶属任何组织，导入必须显式选目标组织（与概览页快捷新增的写法一致），
 * 已解散的组织不能写入，因此不列出来。未加入组织的账号由 requireUserOrRedirect 送回 /join（D-34）。
 */
export async function loader({ request }: { request: Request }) {
  const user = requireUserOrRedirect(request);
  const members =
    user.role === "admin"
      ? (listAllAccounts() as unknown as MemberRow[]).filter((member) => member.role !== "admin" && Boolean(member.orgId))
      : user.role === "manager" && user.orgId
        ? (listMembers(user.orgId) as unknown as MemberRow[])
        : [{ id: user.id, name: user.name, role: user.role, isActive: true }];
  const orgs =
    user.role === "admin"
      ? listOrganizations(user)
          .filter((org) => org.status === "active")
          .map((org) => ({ id: org.id, name: org.name }))
      : [];
  return { members, selfId: user.id, memberSelfOnly: user.role === "member", orgs };
}

/**
 * 企微收件箱：**「粘贴 → 解析 → 逐条校对 → 批量导入」**的录入型页面。
 * 校对区是一张可编辑表格（ProTable 的编辑行思路）：每行都能改标题/负责人/优先级/截止日期，
 * 并逐行勾选是否导入；疑似重复的行默认不勾选，避免重复建单。
 * 解析与导入都调用既有 API（/api/inbox/preview、/api/inbox/import），服务端规则不变。
 */
export default function InboxRoute(): React.ReactElement {
  const data = useLoaderData<typeof loader>();
  const { message } = AntdApp.useApp();
  // 粘贴的聊天记录与逐条编辑都是"尚未保存的输入"，保留为页面本地状态（不是服务端数据）
  const [raw, setRaw] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // 管理员必须选定导入目标组织（后端对 admin 强制要求 orgId）；其他角色的 orgs 为空，用不上
  const [orgId, setOrgId] = useState(data.orgs[0]?.id ?? "");
  const needOrg = data.orgs.length > 0 && !orgId;

  // 负责人候选由 loader 按角色收窄；已停用账号不列出来（服务端也会拒绝）
  const ownerOptions = [
    { value: "", label: "未分配" },
    ...data.members.filter((member) => Boolean(member.isActive)).map((member) => ({ value: member.id, label: member.name })),
  ];
  const selectedCount = useMemo(() => drafts.filter((draft) => draft.selected).length, [drafts]);

  const parse = (): void => {
    const initial = parseInbox(raw);
    if (!initial.length) {
      setError("没有识别出任务，请检查聊天记录格式（每条形如「张三 10:23」+ 下一行任务内容）");
      setDrafts([]);
      return;
    }
    setError("");
    setBusy(true);
    void fetch("/api/inbox/preview", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drafts: initial, ...(orgId ? { orgId } : {}) }),
    })
      .then(async (response) => {
        const payload = (await response.json()) as { ok: boolean; data?: Draft[]; error?: { message: string } };
        if (!payload.ok) throw new Error(payload.error?.message ?? "重复检查失败");
        const items = payload.data ?? [];
        setDrafts(
          initial.map((draft, index) => {
            const preview = items[index];
            return {
              ...draft,
              fingerprint: preview?.fingerprint ?? draft.fingerprint,
              duplicate: Boolean(preview?.duplicate),
              selected: !preview?.duplicate,
            };
          }),
        );
        setNotice(`识别出 ${initial.length} 条消息，请逐条确认后导入`);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "重复检查失败"))
      .finally(() => setBusy(false));
  };

  const submit = (): void => {
    const chosen = drafts.filter((draft) => draft.selected);
    if (!chosen.length) {
      setError("请至少选择一条任务");
      return;
    }
    setError("");
    setBusy(true);
    void fetch("/api/inbox/import", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drafts: chosen, ...(orgId ? { orgId } : {}) }),
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          ok: boolean;
          data?: { created: unknown[]; skipped: unknown[] };
          error?: { message: string };
        };
        if (!payload.ok) throw new Error(payload.error?.message ?? "导入失败");
        void message.success(`导入成功 ${payload.data?.created.length ?? 0} 条`);
        setNotice(`导入成功 ${payload.data?.created.length ?? 0} 条；跳过 ${payload.data?.skipped.length ?? 0} 条疑似重复`);
        setDrafts([]);
        setRaw("");
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "导入失败"))
      .finally(() => setBusy(false));
  };

  const change = (id: string, patch: Partial<Draft>): void =>
    setDrafts((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  const selectAll = (selected: boolean): void => setDrafts((items) => items.map((item) => Object.assign({}, item, { selected })));
  const selectNonDuplicate = (): void => setDrafts((items) => items.map((item) => Object.assign({}, item, { selected: !item.duplicate })));

  const columns: TableProps<Draft>["columns"] = [
    {
      title: "导入",
      dataIndex: "selected",
      key: "selected",
      width: 70,
      align: "center",
      render: (_value, draft) => (
        <Checkbox checked={draft.selected} onChange={(event) => change(draft.id, { selected: event.target.checked })} />
      ),
    },
    {
      title: "任务标题",
      dataIndex: "title",
      key: "title",
      render: (_value, draft) => (
        <Input
          value={draft.title}
          onChange={(event) => change(draft.id, { title: event.target.value })}
          maxLength={240}
          placeholder="任务标题"
        />
      ),
    },
    {
      title: "负责人",
      dataIndex: "ownerId",
      key: "ownerId",
      width: 170,
      render: (_value, draft) => (
        <Select
          // 普通成员只能把导入的任务建给自己（与任务域一致），这里直接锁死选择
          value={data.memberSelfOnly ? data.selfId : draft.ownerId}
          options={ownerOptions}
          disabled={data.memberSelfOnly}
          onChange={(value: string) => change(draft.id, { ownerId: value })}
          style={{ width: "100%" }}
        />
      ),
    },
    {
      title: "优先级",
      dataIndex: "priority",
      key: "priority",
      width: 130,
      render: (_value, draft) => (
        <Select
          value={draft.priority}
          options={PRIORITY_OPTIONS}
          onChange={(value: Draft["priority"]) => change(draft.id, { priority: value })}
          style={{ width: "100%" }}
        />
      ),
    },
    {
      title: "截止日期",
      dataIndex: "dueDate",
      key: "dueDate",
      width: 160,
      render: (_value, draft) => (
        <DatePicker
          value={draft.dueDate ? dayjs(draft.dueDate) : null}
          onChange={(value) => change(draft.id, { dueDate: value ? value.format("YYYY-MM-DD") : null })}
          format="YYYY-MM-DD"
          placeholder="未识别"
          style={{ width: "100%" }}
        />
      ),
    },
    {
      title: "来源",
      key: "source",
      width: 150,
      render: (_value, draft) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text>{draft.sender || "未识别发送人"}</Typography.Text>
          <Typography.Text type="secondary">{draft.messageAt || "—"}</Typography.Text>
        </Space>
      ),
    },
    {
      title: "查重",
      dataIndex: "duplicate",
      key: "duplicate",
      width: 110,
      render: (_value, draft) =>
        draft.duplicate ? (
          <Tag color="warning" variant="filled">
            疑似重复
          </Tag>
        ) : (
          <Tag color="green" variant="filled">
            可导入
          </Tag>
        ),
    },
  ];

  return (
    <Flex vertical gap="large" className="page-stack">
      <PageHeader
        title="企微收件箱"
        description="将聊天记录整理为任务，核对后批量导入。"
        extra={
          <>
            {data.orgs.length > 0 ? (
              <Select
                value={orgId}
                options={data.orgs.map((org) => ({ value: org.id, label: org.name }))}
                onChange={setOrgId}
                placeholder="导入到组织"
                style={{ minWidth: 180 }}
              />
            ) : null}
            <Button
              color="primary"
              variant="solid"
              icon={<ThunderboltOutlined />}
              disabled={!raw.trim() || busy || needOrg}
              loading={busy}
              onClick={parse}
            >
              解析消息
            </Button>
          </>
        }
      />

      {error ? <Alert type="error" showIcon title={error} /> : null}
      {needOrg ? <Alert type="warning" showIcon title="请先选择导入目标组织（管理员不隶属任何组织）" /> : null}

      <Card variant="outlined" title="粘贴聊天记录">
        <Flex vertical gap="middle">
          <Input.TextArea
            rows={5}
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            placeholder={
              "粘贴聊天记录，例如：\n张三 10:23\n请在本周五前完成季度报告初稿，发我一份\n李四 14:05\n记得明天上午同步一下客户反馈"
            }
          />
          <Space size="small" wrap>
            <Button
              icon={<ClearOutlined />}
              disabled={!raw && !drafts.length}
              onClick={() => {
                setRaw("");
                setDrafts([]);
                setNotice("");
                setError("");
              }}
            >
              清空
            </Button>
            <Typography.Text type="secondary">
              解析规则：识别「发送人 + 时间」行与其后的任务描述，并从「今天/明天/后天/x月x日」推断截止日期。
            </Typography.Text>
          </Space>
        </Flex>
      </Card>

      {notice ? <Alert type="info" showIcon title={notice} /> : null}

      <Card
        variant="outlined"
        title={`待导入任务（已选 ${selectedCount} / ${drafts.length} 条）`}
        extra={
          <Button
            color="primary"
            variant="solid"
            icon={<ImportOutlined />}
            disabled={busy || needOrg || selectedCount === 0}
            loading={busy}
            onClick={submit}
          >
            导入选中任务
          </Button>
        }
      >
        <Flex vertical gap="middle">
          <TableToolbar
            extra={
              <Space size="small">
                <Button size="small" disabled={!drafts.length} onClick={() => selectAll(true)}>
                  全选
                </Button>
                <Button size="small" disabled={!drafts.length} onClick={() => selectAll(false)}>
                  全不选
                </Button>
                <Button size="small" disabled={!drafts.length} onClick={selectNonDuplicate}>
                  只选非重复
                </Button>
              </Space>
            }
          >
            <Typography.Text type="secondary">逐行核对后再导入；疑似重复的行默认不勾选。</Typography.Text>
          </TableToolbar>

          <Table<Draft>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={drafts}
            loading={busy}
            scroll={{ x: 1180 }}
            pagination={{
              pageSize: 10,
              showSizeChanger: false,
              showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 条`,
            }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    <Space orientation="vertical" size={2}>
                      <Typography.Text strong>还没有待导入的任务</Typography.Text>
                      <Typography.Text type="secondary">粘贴聊天记录后点击右上角「解析消息」。</Typography.Text>
                    </Space>
                  }
                />
              ),
            }}
          />
        </Flex>
      </Card>
    </Flex>
  );
}

/** 以下三个纯函数与旧 SPA 逐字一致（解析规则不能变，否则识别结果会漂移） */
function parseInbox(raw: string): Draft[] {
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  let sender = "";
  let messageAt = "";
  const drafts: Draft[] = [];
  for (const line of lines) {
    const header = line.match(/^(.{1,24}?)(?:\s+|\s*[:：]\s*)(上午|下午|晚上)?\s*(\d{1,2}:\d{2}(?::\d{2})?)$/u);
    if (header) {
      sender = header[1]?.trim() ?? "";
      messageAt = header[3] ?? "";
      continue;
    }
    if (/^\[(文件|图片|链接|语音)\]/u.test(line) || line.length < 4) continue;
    const title = line.replace(/@\S+\s*/gu, "").slice(0, 240);
    const dueDate = guessDue(title);
    drafts.push({
      id: `${Date.now()}-${drafts.length}`,
      title,
      dueDate,
      ownerId: "",
      priority: "P1",
      sender,
      messageAt,
      fingerprint: `${sender}\n${title}\n${messageAt || dueDate || ""}`,
      selected: true,
      duplicate: false,
    });
  }
  return drafts;
}
function guessDue(text: string): string | null {
  const today = new Date();
  if (text.includes("今天")) return formatDate(today);
  if (text.includes("明天")) {
    today.setDate(today.getDate() + 1);
    return formatDate(today);
  }
  if (text.includes("后天")) {
    today.setDate(today.getDate() + 2);
    return formatDate(today);
  }
  const match = text.match(/(\d{1,2})月(\d{1,2})[日号]?/u);
  return match ? `${today.getFullYear()}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}` : null;
}
function formatDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

import type React from "react";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Drawer,
  Empty,
  Flex,
  Input,
  Select,
  Space,
  Steps,
  Table,
  Tag,
  Typography,
  type TableProps,
} from "antd";
import { ClearOutlined, ImportOutlined, RollbackOutlined, ThunderboltOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { UserRole } from "../../shared/types/domain";
import { TableToolbar } from "./crud-toolbar";
import { dataTable } from "./table-layout";

/**
 * 「从企微导入任务」抽屉：把**粘贴聊天记录 → 解析 → 逐条校对 → 批量导入**整条录入链路
 * 挂进它真正产出数据的地方——任务进展页（`app/routes/tasks.tsx`）。
 *
 * 为什么不再单独占一个页面：导出的结果就是一串任务，独立页面导入完还要切回任务列表才能确认，
 * 组织筛选器、负责人名单、导入目标组织在三处各写一遍也容易走偏。放进任务页后：
 * 1. 目标组织默认**跟随页面的组织筛选器**（D-28 的接缝），导完的任务就在当前列表里；
 * 2. 负责人候选与「新建任务」共用页面 loader 收窄过的名单（D-47：同一个字段只有一个来源）；
 * 3. 导入成功即 `onImported` → 页面关抽屉 + 提示 + `useRevalidator()`，列表当场出现新任务。
 *
 * 服务端规则一个字没改：解析/查重/导入仍走既有的 `POST /api/inbox/preview`、
 * `POST /api/inbox/import`（组织隔离、指纹去重、负责人校验都在那边），本组件只负责录入体验。
 */
export function WecomImportDrawer({
  open,
  role,
  selfId,
  members,
  organizations,
  defaultOrgId,
  onClose,
  onImported,
}: {
  open: boolean;
  /** 当前账号角色：普通成员只能把导入的任务建给自己（与任务域一致） */
  role: UserRole;
  selfId: string;
  /** 指派候选：与「新建任务」同一个名单，由页面 loader 按角色收窄 */
  members: WecomOwnerCandidate[];
  /** 可选的目标组织，仅管理员非空（管理员不隶属组织，导入必须显式选组织） */
  organizations: WecomOrgOption[];
  /** 打开时的默认目标组织：管理员跟随页面上的组织筛选器 */
  defaultOrgId: string;
  onClose: () => void;
  onImported: (created: number, skipped: number) => void;
}): React.ReactElement {
  const selfOnly = role === "member";
  const [step, setStep] = useState(0);
  // 粘贴的聊天记录与逐条编辑都是「尚未保存的输入」，保留为抽屉本地状态（不是服务端数据）
  const [raw, setRaw] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [orgId, setOrgId] = useState(defaultOrgId);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * 每次打开都从干净状态开始，不保留上一次的粘贴内容与校对结果：
   * 草稿是「还没入库的输入」，留着只会让人以为上一轮已经导入过了。
   */
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setRaw("");
    setDrafts([]);
    setOrgId(defaultOrgId);
    setNotice("");
    setError("");
    setBusy(false);
    // 只在「打开」的那一次重置：默认组织由父组件按当时的组织筛选器给出，不作为重置条件
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const needOrg = organizations.length > 0 && !orgId;
  /** 校对着的这批草稿要落到哪个组织（管理员在「粘贴」那一步已选定，这里只作展示） */
  const targetOrgName = organizations.find((org) => org.id === orgId)?.name ?? "";

  /**
   * 负责人候选：管理员再按**目标组织**过滤（负责人必须属于任务所在组织，全局管理员除外），
   * 与 `/api/inbox/import` 的 `validateOwner(..., { orgId })` 同一口径——名单外的服务端也会拒。
   * 多组织视图里用「姓名（管理员）」区分全局账号（与任务页创建表单同一说法）。
   */
  const ownerOptions = useMemo(
    () => [
      { value: "", label: "未分配" },
      ...(selfOnly ? [] : members)
        .filter((member) => Boolean(member.isActive) && (member.role === "admin" || !orgId || member.orgId === orgId))
        .map((member) => ({ value: member.id, label: member.role === "admin" ? `${member.name}（管理员）` : member.name })),
    ],
    [members, orgId, selfOnly],
  );
  const selectedCount = drafts.filter((draft) => draft.selected).length;

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
        const previews = payload.data ?? [];
        setDrafts(
          initial.map((draft, index) => ({
            ...draft,
            fingerprint: previews[index]?.fingerprint ?? draft.fingerprint,
            duplicate: Boolean(previews[index]?.duplicate),
            selected: !previews[index]?.duplicate,
          })),
        );
        setNotice(`识别出 ${initial.length} 条消息，请逐条确认后导入`);
        setStep(1);
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
        onImported(payload.data?.created.length ?? 0, payload.data?.skipped.length ?? 0);
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
      width: 60,
      align: "center",
      render: (_value, draft) => (
        <Checkbox
          checked={draft.selected}
          aria-label={`导入「${draft.title}」`}
          onChange={(event) => change(draft.id, { selected: event.target.checked })}
        />
      ),
    },
    {
      // 标题列自带「来源 + 查重」副行：抽屉宽度有限，把这三件事并进一列，横向不用滚动即可看全
      title: "任务标题",
      dataIndex: "title",
      key: "title",
      render: (_value, draft) => (
        <Flex vertical gap={4}>
          <Input
            value={draft.title}
            onChange={(event) => change(draft.id, { title: event.target.value })}
            maxLength={240}
            placeholder="任务标题"
          />
          <Space size={6} wrap>
            <Typography.Text type="secondary">
              {draft.sender || "未识别发送人"}
              {draft.messageAt ? ` ${draft.messageAt}` : ""}
            </Typography.Text>
            {draft.duplicate ? (
              <Tag color="warning" variant="filled">
                疑似重复
              </Tag>
            ) : (
              <Tag color="green" variant="filled">
                可导入
              </Tag>
            )}
          </Space>
        </Flex>
      ),
    },
    {
      title: "负责人",
      dataIndex: "ownerId",
      key: "ownerId",
      width: 150,
      render: (_value, draft) => (
        <Select
          // 普通成员只能把导入的任务建给自己（与任务域一致），这里直接锁死选择
          value={selfOnly ? selfId : draft.ownerId}
          options={ownerOptions}
          disabled={selfOnly}
          onChange={(value: string) => change(draft.id, { ownerId: value })}
          style={{ width: "100%" }}
        />
      ),
    },
    {
      title: "优先级",
      dataIndex: "priority",
      key: "priority",
      width: 120,
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
      width: 150,
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
  ];

  // 表格排版方案（自动省略 + 定宽排版）：抽屉里横向空间有限，总宽由列宽算出（不再手写 700）
  const table = useMemo(() => dataTable<Draft>({ columns }), [columns]);

  return (
    <Drawer
      open={open}
      title="从企微导入任务"
      placement="right"
      size={780}
      onClose={onClose}
      footer={
        step === 0 ? (
          <Flex justify="flex-end" gap="small">
            <Button onClick={onClose}>取消</Button>
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
          </Flex>
        ) : (
          <Flex justify="space-between" align="center" gap="middle" wrap>
            <Button icon={<RollbackOutlined />} disabled={busy} onClick={() => setStep(0)}>
              返回修改
            </Button>
            <Button
              color="primary"
              variant="solid"
              icon={<ImportOutlined />}
              disabled={busy || needOrg || selectedCount === 0}
              loading={busy}
              onClick={submit}
            >
              导入选中任务（{selectedCount}）
            </Button>
          </Flex>
        )
      }
    >
      <Flex vertical gap="middle">
        <Steps size="small" current={step} items={[{ title: "粘贴聊天记录" }, { title: "校对并导入" }]} />

        {/*
          目标组织只在「粘贴」这一步选：查重是按目标组织算的，校对到一半再换组织会让重复标记失效。
          需要换组织就点「返回修改」，回来重新解析即可（粘贴的内容不会丢）。
        */}
        {step === 0 && organizations.length > 0 ? (
          <Select
            aria-label="导入到组织"
            value={orgId}
            options={organizations.map((org) => ({ value: org.id, label: org.name }))}
            onChange={setOrgId}
            placeholder="导入到组织"
            style={{ width: "100%" }}
          />
        ) : null}
        {error ? <Alert type="error" showIcon title={error} /> : null}
        {needOrg ? <Alert type="warning" showIcon title="请先选择导入的目标组织（管理员不隶属任何组织）" /> : null}

        {step === 0 ? (
          <Flex vertical gap="small">
            <Input.TextArea
              rows={9}
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
              placeholder={
                "粘贴聊天记录，例如：\n张三 10:23\n请在本周五前完成季度报告初稿，发我一份\n李四 14:05\n记得明天上午同步一下客户反馈"
              }
            />
            <Flex justify="space-between" align="center" gap="small" wrap>
              <Typography.Text type="secondary">
                识别「发送人 + 时间」行与其后的任务描述，并从「今天/明天/后天/x月x日」推断截止日期。
              </Typography.Text>
              <Button
                icon={<ClearOutlined />}
                disabled={!raw || busy}
                onClick={() => {
                  setRaw("");
                  setNotice("");
                  setError("");
                }}
              >
                清空
              </Button>
            </Flex>
          </Flex>
        ) : (
          <Flex vertical gap="small">
            {notice ? <Alert type="info" showIcon title={notice} /> : null}
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
              <Typography.Text type="secondary">
                {targetOrgName ? `导入到「${targetOrgName}」；` : ""}逐行核对后再导入；疑似重复的行默认不勾选。
              </Typography.Text>
            </TableToolbar>
            <Table<Draft>
              {...table}
              rowKey="id"
              // 抽屉里纵向空间有限，校对表用紧凑行距（任务列表本身仍是 size="middle"）
              size="small"
              dataSource={drafts}
              loading={busy}
              pagination={{
                pageSize: 10,
                showSizeChanger: false,
                showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 条`,
              }}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={<Typography.Text type="secondary">还没有待导入的任务，返回上一步粘贴聊天记录。</Typography.Text>}
                  />
                ),
              }}
            />
          </Flex>
        )}
      </Flex>
    </Drawer>
  );
}

/** 指派候选（与任务页 `Member` 同构的子集：只要过滤用得上的字段） */
export type WecomOwnerCandidate = {
  id: string;
  name: string;
  role: UserRole;
  orgId?: string | null;
  isActive: number | boolean;
};
export type WecomOrgOption = { id: string; name: string };

type Draft = {
  id: string;
  title: string;
  dueDate: string | null;
  ownerId: string;
  priority: "P0" | "P1" | "P2";
  sender: string;
  messageAt: string;
  /**
   * 查重指纹：与旧收件箱页逐字一致地由客户端给出（`inboxFingerprint` **优先采用**提交上来的值）。
   * 不能省——历史数据的指纹就是这套算法写的，换一套会让老记录查不出重复。
   */
  fingerprint: string;
  /** 服务端 `/api/inbox/preview` 按目标组织算出来的查重结果 */
  duplicate: boolean;
  selected: boolean;
};

const PRIORITY_OPTIONS = [
  { value: "P0", label: "P0 · 最高" },
  { value: "P1", label: "P1 · 普通" },
  { value: "P2", label: "P2 · 较低" },
];

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
      duplicate: false,
      selected: true,
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

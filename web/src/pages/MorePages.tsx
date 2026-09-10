import type React from "react";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Empty,
  Flex,
  Form,
  Input,
  Listy,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
  type TableProps,
} from "antd";
import { CheckOutlined, CopyOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { Task, UserRole } from "../../../shared/types/domain";
import {
  createFile,
  createUser,
  deleteFile,
  getAccessInfo,
  getFiles,
  getMe,
  getReview,
  getUsers,
  importInbox,
  logout,
  previewInbox,
  rotateUserToken,
  updateUser,
  markFileUsed,
  type AccessInfo,
  type Collaborator,
  type ImportantFile,
  type InboxDraft,
  type ReviewData,
} from "../services/apiClient";

type Draft = InboxDraft & {
  id: string;
  ownerId: string;
  priority: "P0" | "P1" | "P2";
  sender: string;
  messageAt: string;
  fingerprint: string;
  selected: boolean;
  duplicate: boolean;
};
const roleLabel: Record<UserRole, string> = { owner: "主人", assistant: "助理", viewer: "查看者" };
const priorityOptions = [
  { value: "P0", label: "P0" },
  { value: "P1", label: "P1" },
  { value: "P2", label: "P2" },
];

export function InboxPage(): React.ReactElement {
  const [raw, setRaw] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [members, setMembers] = useState<Collaborator[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void getUsers()
      .then(setMembers)
      .catch(() => setMembers([]));
  }, []);
  const ownerOptions = useMemo(
    () => [
      { value: "", label: "未分配" },
      { value: "owner", label: "主人" },
      ...members
        .filter((member) => member.role === "assistant" && member.isActive)
        .map((member) => ({ value: member.id, label: member.name })),
    ],
    [members],
  );
  const parse = (): void => {
    const initial = parseInbox(raw);
    if (!initial.length) {
      setNotice("没有识别出任务，请检查聊天记录格式");
      setDrafts([]);
      return;
    }
    setBusy(true);
    void previewInbox(initial)
      .then((items) => {
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
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : "重复检查失败"))
      .finally(() => setBusy(false));
  };
  const submit = (): void => {
    const chosen = drafts.filter((draft) => draft.selected);
    if (!chosen.length) {
      setNotice("请至少选择一条任务");
      return;
    }
    setBusy(true);
    void importInbox(chosen)
      .then((result) => {
        setNotice(`导入成功 ${result.created.length} 条；跳过 ${result.skipped.length} 条疑似重复`);
        setDrafts([]);
        setRaw("");
      })
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : "导入失败"))
      .finally(() => setBusy(false));
  };
  const change = (id: string, patch: Partial<Draft>): void =>
    setDrafts((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <Space align="center" className="page-head" size="middle">
        <div>
          <Typography.Title level={3} className="page-title">
            企微收件箱
          </Typography.Title>
          <Typography.Text type="secondary">粘贴聊天记录，逐条编辑标题、负责人、优先级与截止日期。系统会标记疑似重复任务。</Typography.Text>
        </div>
        <Space size="small">
          <Button color="primary" variant="solid" disabled={!raw.trim() || busy} loading={busy} onClick={parse}>
            解析消息
          </Button>
          {drafts.length > 0 && (
            <Button disabled={busy} onClick={submit}>
              导入选中任务
            </Button>
          )}
        </Space>
      </Space>

      <Input.TextArea
        rows={5}
        value={raw}
        onChange={(event) => setRaw(event.target.value)}
        placeholder={"张三 10:23\n请在本周五前完成季度报告初稿，发我一份\n李四 14:05\n记得明天上午同步一下客户反馈"}
      />

      {notice && <Alert type="info" showIcon title={notice} />}

      {drafts.length > 0 && (
        <Listy
          items={drafts}
          rowKey="id"
          itemRender={(draft) => (
            <Flex vertical gap="small" className="list-block">
              <Flex gap="small" align="center" wrap>
                <Checkbox checked={draft.selected} onChange={(event) => change(draft.id, { selected: event.target.checked })} />
                <Input
                  value={draft.title}
                  onChange={(event) => change(draft.id, { title: event.target.value })}
                  style={{ flex: 1, minWidth: 220 }}
                />
                {draft.duplicate && (
                  <Tag color="warning" variant="filled">
                    疑似重复
                  </Tag>
                )}
              </Flex>
              <Flex gap="small" align="center" wrap>
                <Select
                  value={draft.ownerId}
                  options={ownerOptions}
                  onChange={(value: string) => change(draft.id, { ownerId: value })}
                  style={{ minWidth: 140 }}
                />
                <Select
                  value={draft.priority}
                  options={priorityOptions}
                  onChange={(value: Draft["priority"]) => change(draft.id, { priority: value })}
                />
                <DatePicker
                  value={draft.dueDate ? dayjs(draft.dueDate) : null}
                  onChange={(value) => change(draft.id, { dueDate: value ? value.format("YYYY-MM-DD") : null })}
                  format="YYYY-MM-DD"
                  placeholder="截止日期"
                />
              </Flex>
              <Typography.Text type="secondary">发送人：{draft.sender || "未识别"}</Typography.Text>
            </Flex>
          )}
        />
      )}
    </Space>
  );
}

export function FilesPage(): React.ReactElement {
  const [files, setFiles] = useState<ImportantFile[]>([]);
  const [name, setName] = useState("");
  const [filePath, setFilePath] = useState("");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = (): void => {
    setError("");
    void getFiles(search, filter)
      .then(setFiles)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "文件加载失败"));
  };
  useEffect(load, []);
  const categories = useMemo(() => [...new Set(files.map((file) => file.category).filter(Boolean))], [files]);
  const filterOptions = useMemo(
    () => [{ value: "", label: "全部" }, ...categories.map((item) => ({ value: item, label: `#${item}` }))],
    [categories],
  );
  const copy = (file: ImportantFile): void => {
    if (!navigator.clipboard) {
      window.prompt("请复制以下路径", file.filePath);
      return;
    }
    void navigator.clipboard
      .writeText(file.filePath)
      .then(() => markFileUsed(file.id))
      .then((updated) => setFiles((items) => items.map((item) => (item.id === updated.id ? updated : item))))
      .catch(() => window.prompt("请复制以下路径", file.filePath));
  };
  const remove = (file: ImportantFile): void => {
    void deleteFile(file.id).then(() => setFiles((items) => items.filter((item) => item.id !== file.id)));
  };
  const columns: TableProps<ImportantFile>["columns"] = [
    {
      title: "文件",
      dataIndex: "name",
      key: "name",
      render: (_value, file) => (
        <Flex vertical gap={2}>
          <Typography.Text strong>{file.name}</Typography.Text>
          <Typography.Text type="secondary">
            {file.category ? `[${file.category}] ` : ""}
            {file.filePath}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: "最近使用",
      dataIndex: "lastUsedAt",
      key: "lastUsedAt",
      render: (_value, file) => (
        <Typography.Text type="secondary">{file.lastUsedAt ? new Date(file.lastUsedAt).toLocaleString() : "尚未记录"}</Typography.Text>
      ),
    },
    {
      title: "操作",
      key: "actions",
      render: (_value, file) => (
        <Space size="small">
          <Button icon={<CopyOutlined />} onClick={() => copy(file)}>
            复制路径
          </Button>
          <Popconfirm title="确定删除文件索引吗？" okText="确定" cancelText="取消" onConfirm={() => remove(file)}>
            <Button danger variant="text" icon={<DeleteOutlined />} aria-label="删除文件索引" />
          </Popconfirm>
        </Space>
      ),
    },
  ];
  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <Space align="center" className="page-head" size="middle">
        <div>
          <Typography.Title level={3} className="page-title">
            重要文件
          </Typography.Title>
          <Typography.Text type="secondary">只保存本机或共享盘路径索引，不上传文件内容。</Typography.Text>
        </div>
        <Flex gap="small" wrap>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索名称或路径"
            style={{ maxWidth: 280 }}
            allowClear
          />
          <Button icon={<SearchOutlined />} onClick={load}>
            搜索
          </Button>
        </Flex>
      </Space>

      <Form
        layout="inline"
        onFinish={() => {
          if (!name.trim() || !filePath.trim() || busy) return;
          setBusy(true);
          void createFile({ name: name.trim(), filePath: filePath.trim(), category })
            .then((file) => {
              setFiles((items) => [file, ...items]);
              setName("");
              setFilePath("");
              setCategory("");
            })
            .catch((err: unknown) => setError(err instanceof Error ? err.message : "添加失败"))
            .finally(() => setBusy(false));
        }}
      >
        <Form.Item>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="文件名称" />
        </Form.Item>
        <Form.Item>
          <Input value={filePath} onChange={(event) => setFilePath(event.target.value)} placeholder="文件路径" />
        </Form.Item>
        <Form.Item>
          <Input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="分类" />
        </Form.Item>
        <Form.Item>
          <Button color="primary" variant="solid" htmlType="submit" icon={<PlusOutlined />} disabled={busy} loading={busy}>
            {busy ? "保存中…" : "添加"}
          </Button>
        </Form.Item>
      </Form>

      {categories.length > 0 && <Segmented value={filter} options={filterOptions} onChange={(value) => setFilter(String(value))} />}

      {error && (
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
      )}

      <Table<ImportantFile>
        rowKey="id"
        columns={columns}
        dataSource={files}
        pagination={false}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Space orientation="vertical" size={2}>
                  <Typography.Text strong>暂无已登记文件</Typography.Text>
                  <Typography.Text type="secondary">添加报价单、客户资料或模板路径。</Typography.Text>
                </Space>
              }
            />
          ),
        }}
      />
    </Space>
  );
}

export function CollaborationPage(): React.ReactElement {
  const [users, setUsers] = useState<Collaborator[]>([]);
  const [currentUser, setCurrentUser] = useState<{ id: string; name: string; role: UserRole } | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"assistant" | "viewer">("assistant");
  const [token, setToken] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [accessInfo, setAccessInfo] = useState<AccessInfo | null>(null);
  const [accessLoading, setAccessLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = (): void => {
    setError("");
    setNotice("");
    setAccessLoading(true);
    void getMe()
      .then(async ({ user }) => {
        setCurrentUser(user);
        if (user.role !== "owner") {
          setUsers([]);
          setAccessInfo(null);
          setError(`当前登录身份为${roleLabel[user.role]}，只有主人可以管理成员。`);
          return;
        }
        const [members, access] = await Promise.all([getUsers(), getAccessInfo()]);
        setUsers(members);
        setAccessInfo(access);
      })
      .catch((reason: unknown) => {
        setCurrentUser(null);
        setError(reason instanceof Error ? reason.message : "无法读取当前账户，请使用主人令牌重新登录。");
      })
      .finally(() => setAccessLoading(false));
  };

  useEffect(load, []);

  const copy = (value: string, label: string): void => {
    const fallback = (): void => {
      window.prompt(`请复制${label}`, value);
    };
    if (!navigator.clipboard) {
      fallback();
      return;
    }
    void navigator.clipboard
      .writeText(value)
      .then(() => setNotice(`${label}已复制`))
      .catch(fallback);
  };

  const logoutForOwner = (): void => {
    setBusy(true);
    void logout().finally(() => window.location.assign("/"));
  };

  const create = (): void => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    void createUser({ name: name.trim(), role })
      .then((result) => {
        setUsers((items) => [...items, result.user]);
        setToken(result.token);
        setName("");
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "新增成员失败"))
      .finally(() => setBusy(false));
  };

  const toggleMember = (user: Collaborator): void => {
    setBusy(true);
    setError("");
    void updateUser(user.id, !user.isActive)
      .then(() => {
        setUsers((items) => items.map((item) => (item.id === user.id ? { ...item, isActive: !item.isActive } : item)));
        setNotice(`${user.name}已${user.isActive ? "停用" : "启用"}`);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "成员状态更新失败"))
      .finally(() => setBusy(false));
  };

  const rotateToken = (user: Collaborator): void => {
    setBusy(true);
    setError("");
    setNotice("");
    void rotateUserToken(user.id)
      .then((result) => setToken(result.token))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "令牌生成失败"))
      .finally(() => setBusy(false));
  };

  const memberColumns: TableProps<Collaborator>["columns"] = [
    {
      title: "成员",
      dataIndex: "name",
      key: "name",
      render: (_value, user) => <Typography.Text strong>{user.name}</Typography.Text>,
    },
    {
      title: "角色",
      dataIndex: "role",
      key: "role",
      render: (_value, user) => roleLabel[user.role],
    },
    {
      title: "状态",
      dataIndex: "isActive",
      key: "isActive",
      render: (_value, user) => (
        <Tag color={user.isActive ? "green" : "default"} variant="filled">
          {user.isActive ? "启用中" : "已停用"}
        </Tag>
      ),
    },
    {
      title: "操作",
      key: "actions",
      render: (_value, user) =>
        user.role === "owner" ? null : (
          <Space size="small">
            <Popconfirm
              title={`${user.isActive ? "停用" : "启用"}${user.name}？`}
              okText="确定"
              cancelText="取消"
              onConfirm={() => toggleMember(user)}
            >
              <Button disabled={busy}>{user.isActive ? "停用" : "启用"}</Button>
            </Popconfirm>
            <Popconfirm
              title={`重新生成 ${user.name} 的令牌会使旧令牌失效，继续吗？`}
              okText="确定"
              cancelText="取消"
              onConfirm={() => rotateToken(user)}
            >
              <Button disabled={busy || !user.isActive}>重发令牌</Button>
            </Popconfirm>
          </Space>
        ),
    },
  ];

  if (accessLoading)
    return (
      <Space orientation="vertical" align="center" size="middle" className="page-stack">
        <Spin />
        <Typography.Text type="secondary">正在检查协作管理权限…</Typography.Text>
      </Space>
    );

  if (!currentUser || currentUser.role !== "owner") {
    return (
      <Space orientation="vertical" size="large" className="page-stack">
        <div>
          <Typography.Title level={3} className="page-title">
            协作管理
          </Typography.Title>
        </div>
        <Alert
          type="error"
          showIcon
          title="当前账户没有成员管理权限"
          description={error || "请退出当前账户，并使用主人令牌重新登录。"}
          action={
            <Button disabled={busy} onClick={logoutForOwner}>
              退出并重新登录
            </Button>
          }
        />
      </Space>
    );
  }

  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <div>
        <Typography.Title level={3} className="page-title">
          协作管理
        </Typography.Title>
        <Typography.Text type="secondary">停用成员会立即让会话和长期令牌失效；启用后请重新生成令牌。</Typography.Text>
      </div>

      {error && (
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
      )}
      {notice && <Alert type="info" showIcon title={notice} />}

      <Form
        layout="inline"
        onFinish={() => {
          create();
        }}
      >
        <Form.Item>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="成员名称" />
        </Form.Item>
        <Form.Item>
          <Select
            value={role}
            onChange={(value: "assistant" | "viewer") => setRole(value)}
            options={[
              { value: "assistant", label: "助理" },
              { value: "viewer", label: "查看者" },
            ]}
          />
        </Form.Item>
        <Form.Item>
          <Button color="primary" variant="solid" htmlType="submit" icon={<PlusOutlined />} disabled={!name.trim() || busy} loading={busy}>
            {busy ? "创建中…" : "新增成员"}
          </Button>
        </Form.Item>
      </Form>

      <Card variant="outlined" title="助理访问地址">
        <Space orientation="vertical" size="small" className="list-block">
          {accessInfo?.lanUrls.length ? (
            accessInfo.lanUrls.map((url) => (
              <Flex key={url} align="center" justify="space-between" gap="small" wrap>
                <Typography.Text code>{url}</Typography.Text>
                <Button icon={<CopyOutlined />} onClick={() => copy(url, "访问地址")}>
                  复制
                </Button>
              </Flex>
            ))
          ) : (
            <Typography.Text type="secondary">
              未检测到局域网地址，请确认正式服务使用 <Typography.Text code>HOST=0.0.0.0</Typography.Text> 启动。
            </Typography.Text>
          )}
          <Typography.Text>
            {accessInfo?.warning ?? "仅允许同一局域网的助理访问；不要发送 127.0.0.1、0.0.0.0 或带令牌的链接。"}
          </Typography.Text>
        </Space>
      </Card>

      {token && (
        <Card variant="outlined" title="长期令牌（仅显示一次）">
          <Space orientation="vertical" size="small" className="list-block">
            <Typography.Text code style={{ wordBreak: "break-all" }}>
              {token}
            </Typography.Text>
            <Space size="small">
              <Button icon={<CopyOutlined />} onClick={() => copy(token, "长期令牌")}>
                复制令牌
              </Button>
              <Button icon={<CheckOutlined />} onClick={() => setToken(null)}>
                已安全保存
              </Button>
            </Space>
          </Space>
        </Card>
      )}

      <Table<Collaborator> rowKey="id" columns={memberColumns} dataSource={users} pagination={false} />
    </Space>
  );
}

export function ReviewPage(): React.ReactElement {
  const [data, setData] = useState<ReviewData | null>(null);
  const [members, setMembers] = useState<Collaborator[]>([]);
  const [range, setRange] = useState("month");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const load = (): void => {
    const end = new Date();
    const start = new Date();
    if (range === "week") start.setDate(end.getDate() - 7);
    if (range === "month") start.setDate(end.getDate() - 30);
    const filters = {
      from: range === "custom" ? from : range === "all" ? "" : formatDate(start),
      to: range === "custom" ? to : range === "all" ? "" : formatDate(end),
      ownerId,
      status,
    };
    setError("");
    void getReview(filters)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "加载统计失败"));
  };
  useEffect(() => {
    void getUsers()
      .then(setMembers)
      .catch(() => setMembers([]));
  }, []);
  useEffect(load, [range, ownerId, status]);
  const ownerOptions = useMemo(
    () => [
      { value: "", label: "全部负责人" },
      { value: "unassigned", label: "未分配" },
      ...members.filter((member) => member.role !== "viewer").map((member) => ({ value: member.id, label: member.name })),
    ],
    [members],
  );
  const taskColumns: TableProps<Task>["columns"] = [
    {
      title: "任务",
      dataIndex: "title",
      key: "title",
      render: (_value, task) => <Typography.Text>{task.title}</Typography.Text>,
    },
    {
      title: "负责人",
      dataIndex: "ownerName",
      key: "ownerName",
      render: (_value, task) => task.ownerName ?? "未分配",
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      render: (_value, task) => labelsFor(task.status),
    },
    {
      title: "进度",
      dataIndex: "progress",
      key: "progress",
      render: (_value, task) => `${task.progress}%`,
    },
  ];
  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <Space align="center" className="page-head" size="middle">
        <div>
          <Typography.Title level={3} className="page-title">
            回顾统计
          </Typography.Title>
        </div>
        <Button icon={<ReloadOutlined />} onClick={load}>
          刷新
        </Button>
      </Space>

      <Flex gap="small" align="center" wrap>
        <Select
          value={range}
          onChange={(value: string) => setRange(value)}
          options={[
            { value: "week", label: "最近 7 天" },
            { value: "month", label: "最近 30 天" },
            { value: "all", label: "全部时间" },
            { value: "custom", label: "自定义范围" },
          ]}
          style={{ minWidth: 140 }}
        />
        {range === "custom" && (
          <>
            <DatePicker
              value={from ? dayjs(from) : null}
              onChange={(value) => setFrom(value ? value.format("YYYY-MM-DD") : "")}
              format="YYYY-MM-DD"
            />
            <DatePicker
              value={to ? dayjs(to) : null}
              onChange={(value) => setTo(value ? value.format("YYYY-MM-DD") : "")}
              format="YYYY-MM-DD"
            />
          </>
        )}
        <Select value={ownerId} onChange={(value: string) => setOwnerId(value)} options={ownerOptions} style={{ minWidth: 150 }} />
        <Select
          value={status}
          onChange={(value: string) => setStatus(value)}
          options={[
            { value: "", label: "全部状态" },
            { value: "todo", label: "待办" },
            { value: "in_progress", label: "进行中" },
            { value: "pending_review", label: "待验收" },
            { value: "completed", label: "已完成" },
          ]}
          style={{ minWidth: 140 }}
        />
      </Flex>

      {error && (
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
      )}

      {data && (
        <>
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={8}>
              <Card variant="outlined">
                <Statistic title="完成率" value={data.summary.completionRate} suffix="%" />
              </Card>
            </Col>
            <Col xs={24} sm={8}>
              <Card variant="outlined">
                <Statistic title="逾期" value={data.summary.overdue} />
              </Card>
            </Col>
            <Col xs={24} sm={8}>
              <Card variant="outlined">
                <Statistic title="待验收" value={data.tasks.filter((task) => task.status === "pending_review").length} />
              </Card>
            </Col>
          </Row>

          <Card title="任务明细" variant="outlined" className="fill-card">
            <Table<Task>
              rowKey="id"
              columns={taskColumns}
              dataSource={data.tasks}
              pagination={false}
              locale={{ emptyText: "当前条件下没有任务。" }}
            />
          </Card>
        </>
      )}
    </Space>
  );
}

export function AccessPage({ onLogout }: { onLogout: () => void }): React.ReactElement {
  return (
    <Space orientation="vertical" size="large" className="page-stack">
      <div>
        <Typography.Title level={3} className="page-title">
          访问验证
        </Typography.Title>
        <Typography.Text type="secondary">当前浏览器已通过 Cookie 会话验证。</Typography.Text>
      </div>
      <Button onClick={() => void logout().then(onLogout)}>退出当前账户</Button>
    </Space>
  );
}

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
function labelsFor(status: Task["status"]): string {
  return { todo: "待办", in_progress: "进行中", pending_review: "待验收", completed: "已完成" }[status];
}

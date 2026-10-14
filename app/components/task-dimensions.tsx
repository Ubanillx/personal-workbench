import { useEffect, useState } from "react";
import type React from "react";
import { useFetcher } from "react-router";
import { Alert, App as AntdApp, Button, Checkbox, Drawer, Empty, Flex, Form, Input, Select, Space, Tag, Typography } from "antd";
import { SettingOutlined } from "@ant-design/icons";
import { FormDrawer } from "./crud-drawer";
import { confirmDanger, IconActionButton } from "./crud-actions";
import { useCrudFeedback } from "./crud-hooks";
import type { PersonalTaskState, TaskDimension } from "../lib/task-dimensions.server";

type Feedback = { ok: true; notice: string } | { error: string };

export function PersonalTaskControls({
  taskId,
  title,
  state,
  dimensions,
  mode = "all",
}: {
  taskId: string;
  title: string;
  state: PersonalTaskState;
  dimensions: TaskDimension[];
  mode?: "all" | "summary" | "dimension";
}): React.ReactElement {
  const fetcher = useFetcher<Feedback>();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ dimensionIds: string[] }>();
  const { error } = useCrudFeedback(fetcher.data, () => setOpen(false));
  const busy = fetcher.state !== "idle";
  const post = (body: Record<string, unknown>): void => {
    void fetcher.submit({ intent: "personal-task", taskId, ...body }, { method: "post", action: "/tasks", encType: "application/json" });
  };
  return (
    <>
      <Flex align="center" gap="small" wrap>
        {mode !== "dimension" ? (
          <Checkbox
            aria-label={`本人已处理：${title}`}
            checked={state.handled}
            disabled={busy}
            onChange={(event) => post({ handled: event.target.checked })}
          >
            本人已处理
          </Checkbox>
        ) : null}
        {mode !== "dimension"
          ? dimensions.filter((item) => state.dimensionIds.includes(item.id)).map((item) => <Tag key={item.id}>{item.name}</Tag>)
          : null}
        {mode !== "summary" ? (
          <IconActionButton label="设置维度" icon={<SettingOutlined />} disabled={busy} onClick={() => setOpen(true)} />
        ) : null}
      </Flex>
      {error && !open ? <Alert type="error" showIcon title={error} /> : null}
      <FormDrawer
        open={open}
        title={`设置个人维度：${title}`}
        form={form}
        submitting={busy}
        error={error}
        width={480}
        formKey={taskId}
        initialValues={{ dimensionIds: state.dimensionIds }}
        onCancel={() => setOpen(false)}
        onFinish={(values) => post({ dimensionIds: values.dimensionIds ?? [] })}
      >
        <Form.Item name="dimensionIds" label="个人任务维度" extra="可选多个；清空后进入未分类，不改变他人的分类。">
          <Select
            mode="multiple"
            allowClear
            showSearch={{ optionFilterProp: "label" }}
            options={dimensions.map((item) => ({ value: item.id, label: item.name }))}
            placeholder="暂不分类"
          />
        </Form.Item>
      </FormDrawer>
    </>
  );
}

function DimensionRow({ dimension }: { dimension: TaskDimension }): React.ReactElement {
  const fetcher = useFetcher<Feedback>();
  const { modal } = AntdApp.useApp();
  const [name, setName] = useState(dimension.name);
  useEffect(() => setName(dimension.name), [dimension.name]);
  const { error } = useCrudFeedback(fetcher.data);
  const busy = fetcher.state !== "idle";
  const post = (intent: string): void => {
    void fetcher.submit({ intent, dimensionId: dimension.id, name }, { method: "post", action: "/tasks", encType: "application/json" });
  };
  return (
    <Flex vertical gap="small">
      <Flex gap="small" wrap>
        <Input
          aria-label={`维度名称：${dimension.name}`}
          value={name}
          maxLength={40}
          style={{ flex: 1, minWidth: 150 }}
          onChange={(event) => setName(event.target.value)}
        />
        <Button disabled={busy || !name.trim() || name.trim() === dimension.name} onClick={() => post("dimension-update")}>
          改名
        </Button>
        <Button
          color="danger"
          variant="outlined"
          disabled={busy}
          onClick={() =>
            confirmDanger(modal, {
              title: `删除维度「${dimension.name}」？`,
              content: "只移除该维度的关联，不删除任务、不影响其他维度和本人已处理标记。没有其他维度的任务将进入未分类。",
              okText: "删除维度",
              onOk: () => post("dimension-delete"),
            })
          }
        >
          删除
        </Button>
      </Flex>
      {error ? <Alert type="error" showIcon title={error} /> : null}
    </Flex>
  );
}

export function TaskDimensionManager({
  open,
  onClose,
  dimensions,
}: {
  open: boolean;
  onClose: () => void;
  dimensions: TaskDimension[];
}): React.ReactElement {
  const fetcher = useFetcher<Feedback>();
  const [form] = Form.useForm<{ name: string }>();
  const { error } = useCrudFeedback(fetcher.data, () => form.resetFields());
  return (
    <Drawer open={open} onClose={onClose} title="管理个人维度" size={520}>
      <Flex vertical gap="large">
        <Typography.Text type="secondary">
          维度和归类仅供本人使用。同一任务可加入多个维度，勾选“本人已处理”在各处同步，不改变任务进度或验收状态。
        </Typography.Text>
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) =>
            void fetcher.submit(
              { intent: "dimension-create", name: values.name },
              { method: "post", action: "/tasks", encType: "application/json" },
            )
          }
        >
          <Form.Item
            name="name"
            label="新建维度"
            rules={[
              { required: true, whitespace: true, message: "请输入维度名称" },
              { max: 40, message: "最多 40 个字符" },
            ]}
          >
            <Input maxLength={40} placeholder="例如：JJA、本周重点、验货申请" />
          </Form.Item>
          <Space>
            <Button htmlType="submit" color="primary" variant="solid" loading={fetcher.state !== "idle"}>
              新建维度
            </Button>
          </Space>
          {error ? <Alert type="error" showIcon title={error} /> : null}
        </Form>
        {dimensions.length ? (
          dimensions.map((dimension) => <DimensionRow key={dimension.id} dimension={dimension} />)
        ) : (
          <Empty description="尚未创建个人维度" />
        )}
      </Flex>
    </Drawer>
  );
}

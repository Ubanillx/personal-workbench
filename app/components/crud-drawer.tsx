import type React from "react";
import { useEffect, useRef } from "react";
import { Alert, Button, Drawer, Flex, Form, type FormInstance } from "antd";

/**
 * 表单抽屉（新建 / 编辑共用）：中后台 CRUD 的标准录入方式。
 *
 * 约定：
 * - 表单放在**右侧抽屉**里，不再用居中弹窗：既不遮挡列表、能一边对照上下文一边录入，视觉上也更轻；
 * - `destroyOnHidden` + `formKey` 让每次打开都重新挂载表单，避免残留上一条记录的 DOM 与校验状态；
 * - **打开时显式回填**：antd / rc-form 的 `initialValues` 只在 Form 首次挂载时并入 store，
 *   并且会与 store 里的旧值深合并（旧值优先）。因此「编辑 A → 关闭 → 编辑 B」时，
 *   单靠 `initialValues` 无法把表单换成 B 的数据（甚至会被上一条记录的值覆盖），
 *   必须在每次打开时 `resetFields()` 一次，让表单严格等于当前 `initialValues`。
 * - 提交时 `onFinish` 交给页面 action，`submitting` 映射到确认按钮的 loading，屏蔽重复提交；
 * - 校验失败由 antd Form 自行提示；**服务端失败（`error`）直接显示在抽屉顶部**，
 *   因为失败时抽屉仍然打开，把提示放在抽屉里用户才看得到（页面级 Alert 留给列表操作）。
 */
export function FormDrawer<Values extends object>({
  open,
  title,
  form,
  onCancel,
  onFinish,
  submitting,
  okText,
  cancelText,
  width,
  initialValues,
  formKey,
  disabled,
  error,
  afterForm,
  children,
}: {
  open: boolean;
  title: React.ReactNode;
  form: FormInstance<Values>;
  onCancel: () => void;
  onFinish: (values: Values) => void;
  submitting?: boolean;
  okText?: string;
  cancelText?: string;
  /** 抽屉宽度（px），默认 560 */
  width?: number;
  initialValues?: Partial<Values>;
  /** 改变它可强制表单重建（例如切到另一条记录），保证 initialValues 生效 */
  formKey?: string;
  disabled?: boolean;
  /** 上一次提交的服务端错误（页面的 actionData.error） */
  error?: string;
  /**
   * 表单**之外**、抽屉**之内**的附加内容（例如任务编辑抽屉里的「状态与进度」面板）。
   * 刻意放在 `<Form>` 外面：`ProgressReporter` 这类自带 `<Form>` 的控件嵌进去会形成
   * 表单套表单（HTML 非法、提交语义也会串），而且它们的按钮不该触发本表单的保存。
   */
  afterForm?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  const busy = Boolean(submitting);

  // initialValues 每次渲染都是新对象，不能直接进 effect 依赖（否则父组件每次重渲染都会覆盖用户的输入）。
  // 用 ref 保存最新值，回填只在「打开」或「切换记录（formKey 变化）」时各发生一次。
  const latestInitialValues = useRef(initialValues);
  latestInitialValues.current = initialValues;
  useEffect(() => {
    if (!open) return;
    // resetFields 按 Form 当前登记的 initialValues 重建 store（同时清掉 touched / errors），
    // 再补一次 setFieldsValue 兜底，保证任何时序下打开都能看到当前记录的值。
    form.resetFields();
    const values = latestInitialValues.current;
    if (values) form.setFieldsValue(values as Values);
    // 只随「打开 / 切换记录」回填；form、initialValues 的引用每次渲染都会变，不纳入依赖
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open, formKey]);

  return (
    <Drawer
      open={open}
      title={title}
      placement="right"
      size={width ?? 560}
      destroyOnHidden
      mask={{ closable: false }}
      onClose={onCancel}
      footer={
        <Flex justify="flex-end" gap="small">
          <Button onClick={onCancel}>{cancelText ?? "取消"}</Button>
          <Button color="primary" variant="solid" loading={busy} onClick={() => form.submit()}>
            {okText ?? "保存"}
          </Button>
        </Flex>
      }
    >
      {error ? <Alert className="form-drawer-alert" type="error" showIcon title={error} /> : null}
      <Form<Values>
        key={formKey}
        form={form}
        layout="vertical"
        onFinish={onFinish}
        disabled={disabled || busy}
        requiredMark
        scrollToFirstError={{ focus: true }}
        {...(initialValues === undefined ? {} : { initialValues })}
      >
        {children}
      </Form>
      {afterForm}
    </Drawer>
  );
}

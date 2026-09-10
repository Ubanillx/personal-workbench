import type React from "react";
import { Alert, Form, Modal, type FormInstance } from "antd";

/**
 * 表单弹窗（新建 / 编辑共用）：中后台 CRUD 的标准录入方式。
 *
 * 约定：
 * - 表单永远放在弹窗里，页面上不再常驻「裸表单」，避免列表被录入区挤压；
 * - `destroyOnHidden` + `clearOnDestroy` + `formKey` 让每次打开都重新挂载表单并套用最新 `initialValues`；
 * - 提交时 `onFinish` 交给页面 action，`submitting` 映射到 `confirmLoading`，屏蔽重复提交；
 * - 校验失败由 antd Form 自行提示；**服务端失败（`error`）直接显示在弹窗顶部**，
 *   因为失败时弹窗仍然打开，把提示放在弹窗里用户才看得到（页面级 Alert 留给列表操作）。
 */
export function FormModal<Values extends object>({
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
  width?: number;
  initialValues?: Partial<Values>;
  /** 改变它可强制表单重建（例如切到另一条记录），保证 initialValues 生效 */
  formKey?: string;
  disabled?: boolean;
  /** 上一次提交的服务端错误（页面的 actionData.error） */
  error?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const busy = Boolean(submitting);
  return (
    <Modal
      open={open}
      title={title}
      width={width ?? 560}
      okText={okText ?? "保存"}
      cancelText={cancelText ?? "取消"}
      confirmLoading={busy}
      mask={{ closable: false }}
      destroyOnHidden
      onOk={() => form.submit()}
      onCancel={onCancel}
    >
      {error ? <Alert className="form-modal-alert" type="error" showIcon title={error} /> : null}
      <Form<Values>
        form={form}
        layout="vertical"
        onFinish={onFinish}
        disabled={disabled || busy}
        requiredMark
        scrollToFirstError={{ focus: true }}
        // 弹窗关闭时会卸载表单：清空表单 store，保证下次打开重新套用 initialValues（不会残留上一条记录）
        clearOnDestroy
        {...(formKey === undefined ? {} : { key: formKey })}
        {...(initialValues === undefined ? {} : { initialValues })}
      >
        {children}
      </Form>
    </Modal>
  );
}

import { useEffect, useRef } from "react";
import { App as AntdApp } from "antd";
import { useSearchParams } from "react-router";

/** 页面 action 的统一信封：成功可带 `notice`（提示文案），失败一律是 `error` */
export type CrudEnvelope = { ok?: true; error?: string; notice?: string };

/**
 * 写操作反馈：**成功走全局提示 + 关闭弹窗，失败留给页面用 Alert 常驻展示**。
 *
 * 为什么失败不弹 toast：失败通常是「校验没过 / 没权限 / 跨组织」这类需要用户读完再改的
 * 信息，常驻 Alert 不会消失、还能带「重试」按钮；成功则是瞬时反馈，toast 更合适。
 * 依据 `actionData` 的对象标识去重，同一次提交只提示一次（含组件重挂载）。
 */
export function useCrudFeedback(actionData: unknown, onSuccess?: () => void): { error: string; notice: string } {
  const { message } = AntdApp.useApp();
  const handled = useRef<unknown>(null);
  const envelope = (actionData ?? null) as CrudEnvelope | null;
  const error = typeof envelope?.error === "string" ? envelope.error : "";
  const notice = typeof envelope?.notice === "string" ? envelope.notice : "";

  useEffect(() => {
    if (!envelope || handled.current === actionData) return;
    handled.current = actionData;
    if (error) return;
    void message.success(notice || "操作成功");
    onSuccess?.();
    // 只在 actionData 变化时触发：onSuccess / message 每次渲染都是新引用，纳入依赖会重复提示
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  return { error, notice };
}

/**
 * 列表筛选条件统一放在 URL 查询串里：可刷新、可分享、可回退，
 * 并且与 RR8 的 loader 天然同步（改参数即重跑 loader，页面不维护第二份筛选 state）。
 */
export function useListParams(): {
  params: URLSearchParams;
  get: (key: string, fallback?: string) => string;
  patch: (changes: Record<string, string | null>) => void;
  reset: () => void;
} {
  const [params, setParams] = useSearchParams();
  const patch = (changes: Record<string, string | null>): void => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };
  return {
    params,
    get: (key, fallback = "") => params.get(key) ?? fallback,
    patch,
    reset: () => setParams(new URLSearchParams(), { replace: true }),
  };
}

/**
 * 页面 action 的统一入参读取：antd Form 通过 RR8 的 useSubmit 以 JSON 提交，
 * 普通浏览器表单则是 form-urlencoded，两种都要支持。
 */
export async function readPayload(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      return (await request.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(await request.formData()) as Record<string, unknown>;
}

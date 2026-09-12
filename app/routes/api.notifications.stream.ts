import { appConfig } from "../lib/context.server";
import { db } from "../lib/db.server";
import { subscribeNotifications, type NotificationPayload } from "../lib/notifications.server";
import { requireAuth } from "../lib/session.server";
import { notifyOverdueTasks } from "../lib/tasks.server";

/** SSE 心跳间隔：穿插注释帧，避免浏览器/代理把空闲连接判死 */
const HEARTBEAT_MS = 25_000;
/** 逾期扫描间隔：常驻连接顺带承担扫描，不再只在页面刷新时才触发 */
const OVERDUE_SCAN_MS = 60_000;

/**
 * GET /api/notifications/stream —— 本人通知的实时推送（Server-Sent Events）。
 *
 * 选 SSE 而不是 WebSocket：通知是**单向**（服务端 → 浏览器），SSE 用原生 `EventSource`、
 * 断线自动重连、复用同源 HttpOnly 会话 Cookie，不需要额外协议、握手与心跳协议。
 *
 * 推送来源是进程内事件总线（`app/lib/notifications.server.ts`）：任何一次 HTTP 写入
 * 都会在同进程里发出事件，本连接按收件人过滤后立刻下发。
 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const auth = requireAuth(request, appConfig().sessionCookieName);
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;
  const encoder = new TextEncoder();

  /** 供 start 之外（stream.cancel）触发收尾 */
  let closeStream: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let finished = false;
      let stopSubscription: () => void = () => {};
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let scanner: ReturnType<typeof setInterval> | null = null;

      const finish = (): void => {
        if (finished) return;
        finished = true;
        stopSubscription();
        if (heartbeat) clearInterval(heartbeat);
        if (scanner) clearInterval(scanner);
        try {
          controller.close();
        } catch {
          // 客户端已取消连接时 controller 已关闭，重复 close 会抛错，忽略即可
        }
      };
      closeStream = finish;

      const send = (event: string, data: unknown): void => {
        if (finished) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          finish();
        }
      };

      stopSubscription = subscribeNotifications(userId, (payload: NotificationPayload) => send("notification", payload));
      heartbeat = setInterval(() => {
        if (finished) return;
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          finish();
        }
      }, HEARTBEAT_MS);
      scanner = setInterval(() => {
        try {
          notifyOverdueTasks(db());
        } catch {
          // 扫描失败不能拖垮已经建立的推送连接
        }
      }, OVERDUE_SCAN_MS);
      request.signal.addEventListener("abort", finish);

      // 首帧：让前端确认通道已建立，并触发一次未读列表重新同步
      send("ready", { at: new Date().toISOString() });
    },
    cancel() {
      closeStream?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // 反向代理（如 Nginx）默认会缓冲响应，显式关闭；本机直连时无影响
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}

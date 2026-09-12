import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Notification } from "../../shared/types/domain";
import { now, run, type Db } from "./db.server";

/**
 * 站内通知的写入与实时推送（唯一实现）。
 *
 * 实时链路：进程内 EventEmitter + SSE（`app/routes/api.notifications.stream.ts`）。
 * 本应用是**单进程**（react-router-serve 同时提供页面与 /api），
 * 因此一次 HTTP 写入产生的事件与挂在同一进程上的 SSE 连接天然在同一内存里，不需要 Redis 之类的跨进程总线。
 * 事件总线挂在 `globalThis` 上：Vite 开发模式热更新会重新执行模块，若每次新建总线，
 * 已经建立的 SSE 连接还挂在旧总线上，收不到新通知。
 *
 * 这里刻意把「落库」与「推送」绑在一起：所有通知创建点都走 `createNotification`，
 * 就不会出现「只有部分通知实时可达」的漂移。
 */

/** 落库前的输入：id / created_at / is_read 由本模块统一生成 */
export type NotificationInput = {
  recipientId: string;
  actorId?: string | null;
  taskId?: string | null;
  reportId?: string | null;
  eventType: string;
  title: string;
  message: string;
};

/** 推送载荷：在客户端视图上补收件人，SSE 按它过滤连接 */
export type NotificationPayload = Notification & { recipientId: string };

const BUS_EVENT = "notification";

const globalBus = globalThis as typeof globalThis & { __workbenchNotificationBus?: EventEmitter };

function bus(): EventEmitter {
  const existing = globalBus.__workbenchNotificationBus;
  if (existing) return existing;
  const created = new EventEmitter();
  // 每个打开的页面一条 SSE 连接，同一账号可能同时开多个标签页，监听器上限不能按默认的 10 算
  created.setMaxListeners(0);
  globalBus.__workbenchNotificationBus = created;
  return created;
}

/** 落库 + 推送：保证「刷新页面能看到」与「在线用户立刻收到」是同一份数据 */
export function createNotification(database: Db, input: NotificationInput): NotificationPayload {
  const payload: NotificationPayload = {
    id: randomUUID(),
    recipientId: input.recipientId,
    actorId: input.actorId ?? null,
    taskId: input.taskId ?? null,
    reportId: input.reportId ?? null,
    eventType: input.eventType,
    title: input.title,
    message: input.message,
    createdAt: now(),
  };
  run(
    database,
    "INSERT INTO notifications(id,recipient_id,actor_id,task_id,report_id,event_type,title,message,is_read,created_at,read_at) VALUES(?,?,?,?,?,?,?,?,0,?,NULL)",
    payload.id,
    payload.recipientId,
    payload.actorId,
    payload.taskId,
    payload.reportId,
    payload.eventType,
    payload.title,
    payload.message,
    payload.createdAt,
  );
  bus().emit(BUS_EVENT, payload);
  return payload;
}

/** 订阅某人的通知；返回取消订阅函数，SSE 连接关闭时必须调用，否则监听器会泄漏 */
export function subscribeNotifications(recipientId: string, listener: (payload: NotificationPayload) => void): () => void {
  const emitter = bus();
  const handler = (payload: NotificationPayload): void => {
    if (payload.recipientId === recipientId) listener(payload);
  };
  emitter.on(BUS_EVENT, handler);
  return () => emitter.off(BUS_EVENT, handler);
}

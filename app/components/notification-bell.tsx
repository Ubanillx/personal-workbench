import { useEffect, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "react-router";
import { App as AntdApp, Badge, Button, Drawer, Empty, Flex, Typography } from "antd";
import { BellOutlined, CheckOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import type { Notification } from "../../shared/types/domain";
import { brandLogoUrl } from "./brand-logo";

/**
 * 顶栏通知铃铛：点击后从右侧滑出**悬浮通知侧栏**（antd Drawer），配合 SSE 实时推送与浏览器桌面通知。
 *
 * 三条链路：
 * 1. 站内列表 —— 打开连接后服务端把新通知推来，直接合并进侧栏列表并刷新徽标；
 * 2. 页内提醒 —— 每条新通知用 antd `notification` 弹出可点击的提示（点击直达任务/周报）；
 * 3. 桌面通知 —— 浏览器授权后用 Web Notification 弹系统级通知；
 *    非安全上下文（局域网 http://192.168.x.x）浏览器禁用该 API，这里降级为只在页内提醒。
 *
 * 首次未读列表来自 root loader（SSR 直出），SSE 的 ready / open 会再拉一次做断线重连后的差量补齐。
 */

/** 桌面通知可用性：非安全上下文下 `Notification` 不可用，统一归为 unsupported */
type DesktopPermission = NotificationPermission | "unsupported";

function readDesktopPermission(): DesktopPermission {
  if (typeof window === "undefined" || !("Notification" in window) || !window.isSecureContext) return "unsupported";
  return Notification.permission;
}

/** 侧栏里的时间戳：库里存 ISO 串，展示成本地「月-日 时:分」 */
function formatTime(value: string): string {
  const at = dayjs(value);
  return at.isValid() ? at.format("MM-DD HH:mm") : "";
}

export function NotificationBell({ initial }: { initial: Notification[] }): ReactElement {
  const navigate = useNavigate();
  const { message, notification } = AntdApp.useApp();
  const [items, setItems] = useState<Notification[]>(initial);
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState<DesktopPermission>("unsupported");
  // 事件回调在 effect 里只订阅一次，用 ref 读取最新的权限与「打开通知」逻辑，避免反复重建 SSE 连接
  const permissionRef = useRef<DesktopPermission>("unsupported");
  const openRef = useRef<(item: Notification) => void>(() => {});

  const markRead = (body: Record<string, unknown>): void => {
    void fetch("/api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    }).catch(() => {
      // 标记已读失败不回滚界面：下次重新同步时会恢复一致的未读状态
    });
  };

  const openItem = (item: Notification): void => {
    setOpen(false);
    setItems((prev) => prev.filter((entry) => entry.id !== item.id));
    markRead({ ids: [item.id] });
    if (item.reportId) navigate("/reports");
    else if (item.taskId) navigate(`/tasks?task=${item.taskId}`);
  };

  // ref 只在提交后的 effect 里更新，不在渲染期间写 ref（react/refs 规则）
  useEffect(() => {
    openRef.current = openItem;
  });

  const readAll = (): void => {
    setItems([]);
    markRead({ all: true });
  };

  const requestDesktopPermission = async (): Promise<void> => {
    if (!("Notification" in window) || !window.isSecureContext) {
      setPermission("unsupported");
      message.warning("当前地址不支持桌面通知，请改用 http://127.0.0.1 或 HTTPS 访问");
      return;
    }
    const result = await Notification.requestPermission();
    setPermission(result);
    permissionRef.current = result;
    if (result === "granted") message.success("已开启桌面通知");
    else if (result === "denied") message.warning("桌面通知已被浏览器拒绝，可在地址栏站点设置里重新开启");
  };

  useEffect(() => {
    const current = readDesktopPermission();
    setPermission(current);
    permissionRef.current = current;
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/notifications/stream");

    const resync = async (): Promise<void> => {
      try {
        const response = await fetch("/api/notifications?unread=1", { credentials: "include" });
        if (!response.ok) return;
        const body = (await response.json()) as { data?: Notification[] };
        if (Array.isArray(body.data)) setItems(body.data);
      } catch {
        // 断线或服务未就绪：保留现有列表，EventSource 会自动重连
      }
    };

    const onNotification = (event: Event): void => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as Notification;
      setItems((prev) => [payload, ...prev.filter((entry) => entry.id !== payload.id)].slice(0, 100));
      notification.open({
        title: payload.title,
        description: payload.message,
        placement: "bottomRight",
        key: `notification-${payload.id}`,
        onClick: () => openRef.current(payload),
      });
      if (permissionRef.current === "granted") {
        const native = new Notification(payload.title, {
          body: payload.message,
          tag: payload.id,
          icon: brandLogoUrl,
          lang: "zh-CN",
        });
        native.onclick = () => {
          window.focus();
          openRef.current(payload);
          native.close();
        };
      }
    };

    source.addEventListener("notification", onNotification);
    source.addEventListener("ready", () => void resync());
    source.onopen = () => void resync();
    return () => {
      source.removeEventListener("notification", onNotification);
      source.close();
    };
  }, []);

  const footer =
    permission === "unsupported" ? (
      "当前地址不支持桌面通知，请用 127.0.0.1 或 HTTPS 打开"
    ) : permission === "granted" ? (
      "桌面通知已开启"
    ) : permission === "denied" ? (
      "桌面通知已被浏览器拒绝"
    ) : (
      <Button size="small" color="primary" variant="solid" icon={<BellOutlined />} onClick={() => void requestDesktopPermission()}>
        开启桌面通知
      </Button>
    );

  return (
    <>
      <Badge count={items.length} size="small" offset={[-2, 2]}>
        <Button color="default" variant="text" icon={<BellOutlined />} aria-label="通知" onClick={() => setOpen(true)} />
      </Badge>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        placement="right"
        size={360}
        title={items.length ? `通知（${items.length}）` : "通知"}
        extra={
          items.length ? (
            <Button size="small" color="default" variant="text" icon={<CheckOutlined />} onClick={readAll}>
              全部已读
            </Button>
          ) : null
        }
        footer={<div className="notification-footer">{footer}</div>}
      >
        {items.length ? (
          <Flex vertical className="notification-panel">
            {items.map((item) => (
              <button key={item.id} type="button" className="notification-item" onClick={() => openItem(item)}>
                <span className="notification-item-head">
                  <Typography.Text strong>{item.title}</Typography.Text>
                  <Typography.Text type="secondary" className="notification-message">
                    {formatTime(item.createdAt)}
                  </Typography.Text>
                </span>
                <Typography.Text type="secondary" className="notification-message">
                  {item.message}
                </Typography.Text>
              </button>
            ))}
          </Flex>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无未读通知" />
        )}
      </Drawer>
    </>
  );
}

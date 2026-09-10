import React, { Component, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App as AntdApp, Button, ConfigProvider, Result, type ThemeConfig } from "antd";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { App } from "./App";
import "./styles/global.css";
import "./styles/layout.css";

dayjs.locale("zh-cn");

/** 沿用旧版手写样式的品牌色（#185fa5），其余交给 antd 默认体系 */
const workbenchTheme: ThemeConfig = {
  token: {
    colorPrimary: "#185fa5",
    colorInfo: "#185fa5",
    borderRadius: 6,
    fontSize: 14,
    controlHeight: 34,
  },
  components: {
    Layout: { headerBg: "#ffffff", siderBg: "#ffffff", bodyBg: "#f5f7fa" },
    Menu: { itemBg: "transparent", itemSelectedBg: "#e7f1fb", itemSelectedColor: "#185fa5" },
  },
};

type AppErrorBoundaryState = { error: Error | null };

class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  public state: AppErrorBoundaryState = { error: null };

  public static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep browser diagnostics available without exposing implementation details in the UI.
    console.error("Personal Workbench rendering failed", error, info.componentStack);
  }

  public render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <Result
        status="error"
        title="工作台暂时无法显示"
        subTitle="页面加载时发生错误。请刷新后重试；若仍出现此页面，请联系主人检查正式服务。"
        extra={
          <Button color="primary" variant="solid" onClick={() => window.location.reload()}>
            刷新页面
          </Button>
        }
      />
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={workbenchTheme} componentSize="medium">
      {/* antd App 提供 message/notification/modal 的上下文实例，避免使用静态方法导致的主题与 locale 丢失 */}
      <AntdApp>
        <AppErrorBoundary>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AppErrorBoundary>
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);

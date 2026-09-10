import React, { Component, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./styles/global.css";

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
    return <main className="access-screen"><section className="access-panel"><div className="brand-mark">台</div><h1>工作台暂时无法显示</h1><p>页面加载时发生错误。请刷新后重试；若仍出现此页面，请联系主人检查正式服务。</p><button type="button" onClick={() => window.location.reload()}>刷新页面</button></section></main>;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AppErrorBoundary>
  </React.StrictMode>
);

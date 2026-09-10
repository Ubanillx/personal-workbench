/**
 * Phase 1 占位页：Phase 3 会把 web/ 的 antd 页面搬到 app/routes/ 下。
 */
export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>个人工作台 · 全栈迁移进行中</h1>
      <p>
        Phase 1 骨架：<code>GET /api/ping</code> 与 <code>GET /api/health</code> 已由 React Router 8 资源路由提供。
      </p>
      <p>旧实现仍在 17500 端口正常运行，Phase 4 才切换。</p>
    </main>
  );
}

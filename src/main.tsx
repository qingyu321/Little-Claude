import React from "react";
import ReactDOM from "react-dom/client";
// 全量样式（Tailwind）。必须在入口静态导入：异步引导把 App 拆成了独立 chunk，
// 若样式在 App 里动态加载，index.html 不会生成 <link rel="stylesheet">，
// 运行时注入在自定义协议下失败 → 页面无样式（一块一块的）。
import "./App.css";
import {
  ensureMigrated,
  seedFromDisk,
  installMirror,
  clearKeysFromDisk,
} from "./lib/persistent-storage";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught error:", error, info.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
  };

  handleClearAndReload = async () => {
    const keys = [
      "tokenicode-settings",
      "tokenicode_custom_previews",
      "tokenicode_pet_window_v1",
      "tokenicode_pet_skins_v1",
    ];
    try {
      for (const k of keys) localStorage.removeItem(k);
    } catch {
      // ignore
    }
    // 同步清磁盘快照后再 reload，否则 bootstrap 会把旧值从磁盘灌回，"清除"失效。
    try {
      await clearKeysFromDisk(keys);
    } catch {
      // ignore
    }
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
            color: "#333",
            padding: 32,
            textAlign: "center",
          }}
        >
          <h2 style={{ marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ color: "#888", fontSize: 14, marginBottom: 24, maxWidth: 480 }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={this.handleReload}
              style={{
                padding: "8px 20px",
                borderRadius: 10,
                border: "1px solid #ddd",
                background: "#fff",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              Retry
            </button>
            <button
              onClick={this.handleClearAndReload}
              style={{
                padding: "8px 20px",
                borderRadius: 10,
                border: "none",
                background: "#8B6CC5",
                color: "#fff",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              Clear data & Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * 异步引导：在渲染 App 前把 localStorage 从磁盘灌回（origin 变更免疫）。
 *
 * 顺序很关键：
 *   1. __migrate 短路 —— Rust 迁移用隐藏窗口会带 ?__migrate=1 加载本页，
 *      只作为读旧 origin localStorage 的载体，不能渲染、不能再触发迁移（防递归）。
 *   2. ensureMigrated —— 一次性把旧 origin(http://tauri.localhost) 的数据迁到磁盘。
 *   3. seedFromDisk  —— 读磁盘快照灌回当前 origin 的 localStorage。
 *   4. installMirror —— 之后运行时对 localStorage 的改动异步回写磁盘。
 *   5. 动态 import App 并渲染（store 在 App 依赖树里，灌盘后才初始化，读到正确值）。
 *
 * 非 Tauri 环境下 ensureMigrated/seedFromDisk/installMirror 全部 no-op，退回原生行为。
 */
async function bootstrap() {
  if (new URLSearchParams(window.location.search).has("__migrate")) {
    return;
  }

  try {
    await ensureMigrated();
    await seedFromDisk();
    installMirror();
  } catch (e) {
    console.error(
      "[bootstrap] persistent-storage init failed, falling back to plain localStorage:",
      e,
    );
  }

  const { default: App } = await import("./App");
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

bootstrap();

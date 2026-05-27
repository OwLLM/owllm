// ErrorBoundary — catches runtime errors anywhere below in the tree so
// the whole app doesn't render blank when one page throws. In release
// builds the Tauri webview has no devtools, so without this a broken
// component just leaves the user staring at the HybridFrame with no
// content and no error.

import React from "react";

type State = { error: Error | null; info: string | null };

export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, info: null };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ error, info: info.componentStack || null });
    // Also log to whatever console exists (Tauri devtools in dev).
    // eslint-disable-next-line no-console
    console.error("App crashed:", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        position: "fixed", inset: 0,
        zIndex: 2147483646,
        background: "#1a0e0e",
        color: "#ffdcdc",
        padding: 40,
        overflow: "auto",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        lineHeight: 1.5,
      }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#ff8080", marginBottom: 8 }}>
          ⚠ React render crash
        </div>
        <div style={{ color: "#fff", marginBottom: 16 }}>
          {this.state.error.message}
        </div>
        <button
          onClick={() => this.setState({ error: null, info: null })}
          style={{
            padding: "6px 14px",
            background: "rgba(var(--accent-rgb),0.2)",
            border: "1px solid rgba(var(--accent-rgb),0.5)",
            color: "white",
            borderRadius: 6,
            cursor: "pointer",
            marginBottom: 16,
          }}
        >Retry</button>
        <pre style={{
          background: "#0e0808",
          border: "1px solid #3a1a1a",
          borderRadius: 6,
          padding: 12,
          whiteSpace: "pre-wrap",
          color: "#ffb0b0",
          maxHeight: "60vh",
          overflow: "auto",
        }}>
{this.state.error.stack || "(no stack trace)"}

{this.state.info ?? ""}
        </pre>
      </div>
    );
  }
}

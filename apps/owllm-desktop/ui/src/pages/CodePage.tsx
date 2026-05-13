// CodePage — ported from LLM/desktop_app/pages/code_page.py
// (CodePage._build, line 217). The PySide6 version embeds a bundled
// VSCodium window inside the Qt host via Win32 SetParent reparenting.
// Tauri's webview can't reparent native windows; the React port shows
// the same header (workspace + model selector + launch button) and a
// "Launch VSCodium" CTA — clicking it will eventually invoke a Tauri
// command that spawns VSCodium externally pointed at the chosen
// workspace + Cline -> OWLLM proxy. For now the launch is a stub.
import React, { useState } from "react";

export default function CodePage() {
  const [workspace, setWorkspace] = useState<string>("C:/1_Git/LocaLLM");
  const [model, setModel] = useState<string>("owllm-active-model");
  const [status, setStatus] = useState<string>("Bundle ready. Click Launch / Re-embed.");

  return (
    <div style={{ padding: "12px 18px", height: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Header: workspace + Cline → model + Launch */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}>
        <div style={{ fontSize: 12, color: "#b0b0b0", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          Workspace: <span style={{ color: "#dadcdf", fontFamily: "Consolas, monospace" }}>{workspace}</span>
        </div>
        <button className="ghost-btn" style={{ height: 30 }}>📁 Browse</button>
        <div style={{ fontSize: 13, color: "#9aa0a6", fontWeight: 600 }}>Cline →</div>
        <select
          value={model}
          onChange={e => setModel(e.target.value)}
          style={{
            minWidth: 320, height: 32, padding: "0 10px",
            borderRadius: 6, border: "1px solid rgba(255,255,255,0.10)",
            background: "#0f0f19", color: "#fff", fontSize: 13,
          }}
        >
          <option value="owllm-active-model">OWLLM Active Model — auto-routes</option>
          <option value="default">default · Phi-4 · running</option>
          <option value="qwen-coder">Qwen2.5-Coder Q4 · running</option>
        </select>
        <button
          style={{
            height: 32, padding: "0 16px", borderRadius: 8,
            background: "linear-gradient(180deg, #4a6cff, #3a55cc)",
            color: "#fff", border: "none", fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Launch / Re-embed
        </button>
      </div>
      <div style={{ fontSize: 11, color: "#888" }}>{status}</div>

      {/* Host stack — where VSCodium would be embedded in PySide6.
          In the new app we show a launcher CTA instead. */}
      <div style={{
        flex: 1,
        background: "#06080d",
        border: "1px dashed rgba(127,223,255,0.18)",
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 40,
      }}>
        <div style={{ fontSize: 64, opacity: 0.4 }}>💻</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#dadcdf" }}>
          Bundled VSCodium with Cline
        </div>
        <div style={{ fontSize: 13, color: "#9aa0a6", maxWidth: 540, textAlign: "center", lineHeight: 1.6 }}>
          Opens a portable VSCodium pinned to your workspace, with the Cline
          extension pre-configured to route through OWLLM. Click an OWLLM
          model in the dropdown above to use it as Cline's backend.
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <button
            style={{
              height: 42, padding: "0 22px", borderRadius: 10,
              background: "linear-gradient(180deg, #4CAF50, #388E3C)",
              color: "#fff", border: "none", fontWeight: 700, fontSize: 14,
              cursor: "pointer",
            }}
          >
            ▶ Launch VSCodium
          </button>
          <button className="ghost-btn" style={{ height: 42, padding: "0 18px", fontSize: 13 }}>
            🔧 Setup Cline proxy
          </button>
        </div>
        <div style={{ fontSize: 11, color: "#7888a8", marginTop: 8 }}>
          First launch downloads VSCodium portable (~80 MB) from GitHub and
          installs Cline. Subsequent launches reuse the bundle.
        </div>
      </div>
    </div>
  );
}

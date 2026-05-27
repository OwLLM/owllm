// AccessTokensPane — right-rail panel on the Models tab.
//
// Two tabs:
//   ★ Access Tokens   — store / validate the HF read token. Adds a
//                        "Get token →" deep link that opens
//                        huggingface.co/settings/tokens in the user's
//                        default browser so they don't have to copy
//                        the URL out of help text.
//   Info               — when a card on the Models grid is selected,
//                        shows that model's name, params, size,
//                        downloads, compat, and a clickable link to
//                        its HF page. With no selection: a hint.
//
// Tokens are stored via accounts_set_huggingface_token and validated
// via accounts_probe_huggingface (real /whoami call against HF).

import React from "react";
import { invoke } from "@tauri-apps/api/core";

// Open URL in the OS default browser. Inside Tauri we go through the
// shell_open_url Rust command (which uses `cmd /c start ""`). Under
// vite dev we fall back to window.open so links still work.
async function openExternal(url: string) {
  try {
    await invoke("shell_open_url", { url });
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

type Tab = "tokens" | "info";
type SaveStatus = "idle" | "saving" | "saved" | "error";

export type SelectedModelInfo = {
  id: string;
  name: string;
  description: string;
  downloads: number;
  likes: number;
  lastModified: string | null;
  tags: string[];
  gated: boolean;
  paramsB: number | null;
  inferenceGb: number | null;
  loraTrainGb: number | null;
  compat: { color: "green" | "orange" | "red" | "gray"; text: string; tooltip: string } | null;
};

export type AccessTokensPaneProps = {
  initialToken?: string;
  onSaved?: (token: string) => void;
  /** Currently-selected model on the parent Models grid. When non-null,
   *  switches the Info tab into model-details mode. */
  selectedModel?: SelectedModelInfo | null;
};

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function AccessTokensPane(props: AccessTokensPaneProps) {
  const [tab, setTab] = React.useState<Tab>("tokens");
  const [token, setToken] = React.useState<string>(props.initialToken ?? "");
  const [status, setStatus] = React.useState<SaveStatus>("idle");
  const [errorMsg, setErrorMsg] = React.useState<string>("");
  const [probeResult, setProbeResult] = React.useState<string>("");

  // Auto-switch to Info when a model gets selected, so the user
  // sees what they just clicked without having to flip tabs.
  React.useEffect(() => {
    if (props.selectedModel) setTab("info");
  }, [props.selectedModel?.id]);

  React.useEffect(() => {
    if (props.initialToken !== undefined) return;
    (async () => {
      try {
        const s = await invoke<{ huggingfaceToken?: string }>("accounts_status");
        if (s.huggingfaceToken) setToken(s.huggingfaceToken);
      } catch { /* outside Tauri */ }
    })();
  }, [props.initialToken]);

  const save = async () => {
    setStatus("saving");
    setErrorMsg("");
    try {
      await invoke("accounts_set_huggingface_token", { token });
      setStatus("saved");
      props.onSaved?.(token);
      setTimeout(() => setStatus("idle"), 1500);
    } catch (e: unknown) {
      setStatus("error");
      setErrorMsg(String(e));
    }
  };

  const clear = async () => {
    setToken("");
    try {
      await invoke("accounts_set_huggingface_token", { token: "" });
      props.onSaved?.("");
    } catch { /* ignore */ }
  };

  const test = async () => {
    setProbeResult("Probing…");
    try {
      const ok = await invoke<boolean>("accounts_probe_huggingface", { token });
      setProbeResult(ok ? "✓ Token valid" : "✗ Invalid token");
    } catch (e: unknown) {
      setProbeResult(`✗ ${String(e)}`);
    }
  };

  const tabBtn = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "5px 10px",
    background: active ? "var(--bg-elevated)" : "transparent",
    color: active ? "var(--fg)" : "var(--fg-muted)",
    border: "1px solid var(--border-strong)",
    borderRadius: 4,
    fontSize: 11,
    cursor: "pointer",
    fontWeight: active ? 700 : 400,
  });

  const actionBtn: React.CSSProperties = {
    flex: 1,
    padding: "5px 0",
    background: "var(--bg-elevated)",
    color: "var(--fg)",
    border: "1px solid var(--border-strong)",
    borderRadius: 4,
    fontSize: 11,
    cursor: "pointer",
  };

  return (
    <div
      data-ui="AccessTokensPane"
      style={{
        padding: 10,
        background: "var(--bg-card)",
        border: "1px solid var(--border-strong)",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", gap: 4 }}>
        <button data-ui="accessTokensTab"     style={tabBtn(tab === "tokens")} onClick={() => setTab("tokens")}>★ Tokens</button>
        <button data-ui="accessTokensInfoTab" style={tabBtn(tab === "info")}   onClick={() => setTab("info")}>ℹ Info</button>
      </div>

      {tab === "tokens" ? <TokensTab
        token={token} setToken={setToken}
        save={save} clear={clear} test={test}
        status={status} errorMsg={errorMsg} probeResult={probeResult}
        actionBtn={actionBtn}
      /> : <InfoTab
        selectedModel={props.selectedModel ?? null}
      />}
    </div>
  );
}

function TokensTab(p: {
  token: string;
  setToken: (s: string) => void;
  save: () => void;
  clear: () => void;
  test: () => void;
  status: SaveStatus;
  errorMsg: string;
  probeResult: string;
  actionBtn: React.CSSProperties;
}) {
  return (
    <>
      <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.4 }}>
        A read-only token unlocks gated models (Llama, Gemma, some Mistral) and lifts anon rate limits. Public models work without it.
      </div>
      <button
        onClick={() => openExternal("https://huggingface.co/settings/tokens")}
        style={{
          padding: "6px 10px",
          background: "linear-gradient(180deg, var(--accent) 0%, var(--accent) 100%)",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 700,
          cursor: "pointer",
          boxShadow: "0 0 10px -4px var(--accent)88",
        }}
        title="Opens huggingface.co/settings/tokens in your browser. Create a READ token."
      >🚀 Get a token from Hugging Face →</button>
      <textarea
        placeholder="Paste your read token here (starts with hf_…)"
        value={p.token}
        onChange={(e) => p.setToken(e.target.value)}
        spellCheck={false}
        style={{
          minHeight: 60,
          padding: 6,
          background: "var(--bg-input)",
          border: "1px solid var(--border-strong)",
          borderRadius: 4,
          color: "var(--fg)",
          fontSize: 11,
          resize: "vertical",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        }}
      />
      <div style={{ display: "flex", gap: 4 }}>
        <button style={p.actionBtn} onClick={p.save} disabled={p.status === "saving"}>
          {p.status === "saving" ? "Saving…" : p.status === "saved" ? "✓ Saved" : "Save"}
        </button>
        <button style={p.actionBtn} onClick={p.clear}>Clear</button>
        <button style={p.actionBtn} onClick={p.test}>Test</button>
      </div>
      {p.errorMsg && <div style={{ fontSize: 10, color: "#f44336" }}>{p.errorMsg}</div>}
      {p.probeResult && (
        <div style={{ fontSize: 11, color: p.probeResult.startsWith("✓") ? "#4CAF50" : "#f44336" }}>
          {p.probeResult}
        </div>
      )}
      <div style={{ fontSize: 10, color: "var(--fg-muted)", lineHeight: 1.4, marginTop: 4 }}>
        Stored locally in the Owllm accounts store. Never sent anywhere except huggingface.co.
      </div>
    </>
  );
}

function InfoTab(p: { selectedModel: SelectedModelInfo | null }) {
  const m = p.selectedModel;
  if (!m) {
    return (
      <div style={{
        padding: 20,
        textAlign: "center",
        color: "var(--fg-muted)",
        fontSize: 12,
        lineHeight: 1.6,
      }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>👆</div>
        Click a model card on the left to see its details here.
      </div>
    );
  }

  const Row = (lbl: string, value: React.ReactNode) => (
    <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 6, fontSize: 11, lineHeight: 1.4 }}>
      <span style={{ color: "var(--fg-muted)" }}>{lbl}</span>
      <span style={{ color: "var(--fg)", wordBreak: "break-word" }}>{value}</span>
    </div>
  );

  const compatBgMap: Record<string, string> = {
    green: "#4CAF50", orange: "#FF9800", red: "#f44336", gray: "#888",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontWeight: 700, fontSize: 13, color: "var(--fg)", wordBreak: "break-word" }}>
        {m.name}
      </div>
      <div style={{ fontSize: 10, color: "var(--fg-muted)", wordBreak: "break-all" }}>{m.id}</div>

      {m.compat && (
        <span
          title={m.compat.tooltip}
          style={{
            alignSelf: "flex-start",
            background: compatBgMap[m.compat.color] ?? "#667eea",
            color: "white",
            padding: "3px 8px",
            borderRadius: 4,
            fontSize: 11,
            fontWeight: 700,
          }}
        >{m.compat.text}</span>
      )}

      {m.description && (
        <div style={{ fontSize: 12, color: "#d6d8de", lineHeight: 1.4 }}>{m.description}</div>
      )}

      <div style={{ borderTop: "1px solid var(--border-strong)", marginTop: 4, paddingTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
        {m.paramsB != null && Row("Params",     `${m.paramsB.toFixed(1)} B`)}
        {m.inferenceGb != null && Row("Inference", `≈${m.inferenceGb.toFixed(1)} GB VRAM (fp16)`)}
        {m.loraTrainGb != null && Row("LoRA train", `≈${m.loraTrainGb.toFixed(1)} GB VRAM`)}
        {Row("Downloads", fmtCount(m.downloads))}
        {Row("Likes",     fmtCount(m.likes))}
        {m.lastModified && Row("Updated", new Date(m.lastModified).toLocaleDateString())}
        {Row("Gated", m.gated ? "Yes — token required" : "No")}
        {m.tags.length > 0 && Row("Tags",
          <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {m.tags.slice(0, 6).map((t) => (
              <span key={t} style={{
                fontSize: 10, padding: "1px 6px",
                background: "var(--bg-elevated)", color: "#9cc3ff",
                borderRadius: 3,
              }}>{t}</span>
            ))}
          </span>
        )}
      </div>

      <button
        onClick={() => openExternal(`https://huggingface.co/${m.id}`)}
        style={{
          marginTop: 4,
          padding: "5px 0",
          background: "var(--bg-elevated)",
          color: "var(--fg)",
          border: "1px solid var(--border-strong)",
          borderRadius: 4,
          fontSize: 11,
          cursor: "pointer",
        }}
      >🔗 Open on huggingface.co</button>
    </div>
  );
}

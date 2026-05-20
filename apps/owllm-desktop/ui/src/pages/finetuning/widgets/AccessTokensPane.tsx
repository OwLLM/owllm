// AccessTokensPane — right-rail panel on the Models tab. Mirrors the Qt
// token UI (main.py `_build_models_tab`) but factored out so the same
// pane can be reused on the Train tab or any other surface that needs HF
// auth. Tabbed switch between "Access Tokens" and "Info" matches Qt.

import React from "react";
import { invoke } from "@tauri-apps/api/core";

type Tab = "tokens" | "info";

type SaveStatus = "idle" | "saving" | "saved" | "error";

export type AccessTokensPaneProps = {
  // Optional initial token if the parent already loaded one from the
  // accounts store; otherwise the pane fetches on mount.
  initialToken?: string;
  onSaved?: (token: string) => void;
};

export default function AccessTokensPane(props: AccessTokensPaneProps) {
  const [tab, setTab] = React.useState<Tab>("tokens");
  const [token, setToken] = React.useState<string>(props.initialToken ?? "");
  const [status, setStatus] = React.useState<SaveStatus>("idle");
  const [errorMsg, setErrorMsg] = React.useState<string>("");
  const [probeResult, setProbeResult] = React.useState<string>("");

  // Pull existing token from accounts.rs on mount. accountsStatus()
  // returns { huggingface_token: "..." } or empty.
  React.useEffect(() => {
    if (props.initialToken !== undefined) return;
    (async () => {
      try {
        const s = await invoke<{ huggingfaceToken?: string }>("accounts_status");
        if (s.huggingfaceToken) setToken(s.huggingfaceToken);
      } catch {
        // accounts cmd may not be available outside Tauri; silently ignore
      }
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
    } catch {
      // ignore
    }
  };

  const test = async () => {
    setProbeResult("Probing...");
    try {
      const ok = await invoke<boolean>("accounts_probe_huggingface", { token });
      setProbeResult(ok ? "✓ Token valid" : "✗ Invalid token");
    } catch (e: unknown) {
      setProbeResult(`✗ ${String(e)}`);
    }
  };

  const btn = (active: boolean): React.CSSProperties => ({
    padding: "4px 10px",
    background: active ? "#162033" : "transparent",
    color: active ? "var(--fg)" : "var(--fg-muted)",
    border: "1px solid #243044",
    borderRadius: 4,
    fontSize: 11,
    cursor: "pointer",
  });

  const actionBtn: React.CSSProperties = {
    flex: 1,
    padding: "5px 0",
    background: "#162033",
    color: "var(--fg)",
    border: "1px solid #243044",
    borderRadius: 4,
    fontSize: 11,
    cursor: "pointer",
  };

  return (
    <div
      data-ui="AccessTokensPane"
      style={{
        gridColumn: "3 / 4",
        gridRow: "1 / span 3",
        padding: 10,
        background: "#0e1320",
        border: "1px solid #1c2434",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", gap: 4 }}>
        <button data-ui="accessTokensTab" style={btn(tab === "tokens")} onClick={() => setTab("tokens")}>
          ★ Access Tokens
        </button>
        <button data-ui="accessTokensInfoTab" style={btn(tab === "info")} onClick={() => setTab("info")}>
          Info
        </button>
      </div>

      {tab === "tokens" ? (
        <>
          <textarea
            placeholder="Paste your Hugging Face access token here..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
            spellCheck={false}
            style={{
              minHeight: 72,
              padding: 6,
              background: "#0b1020",
              border: "1px solid #1c2434",
              borderRadius: 4,
              color: "var(--fg)",
              fontSize: 11,
              resize: "vertical",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          />
          <div style={{ display: "flex", gap: 4 }}>
            <button style={actionBtn} onClick={save} disabled={status === "saving"}>
              {status === "saving" ? "Saving..." : status === "saved" ? "✓ Saved" : "Save"}
            </button>
            <button style={actionBtn} onClick={clear}>Clear</button>
            <button style={actionBtn} onClick={test}>Test token</button>
          </div>
          {errorMsg && (
            <div style={{ fontSize: 10, color: "#f44336" }}>{errorMsg}</div>
          )}
          {probeResult && (
            <div style={{ fontSize: 11, color: probeResult.startsWith("✓") ? "#4CAF50" : "#f44336" }}>
              {probeResult}
            </div>
          )}
          <div style={{ fontSize: 10, color: "var(--fg-muted)", lineHeight: 1.4 }}>
            Hugging Face tokens enable downloading gated and private models. Tokens are stored locally only.
          </div>
        </>
      ) : (
        <div style={{ fontSize: 11, color: "var(--fg)", lineHeight: 1.5 }}>
          <p style={{ marginTop: 0 }}>
            Most public models on Hugging Face download without a token.
          </p>
          <p>
            Gated models (Llama, Gemma, some Mistral variants) require you to
            accept the model's licence on huggingface.co and use a token with at
            least <strong>read</strong> permission.
          </p>
          <p>
            Generate one at{" "}
            <code style={{ background: "#162033", padding: "1px 4px", borderRadius: 3 }}>
              huggingface.co/settings/tokens
            </code>
            .
          </p>
        </div>
      )}
    </div>
  );
}

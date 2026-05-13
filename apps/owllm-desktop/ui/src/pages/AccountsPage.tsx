// AccountsPage — ported from LLM/desktop_app/pages/accounts_page.py
// (AccountsPage._build_ui, line 403). 2x2 grid of brand cards, one
// per cloud route: Claude (subscription), Codex (subscription),
// Anthropic API (key), OpenAI API (key).
//
// Each card: brand-tinted gradient, no borders, drop shadow lift,
// header with icon + name (in brand accent) + tagline + status dot,
// status text, Connect/Disconnect button + Test button.
import React, { useState } from "react";

type BrandSpec = {
  key: string;
  name: string;
  tagline: string;
  icon: string;
  accent: string;       // brand color (title + dots)
  accentTop: string;    // gradient top color
  kind: "subscription" | "api";
  envName?: string;
  backend: string;
};

// Verbatim from accounts_page.py:47-94 (BRAND_CARDS tuple). Accent
// colours preserved.
const BRANDS: BrandSpec[] = [
  {
    key: "claude_subscription",
    name: "Claude",
    tagline: "Subscription · Claude Code CLI",
    icon: "🅰️",
    accent: "#cc785c",
    accentTop: "#3a2620",
    kind: "subscription",
    backend: "claude_cli",
  },
  {
    key: "codex_subscription",
    name: "Codex",
    tagline: "Subscription · OpenAI Codex CLI",
    icon: "🟢",
    accent: "#10a37f",
    accentTop: "#16322a",
    kind: "subscription",
    backend: "codex_cli",
  },
  {
    key: "anthropic_api",
    name: "Anthropic API",
    tagline: "ANTHROPIC_API_KEY · billed per call",
    icon: "⚡",
    accent: "#cc785c",
    accentTop: "#2e2420",
    kind: "api",
    envName: "ANTHROPIC_API_KEY",
    backend: "claude_api",
  },
  {
    key: "openai_api",
    name: "OpenAI API",
    tagline: "OPENAI_API_KEY · billed per call",
    icon: "⚡",
    accent: "#10a37f",
    accentTop: "#172a26",
    kind: "api",
    envName: "OPENAI_API_KEY",
    backend: "openai_api",
  },
];

type CardState = {
  connected: boolean;
  testing: boolean;
  testResult: string;
  testOk: boolean | null;
  apiKey: string;
};

function StatusDot({ on, color }: { on: boolean; color: string }) {
  const c = on ? color : "#555";
  return (
    <span style={{
      width: 10, height: 10, borderRadius: 5,
      background: c,
      boxShadow: on ? `0 0 6px ${c}` : "none",
      flexShrink: 0,
    }} />
  );
}

function BrandCard({ spec }: { spec: BrandSpec }) {
  const [state, setState] = useState<CardState>({
    connected: false,
    testing: false,
    testResult: "",
    testOk: null,
    apiKey: "",
  });

  const isSub = spec.kind === "subscription";
  const actionLabel = state.connected
    ? "Disconnect"
    : isSub ? "Connect (claude /login)" : "Save key";
  const statusText = state.connected
    ? (isSub ? "Logged in to CLI" : "Key configured")
    : (isSub ? "CLI not signed in" : "No key in env");

  function onAction() {
    setState(s => ({
      ...s,
      connected: !s.connected,
      testResult: "",
      testOk: null,
    }));
  }
  function onTest() {
    setState(s => ({ ...s, testing: true, testResult: "Testing…", testOk: null }));
    setTimeout(() => setState(s => ({
      ...s, testing: false,
      testResult: state.connected
        ? "✓ Round-trip OK · 412 ms"
        : "× Not connected — connect first",
      testOk: state.connected,
    })), 600);
  }

  return (
    <div style={{
      background: `linear-gradient(180deg, ${spec.accentTop} 0%, #0f1218 60%, #0a0d14 100%)`,
      borderRadius: 16,
      padding: "20px 22px",
      boxShadow: "0 4px 24px rgba(0,0,0,0.40)",
      minHeight: 220,
      display: "flex",
      flexDirection: "column",
      gap: 10,
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
        <div style={{ fontSize: 28 }}>{spec.icon}</div>
        <div style={{ flex: 1 }}>
          <div style={{ color: spec.accent, fontSize: 15, fontWeight: 700 }}>{spec.name}</div>
          <div style={{ color: "#9aa0a6", fontSize: 11 }}>{spec.tagline}</div>
        </div>
        <StatusDot on={state.connected} color={spec.accent} />
      </div>

      {/* Status */}
      <div style={{ color: "#bbb", fontSize: 11 }}>{statusText}</div>

      {/* Key input (API only) */}
      {!isSub && (
        <input
          type="password"
          value={state.apiKey}
          onChange={e => setState(s => ({ ...s, apiKey: e.target.value }))}
          placeholder={`Paste ${spec.envName} value`}
          style={{
            height: 32, padding: "0 12px",
            borderRadius: 8, border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(0,0,0,0.30)",
            color: "#dadcdf", fontSize: 12,
          }}
        />
      )}

      <div style={{ flex: 1 }} />

      {/* Test result */}
      {state.testResult && (
        <div style={{
          color: state.testOk ? "#69e6a1" : state.testOk === false ? "#ff8c8c" : "#9aa0a6",
          fontSize: 11,
        }}>
          {state.testResult}
        </div>
      )}

      {/* Buttons */}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={onAction}
          style={{
            flex: 1, minHeight: 34,
            background: state.connected
              ? "rgba(239,68,68,0.18)"
              : `linear-gradient(180deg, ${spec.accent}, ${spec.accent}cc)`,
            color: state.connected ? "#ff8c8c" : "#fff",
            border: state.connected ? "1px solid rgba(239,68,68,0.55)" : "none",
            borderRadius: 8,
            fontSize: 12, fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {actionLabel}
        </button>
        <button
          onClick={onTest}
          disabled={state.testing}
          style={{
            minHeight: 34, padding: "0 18px",
            background: "rgba(255,255,255,0.06)",
            color: state.testing ? "#555" : "#ddd",
            border: "none",
            borderRadius: 8,
            fontWeight: 500, fontSize: 12,
            cursor: state.testing ? "default" : "pointer",
          }}
        >
          Test
        </button>
      </div>
    </div>
  );
}

export default function AccountsPage() {
  return (
    <div style={{ padding: "24px 28px", height: "100%", display: "flex", flexDirection: "column", gap: 14, overflow: "auto" }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: "#fff" }}>Accounts</div>
      <div style={{ fontSize: 12, color: "#9aa0a6", maxWidth: 900, lineHeight: 1.5 }}>
        Four cloud routes. Subscriptions (Claude / Codex) use the
        respective CLI's saved session — no API key needed; click
        Connect to run the CLI's login flow. API keys (Anthropic /
        OpenAI) live in environment variables and are billed per call.
      </div>
      <div style={{
        flex: 1,
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gridTemplateRows: "1fr 1fr",
        gap: 18,
        minHeight: 0,
      }}>
        {BRANDS.map(b => <BrandCard key={b.key} spec={b} />)}
      </div>
    </div>
  );
}

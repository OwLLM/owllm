// AccountsPage v2 — one unified container per provider (subscription
// route on top + API key route below, sharing the same brand header,
// logo, and column slot). Right-rail dock streams cli_install output
// in-app so the user never has to chase a pop-out CMD window to read
// npm's progress.
//
// Visual contract:
//   * left flex column: provider containers (auto-fit grid, max 480px each)
//   * right docked rail (340px wide): persistent install / login log
//   * inline SVG logos per brand (no emoji fallback)
//
// Backend contract unchanged: accounts_status / accounts_save_api_key /
// accounts_delete_secret / accounts_test_probe / subscription_cli_login /
// cli_install_stream / browser_open_url. The CardState shape is per-route
// now (one CardState entry per subscription OR api spec).

import { useEffect, useRef, useState } from "react";
import { useStickyScroll } from "../../hooks/useStickyScroll";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AnthropicLogo, OpenAILogo, MoonshotLogo, GeminiLogo,
  DeepSeekLogo, XaiLogo, GroqLogo, PerplexityLogo,
  MistralLogo, TogetherLogo,
} from "./brandLogos";
import PtyTerminal from "./PtyTerminal";
import { sandboxSyncLogins } from "../agentic/isolation";
import { translateUiText } from "../../localization";
import { openWebUrl } from "../../utils/openWebUrl";
import {
  classifySubscriptionFailure,
  isKimiLoginSuccess,
  type AccountRemediation,
} from "./accountHealth";

const ACCOUNT_ONBOARDING_KEY = "owllm:accounts:onboarding-provider";

// VoiceRuntimePanel — surfaces the status of the bundled whisper.cpp
// transcription pipeline (binary + ggml-base.bin model) and exposes an
// "Install voice runtime" button that fetches both from upstream into
// <runtime_cache>/whisper.cpp/. The two assets together unlock voice
// messages from Telegram, WhatsApp, and the in-app uploader for every
// model path — local, Anthropic API, OpenAI API, etc.
type WhisperStatus = {
  model_installed: boolean;
  model_path: string;
  model_bytes: number;
  binary_installed: boolean;
  binary_path: string;
  binary_auto_install: boolean;
};
type InstallProgress = {
  phase: "binary" | "model";
  downloaded: number;
  total: number;
  done: boolean;
};
function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
function VoiceRuntimePanel() {
  const [status, setStatus] = useState<WhisperStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const s = await invoke<WhisperStatus>("whisper_runtime_status");
      setStatus(s);
    } catch (e) {
      console.warn("whisper_runtime_status failed", e);
    }
  };

  useEffect(() => {
    refresh();
    const unlisten = listen<InstallProgress>("owllm:whisper:install:progress", (e) => {
      setProgress(e.payload);
    });
    return () => {
      unlisten.then((un) => un()).catch(() => {});
    };
  }, []);

  const onInstall = async () => {
    setInstallError(null);
    setProgress(null);
    setInstalling(true);
    try {
      await invoke<WhisperStatus>("whisper_runtime_install");
      await refresh();
    } catch (e: any) {
      setInstallError(String(e?.message ?? e));
    } finally {
      setInstalling(false);
    }
  };

  if (!status) return null;
  const allInstalled = status.model_installed && status.binary_installed;
  const accent = allInstalled ? "#22c55e" : "#ffd97a";
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : 0;

  return (
    <div
      data-ui="VoiceRuntimePanel"
      style={{
        background: "var(--bg-elevated)",
        border: `1px solid ${accent}55`,
        borderRadius: 10,
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 18 }}>🎤</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)" }}>
            Voice runtime · {allInstalled ? "ready" : "needs install"}
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
            Transcribes audio attachments (Telegram, WhatsApp, in-app) into text for every agent path.
            Local — no cloud round-trip.
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "var(--fg-muted)" }}>
          <span style={{ color: status.binary_installed ? "#22c55e" : "#ffd97a" }}>
            {status.binary_installed ? "✓" : "○"} whisper.cpp binary
          </span>
          <span style={{ color: status.model_installed ? "#22c55e" : "#ffd97a" }}>
            {status.model_installed ? "✓" : "○"} ggml-base.bin {status.model_bytes > 0 ? `(${fmtBytes(status.model_bytes)})` : ""}
          </span>
        </div>
      </div>
      {/* Progress bar — only visible while a download is in flight. */}
      {installing && progress && (
        <div>
          <div style={{ fontSize: 11, color: "var(--fg-muted)", marginBottom: 4 }}>
            {progress.phase === "binary" ? "Downloading whisper.cpp binary" : "Downloading model (~142 MB)"} —{" "}
            {fmtBytes(progress.downloaded)}
            {progress.total > 0 ? ` / ${fmtBytes(progress.total)} · ${pct}%` : ""}
          </div>
          <div style={{ height: 6, background: "var(--bg-surface)", borderRadius: 3, overflow: "hidden" }}>
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                background: accent,
                transition: "width 120ms linear",
              }}
            />
          </div>
        </div>
      )}
      {installError && (
        <div
          style={{
            fontSize: 11,
            color: "#ff8c8c",
            background: "rgba(255, 80, 80, 0.10)",
            border: "1px solid #ff8c8c44",
            borderRadius: 6,
            padding: "6px 10px",
          }}
        >
          {installError}
        </div>
      )}
      {!allInstalled && !installing && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            onClick={onInstall}
            disabled={!status.binary_auto_install && !status.binary_installed}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: `1px solid ${accent}`,
              background: status.binary_auto_install || status.binary_installed ? accent : "rgba(255,217,122,0.25)",
              color: "#1a1404",
              fontSize: 12,
              fontWeight: 700,
              cursor: status.binary_auto_install || status.binary_installed ? "pointer" : "not-allowed",
            }}
          >
            Install voice runtime
          </button>
          {!status.binary_auto_install && !status.binary_installed && (
            <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>
              Auto-install is Windows-only.{" "}
              <b>macOS:</b> <code style={{ background: "var(--bg-surface)", padding: "1px 4px", borderRadius: 3 }}>brew install whisper-cpp</code>.{" "}
              <b>Linux:</b> install <code style={{ background: "var(--bg-surface)", padding: "1px 4px", borderRadius: 3 }}>whisper-cpp</code> via your package manager. Then reload this page.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/// Per-CLI spawn recipe for the embedded terminal. The exe name is
/// what we hand portable-pty's CommandBuilder — PATH resolution
/// happens there (or in Rust's which_extended fallback). Args mirror
/// what subscription_cli_login used to pass when opening CMD:
///   * claude: bare REPL — auto-type /login once it boots.
///   * codex/kimi/grok: dedicated device-login command; PtyTerminal opens the
///     emitted verification URL in OwLLM's browser.
///   * gemini: bare REPL + `/auth`, matching the official CLI flow.
const LOGIN_CMD: Record<string, { cli: string; args: string[]; send?: string } | undefined> = {
  claude_cli: { cli: "claude", args: [], send: "/login\r" },
  // Device-code auth avoids localhost callbacks and system-browser launches.
  // PtyTerminal opens the emitted URL in OwLLM's persistent browser instead.
  codex_cli:  { cli: "codex",  args: ["login", "--device-auth"] },
  // Current kimi-cli has a dedicated login command. The old bare-REPL +
  // auto-typed /login recipe entered an agent shell instead of authenticating.
  kimi_cli:   { cli: "kimi",   args: ["login", "--json"] },
  gemini_cli: { cli: "gemini", args: [], send: "/auth\r" },
  grok_cli:   { cli: "grok",   args: ["login", "--device-auth"] },
};

const PAGE_BG = "var(--bg-panel)";

// -----------------------------------------------------------------------
// Backend types
// -----------------------------------------------------------------------
type AccountsStatus = {
  host_os: string;
  anthropic_api_key: boolean;
  openai_api_key: boolean;
  moonshot_api_key: boolean;
  deepseek_api_key: boolean;
  xai_api_key: boolean;
  groq_api_key: boolean;
  perplexity_api_key: boolean;
  mistral_api_key: boolean;
  together_api_key: boolean;
  gemini_api_key: boolean;
  claude_cli: boolean;
  claude_cli_installed: boolean;
  codex_cli: boolean;
  codex_cli_installed: boolean;
  kimi_cli: boolean;
  kimi_cli_installed: boolean;
  kimi_cli_reauth_required: boolean;
  gemini_cli: boolean;
  gemini_cli_installed: boolean;
  grok_cli: boolean;
  grok_cli_installed: boolean;
};
type ProbeResult = { ok: boolean; detail: string; elapsed_ms: number };

// -----------------------------------------------------------------------
// Route + provider model
// -----------------------------------------------------------------------
type RouteSpec = {
  key: string;
  kind: "subscription" | "api";
  /// Display label inside the container (e.g. "Subscription · Claude
  /// Code CLI"). Sits under the brand title in the route row.
  routeLabel: string;
  /// Backend identifier passed to accounts_test_probe and
  /// subscription_cli_login. For api routes also matches envName.
  backend: string;
  /// Env var stored in ~/.owllm/agent_secrets.json. Required for api,
  /// optional for subscription (Grok/DeepSeek subscriptions have no key).
  envName?: string;
  /// Web-only subscription (no CLI). Connect opens this URL instead of
  /// spawning a CLI login flow.
  webOnly?: { url: string };
};

type ProviderSpec = {
  /// Container key + brand display name.
  key: string;
  name: string;
  tagline: string;
  /// Renders the inline SVG logo. Color follows accent for tint.
  Logo: React.ComponentType<{ size?: number; color?: string }>;
  accent: string;
  accentTop: string;
  /// One or two routes; rendered top-to-bottom in the container.
  routes: RouteSpec[];
};

// Provider catalogue. Order = visual order in the grid. Each provider
// gets exactly one container card; subscription + API render as two
// rows inside it.
const PROVIDERS: ProviderSpec[] = [
  {
    key: "anthropic",
    name: "Claude",
    tagline: "Anthropic — flagship Opus / Sonnet / Haiku",
    Logo: AnthropicLogo,
    accent: "#cc785c",
    accentTop: "#3a2620",
    routes: [
      { key: "claude_subscription", kind: "subscription", routeLabel: "Subscription · Claude Code CLI", backend: "claude_cli" },
      { key: "anthropic_api",       kind: "api",          routeLabel: "API · ANTHROPIC_API_KEY",         backend: "claude_api", envName: "ANTHROPIC_API_KEY" },
    ],
  },
  {
    key: "openai",
    name: "OpenAI",
    tagline: "GPT-5 / Codex via ChatGPT subscription or API",
    Logo: OpenAILogo,
    accent: "#10a37f",
    accentTop: "#16322a",
    routes: [
      { key: "codex_subscription", kind: "subscription", routeLabel: "Subscription · OpenAI Codex CLI", backend: "codex_cli" },
      { key: "openai_api",         kind: "api",          routeLabel: "API · OPENAI_API_KEY",            backend: "openai_api", envName: "OPENAI_API_KEY" },
    ],
  },
  {
    key: "moonshot",
    name: "Kimi (Moonshot)",
    tagline: "K2 / Long-context Chinese model",
    Logo: MoonshotLogo,
    accent: "#d36bff",
    accentTop: "#2a1c33",
    routes: [
      { key: "kimi_subscription", kind: "subscription", routeLabel: "Subscription · Kimi Code CLI", backend: "kimi_cli" },
      { key: "moonshot_api",      kind: "api",          routeLabel: "API · MOONSHOT_API_KEY",       backend: "moonshot_api", envName: "MOONSHOT_API_KEY" },
    ],
  },
  {
    key: "gemini",
    name: "Google Gemini",
    tagline: "Gemini 2.5 · multimodal w/ huge context",
    Logo: GeminiLogo,
    accent: "#4285f4",
    accentTop: "#142036",
    routes: [
      { key: "gemini_subscription", kind: "subscription", routeLabel: "Subscription · Google Gemini CLI", backend: "gemini_cli" },
      { key: "gemini_api",          kind: "api",          routeLabel: "API · GEMINI_API_KEY",             backend: "gemini_api", envName: "GEMINI_API_KEY" },
    ],
  },
  {
    key: "deepseek",
    name: "DeepSeek",
    tagline: "DeepSeek V4 — strong open-weight + cheap API",
    Logo: DeepSeekLogo,
    accent: "#2563eb",
    accentTop: "#142036",
    routes: [
      { key: "deepseek_subscription", kind: "subscription", routeLabel: "Subscription · chat.deepseek.com", backend: "deepseek_web", webOnly: { url: "https://chat.deepseek.com" } },
      { key: "deepseek_api",          kind: "api",          routeLabel: "API · DEEPSEEK_API_KEY",            backend: "deepseek_api", envName: "DEEPSEEK_API_KEY" },
    ],
  },
  {
    key: "xai",
    name: "xAI Grok",
    tagline: "Grok 4 — fast reasoning · X Premium+ access",
    Logo: XaiLogo,
    accent: "#9aa0a6",
    accentTop: "#1a1c1f",
    routes: [
      { key: "xai_subscription", kind: "subscription", routeLabel: "Subscription · Grok Build CLI (SuperGrok / X Premium+)", backend: "grok_cli" },
      { key: "xai_api",          kind: "api",          routeLabel: "API · XAI_API_KEY",                       backend: "xai_api", envName: "XAI_API_KEY" },
    ],
  },
  {
    key: "groq",
    name: "Groq",
    tagline: "~1000 tok/s LPU inference · open models",
    Logo: GroqLogo,
    accent: "#ff5d11",
    accentTop: "#2a160c",
    routes: [
      { key: "groq_api", kind: "api", routeLabel: "API · GROQ_API_KEY", backend: "groq_api", envName: "GROQ_API_KEY" },
    ],
  },
  {
    key: "perplexity",
    name: "Perplexity",
    tagline: "Sonar — built-in real-time web search",
    Logo: PerplexityLogo,
    accent: "#20b2aa",
    accentTop: "#102624",
    routes: [
      { key: "perplexity_api", kind: "api", routeLabel: "API · PERPLEXITY_API_KEY", backend: "perplexity_api", envName: "PERPLEXITY_API_KEY" },
    ],
  },
  {
    key: "mistral",
    name: "Mistral",
    tagline: "Large / Magistral / Codestral — French frontier",
    Logo: MistralLogo,
    accent: "#ff7a00",
    accentTop: "#2b1a0a",
    routes: [
      { key: "mistral_api", kind: "api", routeLabel: "API · MISTRAL_API_KEY", backend: "mistral_api", envName: "MISTRAL_API_KEY" },
    ],
  },
  {
    key: "together",
    name: "Together AI",
    tagline: "Hosted open-source models · Llama / Qwen / Mixtral",
    Logo: TogetherLogo,
    accent: "#7fc8ff",
    accentTop: "#12222e",
    routes: [
      { key: "together_api", kind: "api", routeLabel: "API · TOGETHER_API_KEY", backend: "together_api", envName: "TOGETHER_API_KEY" },
    ],
  },
];

// -----------------------------------------------------------------------
// CardState — per route (one entry per RouteSpec.key)
// -----------------------------------------------------------------------
type CardState = {
  connected: boolean;
  installed: boolean;
  reauthRequired: boolean;
  remediation: AccountRemediation;
  testing: boolean;
  testText: string;       // Windows / host probe result
  testOk: boolean | null;
  wslText: string;        // WSL sandbox probe result (isolated agents)
  wslOk: boolean | null;
  installing: boolean; // true while cli_install_stream is in-flight
};
const initialCardState: CardState = {
  connected: false,
  installed: false,
  reauthRequired: false,
  remediation: null,
  testing: false,
  testText: "",
  testOk: null,
  wslText: "",
  wslOk: null,
  installing: false,
};

// -----------------------------------------------------------------------
// Install / login log hub — module-scope so the right rail keeps logs
// across re-renders, tab switches, and reconcile() ticks.
// -----------------------------------------------------------------------
type LogLine = { ts: number; stream: "stdout" | "stderr" | "info"; text: string; backend: string };

class LogHub {
  private lines: LogLine[] = [];
  private subs = new Set<(lines: LogLine[]) => void>();
  private cap = 2000;

  push(line: LogLine) {
    this.lines.push(line);
    if (this.lines.length > this.cap) {
      this.lines = this.lines.slice(-this.cap);
    }
    this.emit();
  }
  clear() { this.lines = []; this.emit(); }
  snapshot() { return this.lines.slice(); }
  subscribe(fn: (lines: LogLine[]) => void) {
    this.subs.add(fn);
    fn(this.snapshot());
    return () => { this.subs.delete(fn); };
  }
  private emit() {
    const snap = this.snapshot();
    this.subs.forEach((s) => s(snap));
  }
}
const LOG_HUB = new LogHub();

// -----------------------------------------------------------------------
// Status dot
// -----------------------------------------------------------------------
function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      style={{
        width: 9, height: 9, borderRadius: 5,
        background: connected ? "#4caf50" : "#5a6376",
        flexShrink: 0,
      }}
    />
  );
}

// -----------------------------------------------------------------------
// API-key dialog
// -----------------------------------------------------------------------
function ApiKeyDialog({
  envName, onCancel, onSave,
}: { envName: string; onCancel: () => void; onSave: (value: string) => void }) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  function commit() { const v = value.trim(); if (v) onSave(v); }
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth: 440, maxWidth: 520,
          background: "#15191f", borderRadius: 12,
          padding: "20px 20px",
          display: "flex", flexDirection: "column", gap: 12,
          boxShadow: "0 18px 60px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ color: "var(--fg-strong)", fontSize: 14, fontWeight: 700 }}>Set {envName}</div>
        <div style={{ color: "var(--fg-muted)", fontSize: 11, lineHeight: 1.55 }}>
          Paste your <b>{envName}</b> below. It will be stored in{" "}
          <code style={{ background: "var(--bg-surface)", padding: "1px 4px", borderRadius: 3 }}>
            ~/.owllm/agent_secrets.json
          </code>{" "}
          on this machine. Agents fall back to the CLI subscription automatically when no key is saved.
        </div>
        <input
          ref={inputRef}
          type={show ? "text" : "password"}
          value={value}
          placeholder={envName}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") onCancel(); }}
          style={{
            minHeight: 34, padding: "0 12px",
            borderRadius: 8, border: "1px solid var(--border-strong)",
            background: "rgba(0,0,0,0.30)", color: "var(--fg)",
            fontSize: 12, fontFamily: "ui-monospace, Menlo, Consolas, monospace",
          }}
        />
        <button
          onClick={() => setShow((s) => !s)}
          style={{
            background: "transparent", color: "var(--fg-muted)",
            border: "none", textDecoration: "underline",
            fontSize: 11, cursor: "pointer",
            alignSelf: "flex-start", padding: 0,
          }}
        >{show ? "Hide" : "Show"}</button>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button
            onClick={onCancel}
            style={{ minHeight: 30, padding: "0 14px", background: "var(--bg-surface)", color: "var(--fg)", border: "none", borderRadius: 6, fontSize: 12, cursor: "pointer" }}
          >Cancel</button>
          <button
            onClick={commit}
            disabled={!value.trim()}
            style={{ minHeight: 30, padding: "0 14px", background: value.trim() ? "#3b82f6" : "rgba(59,130,246,0.30)", color: "var(--fg-strong)", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: value.trim() ? "pointer" : "default" }}
          >Save</button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// One route row inside a provider container.
// -----------------------------------------------------------------------
function RouteRow({
  provider, route, state, hostLabel, onConnect, onInstall, onDisconnect, onTest,
}: {
  provider: ProviderSpec;
  route: RouteSpec;
  state: CardState;
  hostLabel: string;
  onConnect: () => void;
  onInstall: () => void;
  onDisconnect: () => void;
  onTest: () => void;
}) {
  const isSub = route.kind === "subscription";
  const connected = state.connected;
  const statusText = state.remediation === "update"
    ? "CLI outdated or incompatible · update required"
    : state.remediation === "subscription"
      ? "Subscription unavailable · renew the plan or wait for quota reset"
      : state.remediation === "retry"
        ? "CLI failed its live check · update it, then test again"
        : state.reauthRequired || state.remediation === "reauth"
    ? "Session expired · reconnect required"
    : connected
    ? (isSub ? "CLI logged in" : "API key saved")
    : (isSub ? (route.webOnly
        ? "Web-only · sign up to subscribe"
        : state.installed ? "CLI installed · sign in required" : "CLI not installed · install it first")
             : "No API key saved");

  // Subscription routes with a CLI get TWO buttons when disconnected:
  // [Install] [Connect]. Web-only subs (Grok/DeepSeek) just get
  // [Open subscription]. API routes get [Set key].
  const cliBackedSub = isSub && !route.webOnly;

  const primaryLabel =
    state.reauthRequired || state.remediation === "reauth" ? "Reconnect"
    : connected ? "Disconnect"
    : isSub ? (route.webOnly ? "Open subscription" : "Connect")
    : "Set key";

  function handlePrimary() {
    if (state.reauthRequired || state.remediation === "reauth") {
      onConnect();
    } else if (connected) {
      if (window.confirm(`Remove the local ${provider.name} credentials?`)) onDisconnect();
    } else {
      onConnect();
    }
  }

  return (
    <div
      style={{
        display: "flex", flexDirection: "column", gap: 6,
        padding: "10px 0",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StatusDot connected={connected && !state.remediation && !state.reauthRequired} />
        <div style={{ flex: 1, color: "var(--fg)", fontSize: 12 }}>
          {route.routeLabel}
        </div>
      </div>
      <div style={{ fontSize: 11, color: "var(--fg-muted)", marginLeft: 17 }}>
        {statusText}
      </div>
      {state.testText && (
        <div style={{
          fontSize: 11, marginLeft: 17, wordBreak: "break-word",
          color: state.testing ? "#dcb0ff" : state.testOk ? "#4caf50" : "#ff8c8c",
        }}>
          {state.testing ? "Running probe…" : <><b>{hostLabel}:</b> {state.testText}</>}
        </div>
      )}
      {!state.testing && state.wslText && (
        <div style={{
          fontSize: 11, marginLeft: 17, wordBreak: "break-word",
          color: state.wslOk ? "#4caf50" : "#ff8c8c",
        }}>
          <b>Linux (WSL):</b> {state.wslText}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginLeft: 17, marginTop: 4 }}>
        {cliBackedSub && (state.remediation === "update" || state.remediation === "retry") && (
          <button
            data-cli-repair={route.backend}
            onClick={onInstall}
            disabled={state.installing}
            style={{
              minHeight: 30, padding: "0 14px",
              background: "rgba(255,190,92,0.15)", color: "#ffd27a",
              border: "1px solid rgba(255,190,92,0.35)", borderRadius: 6,
              fontSize: 11, fontWeight: 700, cursor: state.installing ? "default" : "pointer",
            }}
          >{state.installing ? "Updating…" : "Update CLI"}</button>
        )}
        {cliBackedSub && !connected && state.remediation !== "update" && state.remediation !== "retry" && (
          <button
            data-cli-backend={route.backend}
            onClick={onInstall}
            disabled={state.installing}
            style={{
              minHeight: 30, padding: "0 14px",
              background: state.installing ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.06)",
              color: state.installing ? "#888" : "#ddd",
              border: "1px solid rgba(255,255,255,0.10)",
              borderRadius: 6, fontSize: 11, fontWeight: 600,
              cursor: state.installing ? "default" : "pointer",
            }}
          >{state.installing ? "Installing…" : state.installed ? "⬆ Update CLI" : "⬇ Install CLI"}</button>
        )}
        <button
          onClick={handlePrimary}
          style={{
            flex: 1, minHeight: 30, padding: "0 14px",
            background: connected ? "rgba(255,110,110,0.12)" : provider.accent,
            color: connected ? "#ff8c8c" : "#fff",
            border: "none", borderRadius: 6,
            fontSize: 11, fontWeight: 600, cursor: "pointer",
          }}
        >{primaryLabel}</button>
        <button
          data-cli-test-backend={route.backend}
          onClick={onTest}
          disabled={!connected || state.testing}
          style={{
            minHeight: 30, padding: "0 14px",
            background: !connected || state.testing ? "rgba(255,255,255,0.03)" : "var(--bg-surface)",
            color: !connected || state.testing ? "#555" : "#ddd",
            border: "none", borderRadius: 6,
            fontSize: 11, fontWeight: 500,
            cursor: !connected || state.testing ? "default" : "pointer",
          }}
        >{state.testing ? "…" : "Test"}</button>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Provider container — header + N route rows.
// -----------------------------------------------------------------------
function ProviderCard({
  provider, cards, highlighted, hostLabel, onConnect, onInstall, onDisconnect, onTest,
}: {
  provider: ProviderSpec;
  cards: Record<string, CardState>;
  highlighted?: boolean;
  hostLabel: string;
  onConnect: (route: RouteSpec) => void;
  onInstall: (route: RouteSpec) => void;
  onDisconnect: (route: RouteSpec) => void;
  onTest: (route: RouteSpec) => void;
}) {
  const Logo = provider.Logo;
  return (
    <div
      data-provider-key={provider.key}
      data-onboarding-highlighted={highlighted ? "true" : undefined}
      style={{
        background: `linear-gradient(180deg, ${provider.accentTop} 0%, ${PAGE_BG} 60%, ${PAGE_BG} 100%)`,
        borderRadius: 14,
        padding: "18px 20px 14px 20px",
        border: highlighted ? `2px solid ${provider.accent}` : "2px solid transparent",
        boxShadow: highlighted
          ? `0 0 0 3px color-mix(in srgb, ${provider.accent} 22%, transparent), 0 8px 30px rgba(0,0,0,0.52)`
          : "0 4px 24px rgba(0,0,0,0.47)",
        display: "flex", flexDirection: "column",
        minHeight: 220,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 10 }}>
        <div style={{ width: 36, height: 36, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Logo size={32} color={provider.accent} />
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ color: provider.accent, fontSize: 15, fontWeight: 700 }}>{provider.name}</div>
          <div style={{ color: "var(--fg-muted)", fontSize: 11 }}>{provider.tagline}</div>
        </div>
      </div>
      {provider.routes.map((route, i) => (
        <div key={route.key} style={{ borderTop: i === 0 ? "none" : "1px solid rgba(255,255,255,0.06)" }}>
          <RouteRow
            provider={provider}
            route={route}
            state={cards[route.key] ?? initialCardState}
            hostLabel={hostLabel}
            onConnect={() => onConnect(route)}
            onInstall={() => onInstall(route)}
            onDisconnect={() => onDisconnect(route)}
            onTest={() => onTest(route)}
          />
        </div>
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------
// Right-rail tabbed view: Log (install + status messages) + Terminal
// (live CLI session for OAuth login). The terminal tab is only
// available while a CLI session is active; clicking Connect on a
// CLI-backed subscription card spawns the CLI inside it.
// -----------------------------------------------------------------------
type RailTab = "log" | "terminal";

type ActiveTerminal = {
  cli: string;
  args: string[];
  backend: string;
  providerName: string;
  /// REPL command auto-typed after the CLI boots (e.g. "/login\r").
  send?: string;
};

function RightRail({
  stacked, activeTerm, tab, setTab, onCloseTerm, onTerminalOutput, onAuthTabOpened,
}: {
  stacked: boolean;
  activeTerm: ActiveTerminal | null;
  tab: RailTab;
  setTab: (t: RailTab) => void;
  onCloseTerm: () => void;
  onTerminalOutput: (backend: string, text: string) => void;
  onAuthTabOpened: (backend: string, tabId: number) => void;
}) {
  // Auto-switch to the terminal tab whenever a new session opens, so
  // the user doesn't have to hunt for it. Switching back to log is up
  // to them.
  useEffect(() => {
    if (activeTerm) setTab("terminal");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTerm?.backend, activeTerm?.cli]);

  return (
    <div
      style={{
        width: stacked ? "100%" : 380,
        height: stacked ? 320 : "auto",
        flexShrink: 0,
        display: "flex", flexDirection: "column",
        background: "#0c0f14",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 12,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {/* Tab bar */}
      <div style={{
        display: "flex", alignItems: "stretch",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
      }}>
        <TabButton label="Install / login log" active={tab === "log"} onClick={() => setTab("log")} />
        <TabButton
          label={activeTerm ? `Terminal · ${activeTerm.providerName}` : "Terminal"}
          active={tab === "terminal"}
          disabled={!activeTerm}
          onClick={() => activeTerm && setTab("terminal")}
        />
        <div style={{ flex: 1 }} />
        {tab === "log" && (
          <button
            onClick={() => LOG_HUB.clear()}
            style={{ background: "transparent", border: "none", color: "var(--fg-muted)", fontSize: 11, padding: "0 12px", cursor: "pointer", textDecoration: "underline" }}
          >clear</button>
        )}
        {tab === "terminal" && activeTerm && (
          <button
            onClick={onCloseTerm}
            style={{ background: "transparent", border: "none", color: "#ff8c8c", fontSize: 11, padding: "0 12px", cursor: "pointer" }}
          >✕ close</button>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: tab === "log" ? "block" : "none" }}>
        <InstallLogPanel embedded />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tab === "terminal" ? "block" : "none" }}>
        {activeTerm
          ? <PtyTerminal
              cli={activeTerm.cli}
              args={activeTerm.args}
              autoSend={activeTerm.send}
              autoOpenAuthUrls
              onOutputText={(text) => onTerminalOutput(activeTerm.backend, text)}
              onAuthTabOpened={(tabId) => onAuthTabOpened(activeTerm.backend, tabId)}
            />
          : <div style={{ padding: 14, color: "var(--fg-dim)", fontSize: 11, fontStyle: "italic" }}>
              Click Connect on any CLI-backed subscription to open a live terminal here.
            </div>}
      </div>
    </div>
  );
}

function TabButton({ label, active, disabled, onClick }: { label: string; active: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: active ? "rgba(127,184,255,0.10)" : "transparent",
        border: "none",
        borderBottom: active ? "2px solid #7fb8ff" : "2px solid transparent",
        color: disabled ? "#3e4654" : active ? "#dcdfe7" : "#9aa0a6",
        fontSize: 11, fontWeight: 700,
        padding: "10px 14px",
        cursor: disabled ? "default" : "pointer",
      }}
    >{label}</button>
  );
}

// -----------------------------------------------------------------------
// In-app log panel (was the entire right rail in v2). Now lives as one
// tab inside RightRail. `embedded` strips the panel's own header since
// the tab bar handles that.
// -----------------------------------------------------------------------
function InstallLogPanel({ stacked = false, embedded = false }: { stacked?: boolean; embedded?: boolean }) {
  const [lines, setLines] = useState<LogLine[]>(LOG_HUB.snapshot());
  // Sticky auto-scroll: land at the bottom when the log first mounts, then
  // follow new lines only while the user is near the bottom (contentKey = line
  // count) — never yank a user who scrolled up to read.
  const logSticky = useStickyScroll(lines.length);

  useEffect(() => LOG_HUB.subscribe(setLines), []);

  // When `embedded`, the parent RightRail provides the chrome (tab bar
  // and clear button). Strip our own header so we don't double up.
  const outer: React.CSSProperties = embedded
    ? { width: "100%", height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }
    : {
        width: stacked ? "100%" : 340,
        height: stacked ? 220 : "auto",
        flexShrink: 0,
        display: "flex", flexDirection: "column",
        background: "#0c0f14",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 12,
        minHeight: 0,
      };

  return (
    <div style={outer}>
      {!embedded && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 14px",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}>
          <div style={{ color: "var(--fg)", fontSize: 12, fontWeight: 700 }}>
            Install / login log
          </div>
          <button
            onClick={() => LOG_HUB.clear()}
            style={{ background: "transparent", border: "none", color: "var(--fg-muted)", fontSize: 11, cursor: "pointer", textDecoration: "underline" }}
          >clear</button>
        </div>
      )}
      <div
        ref={logSticky.ref}
        onScroll={logSticky.onScroll}
        style={{
          flex: 1, overflowY: "auto",
          padding: "8px 12px",
          fontFamily: "ui-monospace, Menlo, Consolas, monospace",
          fontSize: 11, lineHeight: 1.5,
          color: "var(--fg)",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}
      >
        {lines.length === 0 && (
          <div style={{ color: "var(--fg-dim)", fontStyle: "italic" }}>
            No activity yet. Click Install or Connect on any provider to
            see the live output here instead of a pop-out console.
          </div>
        )}
        {lines.map((l, i) => (
          <div
            key={i}
            style={{
              color: l.stream === "stderr" ? "#ffcc88"
                    : l.stream === "info"  ? "#7fb8ff"
                    : "#cfd4e1",
            }}
          >
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------
export default function AccountsPage() {
  // Flatten all routes into card state keyed by route.key
  const allRoutes = PROVIDERS.flatMap((p) => p.routes);
  const [cards, setCards] = useState<Record<string, CardState>>(() =>
    Object.fromEntries(allRoutes.map((r) => [r.key, { ...initialCardState }])),
  );
  const [dialogFor, setDialogFor] = useState<{ route: RouteSpec; provider: ProviderSpec } | null>(null);
  const [onboardingProvider, setOnboardingProvider] = useState(() => {
    try {
      const saved = sessionStorage.getItem(ACCOUNT_ONBOARDING_KEY) ?? "";
      return saved === "api" || PROVIDERS.some((provider) => provider.key === saved) ? saved : "";
    }
    catch { return ""; }
  });

  useEffect(() => {
    if (!onboardingProvider || onboardingProvider === "api") return;
    const id = window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-provider-key="${onboardingProvider}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    return () => window.clearTimeout(id);
  }, [onboardingProvider]);

  const dismissOnboardingHint = () => {
    try { sessionStorage.removeItem(ACCOUNT_ONBOARDING_KEY); } catch { /* ignore */ }
    setOnboardingProvider("");
  };

  // Responsive layout: at narrow widths the 340 px right rail crushes
  // the card grid (cards visually overlap as they fall below their
  // minmax floor). Below 960 px we stack the log panel UNDER the
  // cards instead — full width, fixed height — so the cards always
  // have room to lay out cleanly. Cap is generous: 960 covers most
  // laptops + window snapped to half-screen on 1080p.
  const [narrow, setNarrow] = useState(() => window.innerWidth < 960);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 960);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Embedded-terminal session: non-null while a CLI login REPL is
  // running in the right rail's Terminal tab. Only one at a time —
  // a new Connect click replaces the previous session (which kills
  // its pty_kill in PtyTerminal's cleanup effect).
  const [activeTerm, setActiveTerm] = useState<ActiveTerminal | null>(null);
  const [railTab, setRailTab] = useState<RailTab>("log");
  const [hostOs, setHostOs] = useState("");
  const autoHealthProbedBackends = useRef(new Set<string>());
  const authTabs = useRef<Record<string, number>>({});
  const terminalOutput = useRef<Record<string, string>>({});
  const completedLogins = useRef(new Set<string>());
  const hostIsWindows = hostOs === "windows";
  const hostLabel = hostOs === "windows"
    ? "Windows"
    : hostOs === "macos"
      ? "macOS"
      : hostOs === "linux"
        ? "Linux"
        : "Host";

  function reconcile(status: AccountsStatus) {
    setCards((prev) => {
      const next = { ...prev };
      const flag = (key: string, connected: boolean, reauthRequired = false, installed = true) => {
        const cur = next[key];
        if (!cur) return;
        if (cur.connected !== connected || cur.reauthRequired !== reauthRequired || cur.installed !== installed) {
          next[key] = {
            ...cur,
            connected,
            installed,
            reauthRequired,
            remediation: reauthRequired ? "reauth" : cur.remediation,
            ...(reauthRequired
              ? {
                  testText: "✗  Kimi sign-in expired. Click Reconnect and complete login again.",
                  testOk: false,
                }
              : connected
                ? {}
                : { testText: "", testOk: null }),
          };
        }
      };
      flag("anthropic_api",         status.anthropic_api_key);
      flag("openai_api",            status.openai_api_key);
      flag("moonshot_api",          status.moonshot_api_key);
      flag("deepseek_api",          status.deepseek_api_key);
      flag("xai_api",               status.xai_api_key);
      flag("groq_api",              status.groq_api_key);
      flag("perplexity_api",        status.perplexity_api_key);
      flag("mistral_api",           status.mistral_api_key);
      flag("together_api",          status.together_api_key);
      flag("gemini_api",            status.gemini_api_key);
      flag("claude_subscription",   status.claude_cli, false, status.claude_cli_installed);
      flag("codex_subscription",    status.codex_cli, false, status.codex_cli_installed);
      flag("kimi_subscription",     status.kimi_cli, status.kimi_cli_reauth_required, status.kimi_cli_installed);
      flag("gemini_subscription",   status.gemini_cli, false, status.gemini_cli_installed);
      flag("xai_subscription",      status.grok_cli, false, status.grok_cli_installed);
      return next;
    });
  }

  useEffect(() => {
    let dead = false;
    const tick = async () => {
      try {
        const s = await invoke<AccountsStatus>("accounts_status");
        if (!dead) {
          setHostOs(s.host_os);
          reconcile(s);
          const connectedBackends = new Set([
            ...(s.claude_cli ? ["claude_cli"] : []),
            ...(s.codex_cli ? ["codex_cli"] : []),
            ...(s.kimi_cli ? ["kimi_cli"] : []),
            ...(s.gemini_cli ? ["gemini_cli"] : []),
            ...(s.grok_cli ? ["grok_cli"] : []),
          ]);
          const routes = allRoutes.filter((route) =>
            route.kind === "subscription"
            && connectedBackends.has(route.backend)
            && !autoHealthProbedBackends.current.has(route.backend));
          if (routes.length) {
            routes.forEach((route) => autoHealthProbedBackends.current.add(route.backend));
            // Probe sequentially so opening Accounts cannot launch five CLIs at
            // once. The work stays asynchronous and never blocks the WebView.
            void (async () => {
              for (const route of routes) await probeSubscriptionHealth(route, false);
            })();
          }
        }
      } catch (e) {
        console.error("accounts_status failed", e);
      }
    };
    tick();
    const id = window.setInterval(tick, 3000);
    return () => { dead = true; window.clearInterval(id); };
  }, []);

  function setCardState(key: string, patch: Partial<CardState>) {
    setCards((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  async function probeSubscriptionHealth(route: RouteSpec, announce = true): Promise<ProbeResult> {
    if (announce) {
      setCardState(route.key, { testing: true, testText: "", testOk: null });
      logInfo(route.backend, "Running a live subscription/CLI health check…");
    }
    try {
      const result = await invoke<ProbeResult>("accounts_test_probe_live", { backend: route.backend });
      const remediation = result.ok ? null : classifySubscriptionFailure(result.detail);
      const line = `${result.ok ? "✓" : "✗"}  ${result.detail}  ·  ${result.elapsed_ms} ms`;
      setCardState(route.key, {
        ...(result.ok ? { connected: true } : {}),
        reauthRequired: remediation === "reauth",
        remediation,
        testing: false,
        testText: line,
        testOk: result.ok,
      });
      if (announce || !result.ok) logInfo(route.backend, `${hostLabel}: ${line}`);
      return result;
    } catch (error: any) {
      const detail = String(error?.message ?? error);
      const remediation = classifySubscriptionFailure(detail);
      const result = { ok: false, detail, elapsed_ms: 0 };
      setCardState(route.key, {
        reauthRequired: remediation === "reauth",
        remediation,
        testing: false,
        testText: `✗  ${detail}`,
        testOk: false,
      });
      logInfo(route.backend, `${hostLabel}: ✗  ${detail}`);
      return result;
    }
  }

  function logInfo(backend: string, text: string) {
    LOG_HUB.push({ ts: Date.now(), stream: "info", text, backend });
  }

  // Mirror host logins/keys into the WSL sandbox after a credential changes.
  // Do not start WSL merely because Accounts was opened: a cold distro can take
  // tens of seconds, and page navigation must stay instant.
  async function mirrorToSandbox(backend?: string) {
    try {
      const r = await sandboxSyncLogins(null);
      if (r.synced.length && backend) {
        logInfo(backend, `🔑 Now available to isolated agents in WSL: ${r.synced.join(", ")}.`);
      }
    } catch { /* no WSL on this machine — nothing to mirror into */ }
  }

  async function handleConnect(
    route: RouteSpec,
    provider: ProviderSpec,
    resetStaleLogin = false,
  ) {
    if (route.kind === "subscription") {
      if (route.webOnly) {
        logInfo(route.backend, `Opening ${route.webOnly.url} in your browser…`);
        openWebUrl(route.webOnly.url).catch((e) => {
          logInfo(route.backend, `[error] couldn't open browser: ${e}`);
        });
        return;
      }
      // CLI-backed subscription: spawn the CLI inside our embedded
      // terminal (right rail, Terminal tab). No pop-out CMD any more.
      const recipe = LOGIN_CMD[route.backend];
      if (!recipe) {
        logInfo(route.backend, `[error] no spawn recipe for ${route.backend}`);
        return;
      }
      if (resetStaleLogin) {
        try {
          await invoke<string>("subscription_cli_logout", { backend: route.backend });
          setCardState(route.key, {
            connected: false,
            reauthRequired: false,
            remediation: null,
            testText: "",
            testOk: null,
          });
          logInfo(route.backend, `Removed the expired ${provider.name} session. Starting a fresh login.`);
        } catch (e: any) {
          logInfo(route.backend, `[error] couldn't reset the expired ${provider.name} session: ${e?.message ?? e}`);
          return;
        }
      }
      const hint: Record<string, string> = {
        claude_cli: "auto-running /login — complete the browser sign-in.",
        codex_cli:  "the device page opens in OwLLM's browser; enter the code shown here.",
        kimi_cli:   "the authorization page opens in OwLLM's browser automatically.",
        gemini_cli: "auto-running /auth — choose Google sign-in, then complete the browser flow.",
        grok_cli:   "the xAI device page opens in OwLLM's browser; confirm the code shown here.",
      };
      logInfo(route.backend, `Opening ${provider.name} CLI in the embedded terminal — ${hint[route.backend] ?? ""}`);
      completedLogins.current.delete(route.backend);
      terminalOutput.current[route.backend] = "";
      delete authTabs.current[route.backend];
      setActiveTerm({
        cli: recipe.cli,
        args: recipe.args,
        backend: route.backend,
        providerName: provider.name,
        send: recipe.send,
      });
      setRailTab("terminal");
    } else {
      setDialogFor({ route, provider });
    }
  }

  function handleAuthTabOpened(backend: string, tabId: number) {
    authTabs.current[backend] = tabId;
  }

  function handleTerminalOutput(backend: string, text: string) {
    const buffered = `${terminalOutput.current[backend] ?? ""}${text}`.slice(-16_384);
    terminalOutput.current[backend] = buffered;
    if (backend !== "kimi_cli" || completedLogins.current.has(backend)) return;

    const success = isKimiLoginSuccess(buffered);
    if (!success) {
      if (/"type"\s*:\s*"error"/i.test(buffered)) {
        completedLogins.current.add(backend);
        const remediation = classifySubscriptionFailure(buffered);
        setCardState("kimi_subscription", {
          connected: false,
          reauthRequired: remediation === "reauth",
          remediation,
          testText: `✗  Kimi login failed. ${remediation === "update" ? "Update the CLI and try again." : "Reconnect and follow the browser authorization again."}`,
          testOk: false,
        });
        logInfo(backend, "✗ Kimi login failed. The card now shows the required recovery action.");
        setRailTab("log");
      }
      return;
    }

    completedLogins.current.add(backend);
    const route = allRoutes.find((item) => item.backend === backend);
    if (route) {
      setCardState(route.key, {
        connected: true,
        reauthRequired: false,
        remediation: null,
        testText: "✓  Kimi login completed. Validating the subscription…",
        testOk: true,
      });
    }
    logInfo(backend, "✓ Kimi authentication completed. Validating the subscription now.");
    const tabId = authTabs.current[backend];
    if (typeof tabId === "number") {
      invoke<string>("browser_cmd", {
        action: "auth_complete",
        params: { provider: "Kimi", tab_id: tabId },
      }).catch((error) => logInfo(backend, `[browser] couldn't show completion page: ${String(error)}`));
    }
    setRailTab("log");
    void mirrorToSandbox(backend);
    if (route) {
      window.setTimeout(() => { void probeSubscriptionHealth(route, false); }, 700);
    }
  }

  function handleCloseTerm() {
    const backend = activeTerm?.backend;
    setActiveTerm(null);
    setRailTab("log");
    // A login likely just completed in the terminal → mirror it into the
    // sandbox immediately so isolated agents are authenticated, no manual sync.
    mirrorToSandbox(backend);
  }

  function handleInstall(route: RouteSpec, provider: ProviderSpec) {
    if (route.kind !== "subscription" || route.webOnly) return;
    if ((cards[route.key]?.installing)) return;
    setCardState(route.key, { installing: true });
    logInfo(route.backend, `Installing ${provider.name} CLI…`);

    const channel = new Channel<{ kind: string; stream?: string; text?: string; code?: number | null }>();
    channel.onmessage = (evt) => {
      if (evt.kind === "line") {
        LOG_HUB.push({
          ts: Date.now(),
          stream: (evt.stream === "stderr" ? "stderr" : "stdout"),
          text: evt.text ?? "",
          backend: route.backend,
        });
      } else if (evt.kind === "done") {
        const ok = evt.code === 0;
        logInfo(route.backend, ok
          ? `✓ install finished — click Connect on the same row to log in.`
          : `✗ install failed (exit ${evt.code ?? "?"}); see lines above.`);
        setCardState(route.key, {
          installing: false,
          ...(ok ? { remediation: null } : { remediation: "retry" as const }),
        });
        if (ok) {
          window.setTimeout(() => { void probeSubscriptionHealth(route, false); }, 500);
        }
      }
    };
    invoke("cli_install_stream", { backend: route.backend, onEvent: channel }).catch(async (e) => {
      const msg = String(e);
      // Auto-recover from the most common first-run failure: Node.js
      // not installed. The bundled MCP Server Toolchain module ships
      // node 20 + uv, so we offer to install it inline and retry the
      // CLI install without making the user navigate to the Modules
      // tab manually.
      const nodeMissing = /node\.?js/i.test(msg) && /not installed|not found/i.test(msg);
      if (nodeMissing) {
        logInfo(route.backend, `[error] ${msg}`);
        setCardState(route.key, { installing: false });
        try {
          const { ask } = await import("@tauri-apps/plugin-dialog");
          const proceed = await ask(
            translateUiText(`${provider.name} CLI needs Node.js, which isn't installed yet.\n\nInstall the bundled Node.js + uv toolchain now? (~47 MB, one-time download)\n\nAfter it finishes I'll retry the ${provider.name} CLI install automatically.`),
            { title: translateUiText("Install Node.js toolchain?"), kind: "info" },
          );
          if (!proceed) return;
          logInfo(route.backend, `Installing MCP Server Toolchain (Node.js 20 + uv)…`);
          setCardState(route.key, { installing: true });
          await invoke("module_install", { id: "mcp-toolchain" });
          logInfo(route.backend, `✓ MCP Server Toolchain installed. Retrying ${provider.name} CLI install…`);
          // Retry — the new module_node_dir() lookup will find the
          // bundled npm.cmd on this attempt.
          handleInstall(route, provider);
        } catch (e2) {
          logInfo(route.backend, `[error] toolchain install failed: ${String(e2)}`);
          setCardState(route.key, { installing: false });
        }
        return;
      }
      logInfo(route.backend, `[error] ${msg}`);
      setCardState(route.key, { installing: false });
    });
  }

  async function handleDisconnect(route: RouteSpec, provider: ProviderSpec) {
    try {
      if (route.kind === "api" && route.envName) {
        await invoke("accounts_delete_secret", { name: route.envName });
        setCardState(route.key, { connected: false, reauthRequired: false, remediation: null, testText: "", testOk: null });
        logInfo(route.backend, `Removed ${provider.name} API key from local store.`);
      } else {
        // Web-only sub (Grok/DeepSeek) has nothing to wipe locally —
        // their "connection" is just the browser tab the user opened.
        if (route.webOnly) {
          logInfo(route.backend, `${provider.name} subscription is web-only — sign out at ${route.webOnly.url} if you want.`);
          return;
        }
        // CLI subscription: wipe the local credentials file so the
        // 3-s status poll flips us to disconnected and the next
        // Connect triggers a fresh OAuth. Was previously a no-op
        // that just printed a "run kimi /logout yourself" hint and
        // left the broken green card in place.
        const summary = await invoke<string>("subscription_cli_logout", { backend: route.backend });
        setCardState(route.key, { connected: false, reauthRequired: false, remediation: null, testText: "", testOk: null });
        logInfo(route.backend, `${provider.name} disconnected. ${summary} Click Connect to log in again.`);
        // If the broken session's terminal is still open in the right
        // rail, close it so the user doesn't accidentally type into a
        // dead REPL.
        if (activeTerm?.backend === route.backend) {
          handleCloseTerm();
        }
      }
    } catch (e: any) {
      logInfo(route.backend, `[error] disconnect failed: ${e?.message ?? e}`);
    }
  }

  async function handleDialogSave(value: string) {
    if (!dialogFor) return;
    const { route, provider } = dialogFor;
    if (!route.envName) { setDialogFor(null); return; }
    try {
      await invoke("accounts_save_api_key", { name: route.envName, value });
      setCardState(route.key, { connected: true, reauthRequired: false, remediation: null, testText: "", testOk: null });
      logInfo(route.backend, `Saved ${provider.name} API key locally.`);
      // Push the key into the sandbox too, so isolated agents can use it — at
      // registration, automatically.
      mirrorToSandbox(route.backend);
    } catch (e: any) {
      logInfo(route.backend, `[error] save failed: ${e?.message ?? e}`);
    }
    setDialogFor(null);
  }

  async function handleTest(route: RouteSpec) {
    setCardState(route.key, { wslText: "", wslOk: null });
    await probeSubscriptionHealth(route, true);
    // Also probe the WSL sandbox — tells the user whether ISOLATED agents can
    // use this provider (creds mirrored into the distro). Non-fatal. Native
    // Linux/macOS have their own host/sandbox routing and must not show a fake
    // red WSL result.
    if (!hostIsWindows) return;
    try {
      const w = await invoke<ProbeResult>("accounts_test_probe_wsl", { backend: route.backend });
      const wline = `${w.ok ? "✓" : "✗"}  ${w.detail}`;
      setCardState(route.key, { wslText: wline, wslOk: w.ok });
      logInfo(route.backend, `WSL sandbox: ${wline}`);
    } catch (e: any) {
      setCardState(route.key, { wslText: `✗  ${String(e?.message ?? e)}`, wslOk: false });
    }
  }

  return (
    <div
      style={{
        padding: "24px 28px 24px 28px",
        height: "100%",
        background: PAGE_BG,
        display: "flex",
        flexDirection: "column",
        gap: 18,
        overflow: "hidden",
        boxSizing: "border-box",
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 800, color: "var(--fg-strong)" }}>Accounts</div>
      <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        Each provider gets one card with both ways to access it: subscription
        (CLI login or web portal) and API key. Install / Connect output streams
        live into the right-side log — no pop-out console.
      </div>
      {onboardingProvider && (
        <div data-ui="AccountOnboardingHint" style={{
          display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
          padding: "11px 14px", borderRadius: 11,
          background: "rgba(var(--accent-rgb),0.11)",
          border: "1px solid var(--accent-strong)", color: "var(--fg)",
        }}>
          <span aria-hidden="true" style={{ fontSize: 20 }}>✨</span>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: "var(--fg-strong)" }}>
              {onboardingProvider === "api"
                ? "Add the API key you already use"
                : `Connect your ${PROVIDERS.find((provider) => provider.key === onboardingProvider)?.name ?? "subscription"} account`}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--fg-muted)", marginTop: 2, lineHeight: 1.4 }}>
              {onboardingProvider === "api"
                ? "Choose a provider below, then use its API row. API usage is billed separately by that provider."
                : "Use the Subscription row in the highlighted card. Install its CLI if needed, then Connect and finish the provider’s browser login."}
            </div>
          </div>
          <button onClick={dismissOnboardingHint} style={{
            padding: "7px 11px", borderRadius: 7, border: "1px solid var(--border-strong)",
            background: "var(--bg-elevated)", color: "var(--fg)", cursor: "pointer", fontWeight: 700,
          }}>Got it</button>
        </div>
      )}
      <VoiceRuntimePanel />


      <div
        style={{
          flex: 1, minHeight: 0,
          display: "flex",
          // narrow: stack vertically with log under cards; wide: side
          // by side with log as right rail
          flexDirection: narrow ? "column" : "row",
          gap: 18,
        }}
      >
        {/* Provider grid — left column (wide) or top stack (narrow).
            grid-auto-rows: min-content is the key bit: without it the
            implicit rows can size as 1fr and overlap when there's
            leftover container height. align-items: start keeps each
            card pinned to the TOP of its row (default `stretch` would
            grow shorter cards to fill taller neighbours' row height,
            wasting space and making the layout look unbalanced).
            align-content removed for the same reason — alignItems
            does the right thing per-item without grid-wide packing
            quirks. */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflowY: "auto",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 390px))",
            gridAutoRows: "min-content",
            alignItems: "start",
            gap: 22,
            paddingRight: narrow ? 0 : 4,
            paddingBottom: 4,
          }}
        >
          {PROVIDERS.map((provider) => (
            <ProviderCard
              key={provider.key}
              provider={provider}
              cards={cards}
              highlighted={onboardingProvider === provider.key}
              hostLabel={hostLabel}
              onConnect={(r) => {
                void handleConnect(
                  r,
                  provider,
                  !!cards[r.key]?.reauthRequired || cards[r.key]?.remediation === "reauth",
                );
              }}
              onInstall={(r) => handleInstall(r, provider)}
              onDisconnect={(r) => handleDisconnect(r, provider)}
              onTest={(r) => handleTest(r)}
            />
          ))}
        </div>

        {/* Right rail — tabbed: Log + Terminal. Stacks below the
            cards when the viewport is narrow. */}
        <RightRail
          stacked={narrow}
          activeTerm={activeTerm}
          tab={railTab}
          setTab={setRailTab}
          onCloseTerm={handleCloseTerm}
          onTerminalOutput={handleTerminalOutput}
          onAuthTabOpened={handleAuthTabOpened}
        />
      </div>

      {dialogFor && (
        <ApiKeyDialog
          envName={dialogFor.route.envName!}
          onCancel={() => setDialogFor(null)}
          onSave={handleDialogSave}
        />
      )}
    </div>
  );
}

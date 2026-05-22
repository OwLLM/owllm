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
// cli_install_stream / shell_open_url. The CardState shape is per-route
// now (one CardState entry per subscription OR api spec).

import { useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import {
  AnthropicLogo, OpenAILogo, MoonshotLogo, GeminiLogo,
  DeepSeekLogo, XaiLogo, GroqLogo, PerplexityLogo,
  MistralLogo, TogetherLogo,
} from "./brandLogos";

const PAGE_BG = "var(--bg-panel)";

// -----------------------------------------------------------------------
// Backend types
// -----------------------------------------------------------------------
type AccountsStatus = {
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
  codex_cli: boolean;
  kimi_cli: boolean;
  gemini_cli: boolean;
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
      { key: "xai_subscription", kind: "subscription", routeLabel: "Subscription · SuperGrok / X Premium+", backend: "xai_web", webOnly: { url: "https://grok.com" } },
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
  testing: boolean;
  testText: string;
  testOk: boolean | null;
  installing: boolean; // true while cli_install_stream is in-flight
};
const initialCardState: CardState = {
  connected: false,
  testing: false,
  testText: "",
  testOk: null,
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
        <div style={{ color: "#bbb", fontSize: 11, lineHeight: 1.55 }}>
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
            style={{ minHeight: 30, padding: "0 14px", background: "var(--bg-surface)", color: "#ddd", border: "none", borderRadius: 6, fontSize: 12, cursor: "pointer" }}
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
  provider, route, state, onConnect, onInstall, onDisconnect, onTest,
}: {
  provider: ProviderSpec;
  route: RouteSpec;
  state: CardState;
  onConnect: () => void;
  onInstall: () => void;
  onDisconnect: () => void;
  onTest: () => void;
}) {
  const isSub = route.kind === "subscription";
  const connected = state.connected;
  const statusText = connected
    ? (isSub ? "CLI logged in" : "API key saved")
    : (isSub ? (route.webOnly ? "Web-only · sign up to subscribe" : "CLI not installed / logged in")
             : "No API key saved");

  // Subscription routes with a CLI get TWO buttons when disconnected:
  // [Install] [Connect]. Web-only subs (Grok/DeepSeek) just get
  // [Open subscription]. API routes get [Set key].
  const cliBackedSub = isSub && !route.webOnly;

  const primaryLabel =
    connected ? "Disconnect"
    : isSub ? (route.webOnly ? "Open subscription" : "Connect")
    : "Set key";

  function handlePrimary() {
    if (connected) {
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
        <StatusDot connected={connected} />
        <div style={{ flex: 1, color: "#dcdfe7", fontSize: 12 }}>
          {route.routeLabel}
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#9aa0a6", marginLeft: 17 }}>
        {statusText}
      </div>
      {state.testText && (
        <div style={{
          fontSize: 11, marginLeft: 17, wordBreak: "break-word",
          color: state.testing ? "#dcb0ff" : state.testOk ? "#4caf50" : "#ff8c8c",
        }}>
          {state.testing ? "Running probe…" : state.testText}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginLeft: 17, marginTop: 4 }}>
        {cliBackedSub && !connected && (
          <button
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
          >{state.installing ? "Installing…" : "⬇ Install CLI"}</button>
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
  provider, cards, onConnect, onInstall, onDisconnect, onTest,
}: {
  provider: ProviderSpec;
  cards: Record<string, CardState>;
  onConnect: (route: RouteSpec) => void;
  onInstall: (route: RouteSpec) => void;
  onDisconnect: (route: RouteSpec) => void;
  onTest: (route: RouteSpec) => void;
}) {
  const Logo = provider.Logo;
  return (
    <div
      style={{
        background: `linear-gradient(180deg, ${provider.accentTop} 0%, ${PAGE_BG} 60%, ${PAGE_BG} 100%)`,
        borderRadius: 14,
        padding: "18px 20px 14px 20px",
        boxShadow: "0 4px 24px rgba(0,0,0,0.47)",
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
// Right-rail log panel. Subscribes to LOG_HUB.
// -----------------------------------------------------------------------
function InstallLogPanel({ stacked = false }: { stacked?: boolean }) {
  const [lines, setLines] = useState<LogLine[]>(LOG_HUB.snapshot());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Track whether the user has scrolled up. While true, auto-scroll
  // is suppressed so new lines don't yank them away from what they
  // were reading. Re-arms (becomes false) as soon as they scroll back
  // to the bottom. Default false so the first new line auto-pins.
  const stuckBottomRef = useRef(true);

  useEffect(() => LOG_HUB.subscribe(setLines), []);

  // Listen to user scrolls and recompute the stuck-to-bottom flag.
  // We use a 6 px slop so micro-pixels of rounding don't unstick us.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stuckBottomRef.current = distFromBottom <= 6;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // After every new batch of lines, snap to the bottom IFF the user
  // hasn't scrolled away. requestAnimationFrame gives the browser a
  // chance to lay out the new line so scrollHeight is up to date.
  useEffect(() => {
    if (!stuckBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [lines]);

  return (
    <div
      style={{
        // When stacked (narrow viewport) the panel takes full width
        // below the cards instead of sitting in a 340-px right rail
        // that would otherwise crush the cards into overlap.
        width: stacked ? "100%" : 340,
        height: stacked ? 220 : "auto",
        flexShrink: 0,
        display: "flex", flexDirection: "column",
        background: "#0c0f14",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 12,
        minHeight: 0,
      }}
    >
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 14px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
      }}>
        <div style={{ color: "#dcdfe7", fontSize: 12, fontWeight: 700 }}>
          Install / login log
        </div>
        <button
          onClick={() => LOG_HUB.clear()}
          style={{
            background: "transparent", border: "none",
            color: "#9aa0a6", fontSize: 11, cursor: "pointer",
            textDecoration: "underline",
          }}
        >clear</button>
      </div>
      <div
        ref={scrollRef}
        style={{
          flex: 1, overflowY: "auto",
          padding: "8px 12px",
          fontFamily: "ui-monospace, Menlo, Consolas, monospace",
          fontSize: 11, lineHeight: 1.5,
          color: "#cfd4e1",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}
      >
        {lines.length === 0 && (
          <div style={{ color: "#5a6376", fontStyle: "italic" }}>
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

  function reconcile(status: AccountsStatus) {
    setCards((prev) => {
      const next = { ...prev };
      const flag = (key: string, connected: boolean) => {
        const cur = next[key];
        if (!cur) return;
        if (cur.connected !== connected) {
          next[key] = {
            ...cur, connected,
            ...(connected ? {} : { testText: "", testOk: null }),
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
      flag("claude_subscription",   status.claude_cli);
      flag("codex_subscription",    status.codex_cli);
      flag("kimi_subscription",     status.kimi_cli);
      flag("gemini_subscription",   status.gemini_cli);
      return next;
    });
  }

  useEffect(() => {
    let dead = false;
    const tick = async () => {
      try {
        const s = await invoke<AccountsStatus>("accounts_status");
        if (!dead) reconcile(s);
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

  function logInfo(backend: string, text: string) {
    LOG_HUB.push({ ts: Date.now(), stream: "info", text, backend });
  }

  function handleConnect(route: RouteSpec, provider: ProviderSpec) {
    if (route.kind === "subscription") {
      if (route.webOnly) {
        logInfo(route.backend, `Opening ${route.webOnly.url} in your browser…`);
        invoke("shell_open_url", { url: route.webOnly.url }).catch((e) => {
          logInfo(route.backend, `[error] couldn't open browser: ${e}`);
        });
        return;
      }
      // Per-CLI hint: how the OAuth flow actually starts so the user
      // knows what to do inside the terminal that opens. claude / kimi
      // launch a REPL that auto-prompts for /login on first run;
      // codex / gemini run a one-shot login subcommand.
      const hint: Record<string, string> = {
        claude_cli: "claude REPL will open; type `/login` if it doesn't auto-prompt.",
        codex_cli:  "codex login will open the OAuth page in your browser.",
        kimi_cli:   "kimi REPL will open; it auto-prompts for /login on first run.",
        gemini_cli: "gemini auth login will open the OAuth page in your browser.",
      };
      logInfo(route.backend, `Launching ${provider.name} CLI… ${hint[route.backend] ?? ""}`);
      invoke("subscription_cli_login", { backend: route.backend }).catch((e) => {
        const msg = String(e ?? "");
        if (/not found on PATH/i.test(msg)) {
          logInfo(route.backend, `[warn] CLI not found — click 'Install CLI' on the same row to add it via npm/pip.`);
        } else {
          logInfo(route.backend, `[error] login spawn failed: ${msg}`);
        }
      });
    } else {
      setDialogFor({ route, provider });
    }
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
        setCardState(route.key, { installing: false });
      }
    };
    invoke("cli_install_stream", { backend: route.backend, onEvent: channel }).catch((e) => {
      logInfo(route.backend, `[error] ${String(e)}`);
      setCardState(route.key, { installing: false });
    });
  }

  async function handleDisconnect(route: RouteSpec, provider: ProviderSpec) {
    try {
      if (route.kind === "api" && route.envName) {
        await invoke("accounts_delete_secret", { name: route.envName });
      } else {
        const cmd = route.backend === "claude_cli"  ? "claude /logout"
                  : route.backend === "codex_cli"   ? "codex logout"
                  : route.backend === "kimi_cli"    ? "kimi /logout"
                  : route.backend === "gemini_cli"  ? "gemini auth logout"
                  : `${route.backend} logout`;
        logInfo(route.backend, `[info] Run \`${cmd}\` in a terminal to fully sign out (we don't auto-delete CLI creds).`);
        return;
      }
      setCardState(route.key, { connected: false, testText: "", testOk: null });
      logInfo(route.backend, `Removed ${provider.name} API key from local store.`);
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
      setCardState(route.key, { connected: true, testText: "", testOk: null });
      logInfo(route.backend, `Saved ${provider.name} API key locally.`);
    } catch (e: any) {
      logInfo(route.backend, `[error] save failed: ${e?.message ?? e}`);
    }
    setDialogFor(null);
  }

  async function handleTest(route: RouteSpec) {
    setCardState(route.key, { testing: true, testText: "", testOk: null });
    try {
      const r = await invoke<ProbeResult>("accounts_test_probe", { backend: route.backend });
      const prefix = r.ok ? "✓" : "✗";
      setCardState(route.key, {
        testing: false,
        testText: `${prefix}  ${r.detail}  ·  ${r.elapsed_ms} ms`,
        testOk: r.ok,
      });
    } catch (e: any) {
      setCardState(route.key, {
        testing: false,
        testText: `✗  ${String(e?.message ?? e)}`,
        testOk: false,
      });
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
        {/* Provider grid — left column (wide) or top stack (narrow) */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflowY: "auto",
            display: "grid",
            // 90 px narrower than v1 (480 → 390). minmax floor 260 lets
            // cards shrink into a single column on tiny windows instead
            // of overlapping their neighbours.
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 390px))",
            columnGap: 18,
            rowGap: 18,
            alignContent: "start",
            paddingRight: narrow ? 0 : 4,
          }}
        >
          {PROVIDERS.map((provider) => (
            <ProviderCard
              key={provider.key}
              provider={provider}
              cards={cards}
              onConnect={(r) => handleConnect(r, provider)}
              onInstall={(r) => handleInstall(r, provider)}
              onDisconnect={(r) => handleDisconnect(r, provider)}
              onTest={(r) => handleTest(r)}
            />
          ))}
        </div>

        {/* In-app log panel — right rail when wide, bottom dock when narrow */}
        <InstallLogPanel stacked={narrow} />
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

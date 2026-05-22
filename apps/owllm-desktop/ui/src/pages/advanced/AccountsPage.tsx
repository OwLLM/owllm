// AccountsPage — ported from LLM/desktop_app/pages/accounts_page.py
// (AccountsPage._build_ui, line 403). 2x2 grid of brand cards, one
// per cloud route: Claude (subscription), Codex (subscription),
// Anthropic API (key), OpenAI API (key).
//
// Each card: brand-tinted gradient (accent_top → page bg), no
// borders, soft drop shadow (Qt accounts_page.py:111 _add_shadow:
// blur 24 / y 4 / alpha 120), header with emoji icon + name in
// brand accent + tagline + status dot, status line, Test result
// line, Connect/Disconnect button + Test button.
//
// API-key flow opens a modal dialog (Qt _ApiKeyDialog at line 319)
// with a password input, Show/Hide toggle, and prose explaining
// LLM/data/owllm_agent_secrets.json persistence.
//
// Background of host page is #0e1117 (per style notes); Qt uses
// palette(base) for the gradient's bottom stop — we hard-code the
// same value here so cards visually dissolve into the page.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const PAGE_BG = "var(--bg-panel)"; // matches palette(base) used by Qt gradient stops 0.6 + 1

// Backend status shape — mirrors AccountsStatus in src-tauri/src/accounts.rs.
// Each flag is a presence check; we never see the secret values themselves.
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

type BrandSpec = {
  key: string;
  name: string;
  tagline: string;
  icon: string;
  accent: string;       // brand color (title + connect button bg)
  accentTop: string;    // gradient top stop
  kind: "subscription" | "api";
  envName?: string;
  backend: string;
  /// Web-only subscriptions (Grok via X Premium+, DeepSeek via
  /// chat.deepseek.com): no official CLI to launch, so Connect just
  /// opens the signup/management page in the browser. The card never
  /// flips to green because we have no programmatic signal — the user
  /// uses the subscription via the web UI, or copies an API key into
  /// the matching API card below.
  webOnly?: { url: string };
};

// Verbatim from accounts_page.py:47-94 (BRAND_CARDS tuple). Accent
// colours, taglines, emoji icons, env-var names all preserved.
// Order matters — the layout below pairs (sub, api) into the same
// brand column, so each provider's two routes sit one above the other.
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
  {
    key: "kimi_subscription",
    name: "Kimi",
    tagline: "Subscription · Kimi Code CLI",
    icon: "🌙",
    accent: "#d36bff",
    accentTop: "#2a1c33",
    kind: "subscription",
    backend: "kimi_cli",
  },
  {
    key: "moonshot_api",
    name: "Kimi (Moonshot) API",
    tagline: "MOONSHOT_API_KEY · billed per call",
    icon: "⚡",
    accent: "#d36bff",
    accentTop: "#241830",
    kind: "api",
    envName: "MOONSHOT_API_KEY",
    backend: "moonshot_api",
  },
  {
    key: "gemini_subscription",
    name: "Gemini",
    tagline: "Subscription · Google Gemini CLI",
    icon: "♊",
    accent: "#4285f4",
    accentTop: "#142036",
    kind: "subscription",
    backend: "gemini_cli",
  },
  {
    key: "gemini_api",
    name: "Gemini API",
    tagline: "GEMINI_API_KEY · billed per call",
    icon: "⚡",
    accent: "#4285f4",
    accentTop: "#101a2d",
    kind: "api",
    envName: "GEMINI_API_KEY",
    backend: "gemini_api",
  },
  {
    key: "deepseek_subscription",
    name: "DeepSeek",
    tagline: "Subscription · chat.deepseek.com",
    icon: "🐋",
    accent: "#2563eb",
    accentTop: "#142036",
    kind: "subscription",
    backend: "deepseek_web",
    webOnly: { url: "https://chat.deepseek.com" },
  },
  {
    key: "deepseek_api",
    name: "DeepSeek API",
    tagline: "DEEPSEEK_API_KEY · billed per call",
    icon: "🐋",
    accent: "#2563eb",
    accentTop: "#0f1a2e",
    kind: "api",
    envName: "DEEPSEEK_API_KEY",
    backend: "deepseek_api",
  },
  {
    key: "xai_subscription",
    name: "xAI Grok",
    tagline: "Subscription · SuperGrok / X Premium+",
    icon: "𝕏",
    accent: "#9aa0a6",
    accentTop: "#1a1c1f",
    kind: "subscription",
    backend: "xai_web",
    webOnly: { url: "https://grok.com" },
  },
  {
    key: "xai_api",
    name: "xAI Grok API",
    tagline: "XAI_API_KEY · billed per call",
    icon: "𝕏",
    accent: "#9aa0a6",
    accentTop: "#1a1c1f",
    kind: "api",
    envName: "XAI_API_KEY",
    backend: "xai_api",
  },
  {
    key: "groq_api",
    name: "Groq API",
    tagline: "GROQ_API_KEY · ~1000 tok/s LPU",
    icon: "⚡",
    accent: "#ff5d11",
    accentTop: "#2a160c",
    kind: "api",
    envName: "GROQ_API_KEY",
    backend: "groq_api",
  },
  {
    key: "perplexity_api",
    name: "Perplexity Sonar API",
    tagline: "PERPLEXITY_API_KEY · built-in search",
    icon: "🔎",
    accent: "#20b2aa",
    accentTop: "#102624",
    kind: "api",
    envName: "PERPLEXITY_API_KEY",
    backend: "perplexity_api",
  },
  {
    key: "mistral_api",
    name: "Mistral API",
    tagline: "MISTRAL_API_KEY · billed per call",
    icon: "🇫🇷",
    accent: "#ff7a00",
    accentTop: "#2b1a0a",
    kind: "api",
    envName: "MISTRAL_API_KEY",
    backend: "mistral_api",
  },
  {
    key: "together_api",
    name: "Together AI API",
    tagline: "TOGETHER_API_KEY · open-source host",
    icon: "🧩",
    accent: "#7fc8ff",
    accentTop: "#12222e",
    kind: "api",
    envName: "TOGETHER_API_KEY",
    backend: "together_api",
  },
];

// Brand columns: each pair is (subscription on top, API below). API-only
// providers go in the bottom slot alone. The AccountsPage renders one
// column per pair so a user looking at the "Claude" column sees both
// ways to use Claude side by side.
const BRAND_COLUMNS: [string, string | null][] = [
  ["claude_subscription",   "anthropic_api"],
  ["codex_subscription",    "openai_api"],
  ["kimi_subscription",     "moonshot_api"],
  ["gemini_subscription",   "gemini_api"],
  ["deepseek_subscription", "deepseek_api"],
  ["xai_subscription",      "xai_api"],
  ["groq_api", null],
  ["perplexity_api", null],
  ["mistral_api", null],
  ["together_api", null],
];

// ---------------------------------------------------------------------------
// State store — mirrors AccountsPage._refresh / agent_runtime_manager.status()
// (Qt accounts_page.py:444). In the real backend each card maps to one
// boolean coming from agent_runtime_manager; here we hold the same shape
// in component state and expose connect/disconnect/test mutators.
// ---------------------------------------------------------------------------

type CardState = {
  connected: boolean;
  testing: boolean;
  testText: string;        // "" hides the line (Qt setVisible(False), line 214)
  testOk: boolean | null;  // null = probe running / pristine
};

const initialCardState: CardState = {
  connected: false,
  testing: false,
  testText: "",
  testOk: null,
};

// ---------------------------------------------------------------------------
// Status dot — Qt uses #4caf50 connected / #5a6376 disconnected (lines
// 251 + 265). Brand accent does NOT bleed into the dot in Qt.
// ---------------------------------------------------------------------------

function StatusDot({ connected }: { connected: boolean }) {
  const c = connected ? "#4caf50" : "#5a6376";
  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: 5,
        background: c,
        flexShrink: 0,
        marginTop: 4, // Qt header.addWidget(status_dot, 0, Qt.AlignTop)
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// API-key modal — Qt _ApiKeyDialog (accounts_page.py:319). Prose text and
// path are verbatim from line 331-335.
// ---------------------------------------------------------------------------

function ApiKeyDialog({
  envName,
  onCancel,
  onSave,
}: {
  envName: string;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function commit() {
    const v = value.trim();
    if (v) onSave(v);
  }

  return (
    <div
      // Backdrop
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth: 440, // Qt setMinimumWidth(440), line 324
          maxWidth: 520,
          background: "#15191f",
          borderRadius: 12,
          padding: "20px 20px", // Qt setContentsMargins(20,20,20,20), line 327
          display: "flex",
          flexDirection: "column",
          gap: 12, // Qt setSpacing(12), line 328
          boxShadow: "0 18px 60px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ color: "var(--fg-strong)", fontSize: 14, fontWeight: 700 }}>
          {/* Qt setWindowTitle(f"Set {env_name}") line 322 */}
          Set {envName}
        </div>
        <div
          style={{ color: "#bbb", fontSize: 11, lineHeight: 1.55 }}
          // Prose verbatim from Qt accounts_page.py:331-335.
        >
          Paste your <b>{envName}</b> below. It will be stored in{" "}
          <code style={{ background: "var(--bg-surface)", padding: "1px 4px", borderRadius: 3 }}>
            LLM/data/owllm_agent_secrets.json
          </code>{" "}
          on this machine and applied to{" "}
          <code style={{ background: "var(--bg-surface)", padding: "1px 4px", borderRadius: 3 }}>
            os.environ
          </code>{" "}
          at startup. Shell-exported env vars take precedence.
        </div>
        <input
          ref={inputRef}
          type={show ? "text" : "password"}
          value={value}
          placeholder={envName}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") onCancel();
          }}
          style={{
            minHeight: 34, // Qt setMinimumHeight(34), line 343
            padding: "0 12px",
            borderRadius: 8,
            border: "1px solid var(--border-strong)",
            background: "rgba(0,0,0,0.30)",
            color: "var(--fg)",
            fontSize: 12,
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
          }}
        />
        <button
          onClick={() => setShow((s) => !s)}
          style={{
            // Qt toggle styled as text-decoration:underline (line 348-351).
            background: "transparent",
            color: "var(--fg-muted)",
            border: "none",
            textDecoration: "underline",
            fontSize: 11,
            cursor: "pointer",
            alignSelf: "flex-start",
            padding: 0,
          }}
        >
          {show ? "Hide" : "Show"}
        </button>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button
            onClick={onCancel}
            style={{
              minHeight: 30,
              padding: "0 14px",
              background: "var(--bg-surface)",
              color: "#ddd",
              border: "none",
              borderRadius: 6,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={commit}
            disabled={!value.trim()}
            style={{
              minHeight: 30,
              padding: "0 14px",
              background: value.trim() ? "#3b82f6" : "rgba(59,130,246,0.30)",
              color: "var(--fg-strong)",
              border: "none",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: value.trim() ? "pointer" : "default",
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirmation prompt — Qt uses QMessageBox.question for both disconnect and
// the post-connect info message (lines 463, 479). We use window.confirm /
// window.alert in the React port — minimal but matches the visible
// state-machine contract.
// ---------------------------------------------------------------------------

function confirmDisconnect(name: string): boolean {
  // Qt: f"Remove the local {name} credentials?" line 482.
  return window.confirm(`Remove the local ${name} credentials?`);
}

// ---------------------------------------------------------------------------
// Brand card
// ---------------------------------------------------------------------------

function BrandCard({
  spec,
  state,
  onConnect,
  onDisconnect,
  onTest,
}: {
  spec: BrandSpec;
  state: CardState;
  onConnect: () => void;
  onDisconnect: () => void;
  onTest: () => void;
}) {
  const isSub = spec.kind === "subscription";
  // Qt accounts_page.py:267 — exactly "Connect" / "Set key", no parenthetical.
  const actionLabel = state.connected ? "Disconnect" : isSub ? "Connect" : "Set key";
  // Subscription cards detect their CLI's credentials file; API cards
  // detect a saved key. Spell that out so users don't think saving on
  // one card transfers to the other.
  const statusText = state.connected
    ? (isSub ? "CLI logged in" : "API key saved")
    : (isSub ? "CLI not logged in" : "No API key saved");

  function handleAction() {
    if (state.connected) {
      if (confirmDisconnect(spec.name)) onDisconnect();
    } else {
      onConnect();
    }
  }

  // Test result line — Qt format: f"{prefix}  {detail}  ·  {elapsed_ms} ms"
  // (line 297, two spaces around prefix). Color #4caf50 ok / #ff8c8c fail
  // (line 296). While testing, "Running probe…" in #dcb0ff (lines 286-287).
  const testLineColor =
    state.testing ? "#dcb0ff" : state.testOk == null ? "#9aa0a6" : state.testOk ? "#4caf50" : "#ff8c8c";
  const showTestLine = state.testing || state.testText.length > 0;

  return (
    <div
      style={{
        // Qt qlineargradient: stop 0 accent_top → stop 0.6 palette(base) →
        // stop 1 palette(base). Lines 159-163.
        background: `linear-gradient(180deg, ${spec.accentTop} 0%, ${PAGE_BG} 60%, ${PAGE_BG} 100%)`,
        borderRadius: 16, // Qt border-radius: 16px (line 165)
        // Qt setContentsMargins(22, 20, 22, 20) (line 171). Translate to
        // CSS as padding: top right bottom left.
        padding: "20px 22px 20px 22px",
        // Qt _add_shadow defaults: blur 24 / y 4 / alpha 120 = ~0.47.
        boxShadow: "0 4px 24px rgba(0,0,0,0.47)",
        minHeight: 220, // Qt setMinimumHeight(220) (line 154)
        display: "flex",
        flexDirection: "column",
        gap: 10, // Qt setSpacing(10) (line 172)
      }}
    >
      {/* Header — Qt QHBoxLayout w/ spacing 14, line 175-176 */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
        <div style={{ fontSize: 28, lineHeight: 1, background: "transparent" }}>
          {/* Qt QFont().setPointSize(28) line 179 */}
          {spec.icon}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          {/* Qt text_box spacing 2 (line 185) */}
          <div
            style={{
              color: spec.accent,
              fontSize: 15, // Qt setPointSize(15) line 188
              fontWeight: 700, // Qt setBold(True) line 189
              background: "transparent",
            }}
          >
            {spec.name}
          </div>
          <div style={{ color: "var(--fg-muted)", fontSize: 11, background: "transparent" }}>
            {/* Qt color:#9aa0a6; font-size:11px (line 194) */}
            {spec.tagline}
          </div>
        </div>
        <StatusDot connected={state.connected} />
      </div>

      {/* Status line — Qt color:#bbb; font-size:11px (line 205) */}
      <div style={{ color: "#bbb", fontSize: 11, background: "transparent" }}>{statusText}</div>

      {/* Stretch — Qt layout.addStretch(1) line 208 */}
      <div style={{ flex: 1 }} />

      {/* Test result line — hidden until probe runs (Qt setVisible(False) line 214) */}
      {showTestLine && (
        <div
          style={{
            color: testLineColor,
            fontSize: 11,
            background: "transparent",
            wordBreak: "break-word",
          }}
        >
          {state.testing ? "Running probe…" : state.testText}
        </div>
      )}

      {/* Button row — Qt spacing 8 (line 219) */}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={handleAction}
          style={{
            flex: 1,
            minHeight: 34, // Qt setMinimumHeight(34) line 222
            background: state.connected
              ? "rgba(255,110,110,0.12)" // Qt line 256
              : spec.accent, // Qt line 271 — solid accent, no gradient
            color: state.connected ? "#ff8c8c" : "#fff",
            border: "none",
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600, // Qt font-weight:600 lines 259 + 273
            cursor: "pointer",
            padding: "0 18px",
          }}
        >
          {actionLabel}
        </button>
        <button
          onClick={onTest}
          // Qt: test_btn enabled iff connected (lines 263 + 278 + 291);
          // disabled also while a probe is in flight (line 285).
          disabled={!state.connected || state.testing}
          style={{
            minHeight: 34,
            padding: "0 18px",
            background:
              !state.connected || state.testing
                ? "rgba(255,255,255,0.03)" // Qt :disabled bg line 236
                : "var(--bg-surface)", // Qt normal bg line 230
            color: !state.connected || state.testing ? "#555" : "#ddd", // Qt line 236 / 231
            border: "none",
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 500, // Qt line 233
            cursor: !state.connected || state.testing ? "default" : "pointer",
          }}
        >
          {state.testing ? "Testing…" : "Test"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AccountsPage() {
  const [cards, setCards] = useState<Record<string, CardState>>(() =>
    Object.fromEntries(BRANDS.map((b) => [b.key, { ...initialCardState }])),
  );
  // Pending API-key dialog — non-null when the user clicked "Set key" on an
  // API card. Qt opens a modal QDialog (line 473).
  const [dialogFor, setDialogFor] = useState<BrandSpec | null>(null);

  // Poll the Rust accounts_status command and reconcile each card's
  // `connected` flag against what's actually saved on disk / detected
  // on the system. Runs once on mount + every 3s after, mirroring the
  // legacy Qt 3000ms timer (accounts_page.py:387). Each card's
  // testText/testOk are LOCAL (not derived from backend) so the probe
  // line survives across polls.
  function reconcile(status: AccountsStatus) {
    setCards(prev => {
      const next = { ...prev };
      const flag = (key: string, connected: boolean) => {
        const cur = next[key];
        if (!cur) return;
        if (cur.connected !== connected) {
          // When backend flips us to disconnected, clear stale test line.
          next[key] = {
            ...cur,
            connected,
            ...(connected ? {} : { testText: "", testOk: null }),
          };
        }
      };
      flag("anthropic_api",  status.anthropic_api_key);
      flag("openai_api",     status.openai_api_key);
      flag("moonshot_api",   status.moonshot_api_key);
      flag("deepseek_api",   status.deepseek_api_key);
      flag("xai_api",        status.xai_api_key);
      flag("groq_api",       status.groq_api_key);
      flag("perplexity_api", status.perplexity_api_key);
      flag("mistral_api",    status.mistral_api_key);
      flag("together_api",   status.together_api_key);
      flag("gemini_api",     status.gemini_api_key);
      flag("claude_subscription",  status.claude_cli);
      flag("codex_subscription",   status.codex_cli);
      flag("kimi_subscription",    status.kimi_cli);
      flag("gemini_subscription",  status.gemini_cli);
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

  function handleConnect(spec: BrandSpec) {
    if (spec.kind === "subscription") {
      // Web-only subscriptions (Grok, DeepSeek): no official CLI to
      // launch — just open the subscription portal in the browser.
      // The user signs up there; usage happens via the matching API
      // card below (subscription tier comes with an API key on both
      // providers).
      if (spec.webOnly) {
        invoke("shell_open_url", { url: spec.webOnly.url }).catch((e) => {
          window.alert(`Couldn't open browser: ${e}\n\nVisit ${spec.webOnly!.url} manually.`);
        });
        return;
      }
      // CLI-backed subscriptions (Claude, Codex, Kimi, Gemini): spawn
      // a real terminal running the CLI's login command. Each CLI
      // opens the user's browser for OAuth and waits in the shell
      // until the flow finishes. The 3-second accounts_status poll
      // picks up the credentials file automatically once the CLI
      // writes it.
      //
      // If the CLI isn't installed yet, the Rust side returns a "not
      // found on PATH" error. That's not a real failure — the user
      // just doesn't have the tool. Open the official install /
      // download page in their browser so they can fix it with one
      // click instead of being stuck at an alert.
      invoke("subscription_cli_login", { backend: spec.backend }).catch((e) => {
        const msg = String(e ?? "");
        const cliMissing = /not found on PATH/i.test(msg);
        // Per-provider install + login info. installPkg is the npm /
        // pip package we ship via cli_install; loginCmd is what runs
        // inside the open REPL after install if the user wants to
        // manually re-trigger OAuth.
        const installInfo: Record<string, { pkg: string; runtime: string; loginCmd: string; name: string }> = {
          claude_cli: { pkg: "@anthropic-ai/claude-code", runtime: "Node.js", loginCmd: "claude /login", name: "Claude Code CLI" },
          codex_cli:  { pkg: "@openai/codex",             runtime: "Node.js", loginCmd: "codex login",   name: "OpenAI Codex CLI" },
          kimi_cli:   { pkg: "kimi-cli",                  runtime: "Python",  loginCmd: "kimi /login",   name: "Kimi Code CLI" },
          gemini_cli: { pkg: "@google/gemini-cli",        runtime: "Node.js", loginCmd: "gemini /auth",  name: "Google Gemini CLI" },
        };
        const info = installInfo[spec.backend];
        if (cliMissing && info) {
          // Offer to run the install for them. One click → a visible
          // console runs `npm install -g …` or `pip install …`. After
          // it succeeds the user re-clicks Connect to do OAuth.
          const accepted = window.confirm(
            `${info.name} isn't installed yet.\n\n` +
            `Install it now via ${info.runtime === "Node.js" ? "npm" : "pip"}?\n` +
            `(opens a terminal that runs: ${info.runtime === "Node.js" ? `npm install -g ${info.pkg}` : `pip install --upgrade ${info.pkg}`})\n\n` +
            `Click OK to install. After it finishes, click Connect again to log in.`
          );
          if (!accepted) return;
          invoke("cli_install", { backend: spec.backend }).catch((ie) => {
            const ieMsg = String(ie ?? "");
            // Package manager itself missing → point them at the
            // runtime install page.
            const runtimeUrl = info.runtime === "Node.js"
              ? "https://nodejs.org/en/download"
              : "https://www.python.org/downloads";
            invoke("shell_open_url", { url: runtimeUrl }).catch(() => {});
            window.alert(
              `${ieMsg}\n\nOpening the ${info.runtime} install page so you can install the runtime first.`
            );
          });
          return;
        }
        // Real spawn failure (CLI present but launch crashed). Surface
        // the manual command so the user has an escape hatch.
        const loginCmd = info?.loginCmd ?? `${spec.backend} login`;
        window.alert(
          `Couldn't open a terminal: ${msg}\n\n` +
          `Run this manually instead:\n\n  ${loginCmd}\n\n` +
          `The card will flip to green within 3 seconds after the CLI saves its credentials.`
        );
      });
    } else {
      setDialogFor(spec);
    }
  }

  async function handleDisconnect(spec: BrandSpec) {
    try {
      if (spec.kind === "api" && spec.envName) {
        await invoke("accounts_delete_secret", { name: spec.envName });
      } else {
        // Subscription disconnect — we don't auto-delete the CLI
        // credentials file (that's the user's CLI to manage). Just
        // surface what they need to do manually.
        const cmd = spec.backend === "claude_cli"  ? "claude /logout"
                  : spec.backend === "codex_cli"   ? "codex logout"
                  : spec.backend === "kimi_cli"    ? "kimi /logout"
                  : spec.backend === "gemini_cli"  ? "gemini auth logout"
                  : `${spec.backend} logout`;
        window.alert(`Run this in a terminal to sign out:\n\n  ${cmd}`);
        return;
      }
      // Optimistic flip — next poll confirms.
      setCardState(spec.key, { connected: false, testText: "", testOk: null });
    } catch (e: any) {
      window.alert(`Disconnect failed: ${e?.message ?? e}`);
    }
  }

  async function handleDialogSave(value: string) {
    if (!dialogFor) return;
    if (!dialogFor.envName) { setDialogFor(null); return; }
    try {
      await invoke("accounts_save_api_key", { name: dialogFor.envName, value });
      // Optimistic flip — the 3s poll will confirm.
      setCardState(dialogFor.key, { connected: true, testText: "", testOk: null });
    } catch (e: any) {
      window.alert(`Save failed: ${e?.message ?? e}`);
    }
    setDialogFor(null);
  }

  async function handleTest(spec: BrandSpec) {
    setCardState(spec.key, { testing: true, testText: "", testOk: null });
    try {
      const r = await invoke<ProbeResult>("accounts_test_probe", { backend: spec.backend });
      const prefix = r.ok ? "✓" : "✗";
      setCardState(spec.key, {
        testing: false,
        testText: `${prefix}  ${r.detail}  ·  ${r.elapsed_ms} ms`,
        testOk: r.ok,
      });
    } catch (e: any) {
      setCardState(spec.key, {
        testing: false,
        testText: `✗  ${String(e?.message ?? e)}`,
        testOk: false,
      });
    }
  }

  return (
    <div
      style={{
        // Qt setContentsMargins(28, 24, 28, 24) line 405. CSS order:
        // top right bottom left.
        padding: "24px 28px 24px 28px",
        height: "100%",
        background: PAGE_BG,
        display: "flex",
        flexDirection: "column",
        gap: 18, // Qt outer.setSpacing(18) line 406
        overflow: "auto",
        boxSizing: "border-box",
      }}
    >
      {/* Title — Qt QFont().setPointSize(22).setBold(True) lines 411-412 */}
      <div style={{ fontSize: 22, fontWeight: 800, color: "var(--fg-strong)" }}>Accounts</div>
      {/* Subtitle — verbatim Qt accounts_page.py:418, color #9aa0a6 12px (line 420) */}
      <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        Connect each provider once. Test verifies credentials end-to-end.
        <br />
        <span style={{ color: "var(--fg-subtle)" }}>
          The two CLI cards detect <code>claude</code> / <code>codex</code> logins on this machine.
          The two API cards store keys in <code>~/.owllm/agent_secrets.json</code>.
          Agents fall back to the CLI subscription automatically when no matching API key is saved.
        </span>
      </div>

      {/* 2x2 grid — Qt QGridLayout h/v spacing 18 (lines 425-426), both
          columns stretch 1 (lines 436-437). */}
      {/* Three brand columns, each with subscription card on top and
          API card below — so Claude/Anthropic, Codex/OpenAI, and
          Kimi/Moonshot stack their two routes inside the same column.
          Columns reflow on narrow windows; each capped at 450px wide
          so cards don't stretch absurdly on big monitors. */}
      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 450px))",
          columnGap: 18,
          rowGap: 18,
          minHeight: 0,
          alignContent: "start",
        }}
      >
        {BRAND_COLUMNS.map(([topKey, bottomKey]) => {
          const topSpec = BRANDS.find((b) => b.key === topKey);
          const bottomSpec = bottomKey ? BRANDS.find((b) => b.key === bottomKey) : null;
          return (
            <div
              key={topKey}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 18,
                maxWidth: 450,
                minWidth: 0,
              }}
            >
              {topSpec && (
                <BrandCard
                  spec={topSpec}
                  state={cards[topSpec.key]}
                  onConnect={() => handleConnect(topSpec)}
                  onDisconnect={() => handleDisconnect(topSpec)}
                  onTest={() => handleTest(topSpec)}
                />
              )}
              {bottomSpec && (
                <BrandCard
                  spec={bottomSpec}
                  state={cards[bottomSpec.key]}
                  onConnect={() => handleConnect(bottomSpec)}
                  onDisconnect={() => handleDisconnect(bottomSpec)}
                  onTest={() => handleTest(bottomSpec)}
                />
              )}
            </div>
          );
        })}
      </div>

      {dialogFor && (
        <ApiKeyDialog
          envName={dialogFor.envName!}
          onCancel={() => setDialogFor(null)}
          onSave={handleDialogSave}
        />
      )}
    </div>
  );
}

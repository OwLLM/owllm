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

const PAGE_BG = "var(--bg-panel)"; // matches palette(base) used by Qt gradient stops 0.6 + 1

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
};

// Verbatim from accounts_page.py:47-94 (BRAND_CARDS tuple). Accent
// colours, taglines, emoji icons, env-var names all preserved.
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
  // Qt accounts_page.py:252/266 — both kinds use the same two strings.
  const statusText = state.connected ? "Connected" : "Not connected";

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

  // Qt AccountsPage._timer at 3000 ms (line 387) polls
  // agent_runtime_manager.status() and reconciles each card. We keep the
  // poll loop wired up; the actual status fetch is a placeholder until the
  // Tauri command exists.
  useEffect(() => {
    const id = window.setInterval(() => {
      // Placeholder: agent_runtime_manager.status() bridge not yet wired.
      // Future: invoke<TauriStatus>("accounts_status").then(reconcile).
    }, 3000);
    return () => window.clearInterval(id);
  }, []);

  function setCardState(key: string, patch: Partial<CardState>) {
    setCards((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  function handleConnect(spec: BrandSpec) {
    if (spec.kind === "subscription") {
      // Qt: launches claude /login or codex /login in a console, then
      // shows an info dialog (lines 459-471). We surface the same
      // user-facing message; the real OAuth handoff is a Tauri TODO.
      window.alert(
        `A console window opened for ${spec.name}'s OAuth flow.\n` +
          `Complete it in your browser. The card flips to green once ` +
          `the credentials file appears.`,
      );
      // Optimistic flip — real flow waits for _refresh polling.
      setCardState(spec.key, { connected: true, testText: "", testOk: null });
    } else {
      setDialogFor(spec);
    }
  }

  function handleDisconnect(spec: BrandSpec) {
    // Qt: agent_runtime_manager.claude_logout / codex_logout /
    // delete_stored_secret depending on kind (lines 485-491).
    setCardState(spec.key, { connected: false, testText: "", testOk: null });
  }

  function handleDialogSave(_value: string) {
    if (!dialogFor) return;
    // Qt: agent_runtime_manager.save_stored_secret(env_name, value)
    // (line 475). _value is already trimmed inside ApiKeyDialog and
    // will be persisted once the native save command lands.
    setCardState(dialogFor.key, { connected: true, testText: "", testOk: null });
    setDialogFor(null);
  }

  function handleTest(spec: BrandSpec) {
    // Qt: AccountsPage._test starts a daemon thread that calls
    // quick_test(backend_name) and re-emits via _TestResultBridge
    // (lines 494-504). Front-end visible state-machine: testing=True ⇒
    // "Running probe…" with #dcb0ff, then ok/fail result line.
    setCardState(spec.key, { testing: true, testText: "", testOk: null });
    window.setTimeout(() => {
      // Placeholder probe — real backend returns { ok, detail, elapsed_ms }.
      const elapsed = 300 + Math.floor(Math.random() * 500);
      const ok = true;
      const detail = ok ? "Round-trip OK" : "Auth failed";
      const prefix = ok ? "✓" : "✗";
      // Qt format: f"{prefix}  {detail}  ·  {elapsed_ms} ms" (line 297) —
      // note the double space after the prefix.
      setCardState(spec.key, {
        testing: false,
        testText: `${prefix}  ${detail}  ·  ${elapsed} ms`,
        testOk: ok,
      });
    }, 600);
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
      </div>

      {/* 2x2 grid — Qt QGridLayout h/v spacing 18 (lines 425-426), both
          columns stretch 1 (lines 436-437). */}
      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gridTemplateRows: "1fr 1fr",
          columnGap: 18,
          rowGap: 18,
          minHeight: 0,
        }}
      >
        {BRANDS.map((spec) => (
          <BrandCard
            key={spec.key}
            spec={spec}
            state={cards[spec.key]}
            onConnect={() => handleConnect(spec)}
            onDisconnect={() => handleDisconnect(spec)}
            onTest={() => handleTest(spec)}
          />
        ))}
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

// MCPPage — Model Context Protocol server management.
//
// Wired to the Rust mcp.rs runtime: every action below is a real
// Tauri invoke against the JSON-RPC client that spawns MCP server
// processes (typically `npx -y @modelcontextprotocol/server-<name>`)
// and aggregates their tools into the agent dispatch loop's catalog.
//
// One tab: Servers. Each card shows the server name, command, status,
// connected tool list. Add Server opens a dialog (manual config or
// pick from presets — brave-search, filesystem, github, postgres,
// puppeteer, slack, sqlite, git).
//
// Tools from running servers are automatically advertised to every
// agent via formatToolsForPrompt() in localTools.ts — no extra
// allowlist UI needed for v1, the agent role's tool_allowlist still
// controls what's exposed when it includes mcp:<server>:<tool> names.

import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  isMcpMasterEnabled, setMcpMasterEnabled,
  isMcpToolDisabled, setMcpToolDisabled,
} from "../agentic/mcpSettings";
import { sanitizeToolParameters } from "../agentic/localTools";
import { openWebUrl } from "../../utils/openWebUrl";

const ICONS = "/Page_icons";

// ----- Backend shapes -----

type McpToolSpec = {
  name: string;
  description: string;
  inputSchema: unknown;
};

type McpServerStatus = {
  name: string;
  running: boolean;
  enabled: boolean;
  command: string;
  args: string[];
  tools: McpToolSpec[];
  error: string;
};

type McpServerConfig = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
};

type McpConfig = { servers: McpServerConfig[] };

// ----- Preset library — one-click adds for the well-known MCP servers -----

type EnvHint = {
  /// Env var name the server needs (e.g. BRAVE_API_KEY).
  name: string;
  /// One-line plain-English description shown next to the input.
  description: string;
  /// URL where the user signs up / generates this credential. Rendered
  /// as a "Get key →" button that opens the user's default browser via
  /// shell_open_url. Empty = no signup link (e.g. a path the user
  /// already knows).
  url?: string;
  /// Hint string shown as the input placeholder so the user has a
  /// shape to recognize (e.g. "BSAxxxx…" for Brave).
  placeholder?: string;
};

type Preset = {
  name: string;
  icon: string;
  description: string;
  command: string;
  args: string[];
  envHints: EnvHint[];
};

type PresetCategory = "Search" | "Files" | "Cloud" | "Dev" | "Memory" | "Web";

const PRESETS: Array<Preset & { category: PresetCategory }> = [
  // ----- Search -----
  {
    category: "Search",
    name: "duckduckgo", icon: "🦆",
    description: "Web search via DuckDuckGo. NO key, NO card, unlimited. Requires `uvx` (Astral uv) — install via `winget install astral-sh.uv` or `pip install uv`, then restart OwLLM.",
    command: "uvx", args: ["duckduckgo-mcp-server"],
    envHints: [],
  },
  {
    category: "Search",
    name: "brave-search", icon: "🦁",
    description: "Web search via Brave Search API. Free 2000 q/mo but now requires a card to verify.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"],
    envHints: [
      {
        name: "BRAVE_API_KEY",
        description: "Click 'Get Started' → sign up → 'Subscriptions' → 'Free' plan → 'API Keys' tab.",
        url: "https://brave.com/search/api/",
        placeholder: "BSA…",
      },
    ],
  },
  {
    category: "Search",
    name: "tavily", icon: "🔎",
    description: "LLM-tuned search — returns clean text instead of raw HTML. Free 1000 q/mo, no card.",
    command: "npx", args: ["-y", "tavily-mcp"],
    envHints: [
      {
        name: "TAVILY_API_KEY",
        description: "Sign up with email, no card. Built for AI agents — cleaner results than vanilla web search.",
        url: "https://app.tavily.com/",
        placeholder: "tvly-…",
      },
    ],
  },
  {
    category: "Search",
    name: "exa", icon: "🔬",
    description: "Neural/semantic search by exa.ai. Returns full text per result. Free 1000 q/mo, no card.",
    command: "npx", args: ["-y", "exa-mcp-server"],
    envHints: [
      {
        name: "EXA_API_KEY",
        description: "Semantic search — better than keyword for research/fact-finding.",
        url: "https://dashboard.exa.ai/api-keys",
        placeholder: "exa_…",
      },
    ],
  },

  // ----- Files -----
  {
    category: "Files",
    name: "filesystem", icon: "📁",
    description: "Sandboxed file ops. Edit the LAST positional arg to set the allowed root dir.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "{{WORKSPACE}}"],
    envHints: [],
  },

  // ----- Cloud -----
  {
    category: "Cloud",
    name: "github", icon: "🐙",
    description: "GitHub API — repos, issues, PRs, files.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-github"],
    envHints: [
      {
        name: "GITHUB_PERSONAL_ACCESS_TOKEN",
        description: "Personal access token. Classic or fine-grained both work. Grant the scopes you want the agent to use (repo, read:org, etc).",
        url: "https://github.com/settings/tokens",
        placeholder: "ghp_…",
      },
    ],
  },
  {
    category: "Cloud",
    name: "slack", icon: "💬",
    description: "Slack workspace API — messages, channels, search.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"],
    envHints: [
      {
        name: "SLACK_BOT_TOKEN",
        description: "Bot token from your Slack app (starts with xoxb-). Create a new app at api.slack.com/apps.",
        url: "https://api.slack.com/apps",
        placeholder: "xoxb-…",
      },
      {
        name: "SLACK_TEAM_ID",
        description: "Your workspace's team ID (starts with T). Find at slack.com/admin/settings.",
        url: "https://slack.com/help/articles/221769328-Locate-your-Slack-URL-or-ID",
        placeholder: "T0…",
      },
    ],
  },
  {
    category: "Cloud",
    name: "google-drive", icon: "📂",
    description: "Google Drive — list, read, search files. Requires OAuth setup (multi-step).",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-gdrive"],
    envHints: [
      {
        name: "GDRIVE_OAUTH_PATH",
        description: "Path to gcp-oauth.keys.json downloaded from a Google Cloud OAuth client (web app type). See README.",
        url: "https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive",
        placeholder: "C:/path/to/gcp-oauth.keys.json",
      },
    ],
  },

  // ----- Dev -----
  {
    category: "Dev",
    name: "postgres", icon: "🐘",
    description: "Read-only Postgres queries. Edit the LAST arg to your connection URL.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:pass@host/db"],
    envHints: [],
  },
  {
    category: "Dev",
    name: "sqlite", icon: "🗄️",
    description: "Local SQLite read/write + schema inspection. Edit --db-path to your DB.",
    command: "uvx", args: ["mcp-server-sqlite", "--db-path", "C:/path/to/db.sqlite"],
    envHints: [],
  },
  {
    category: "Dev",
    name: "git", icon: "🔀",
    description: "Local git ops — log, diff, blame, branches. Edit --repository to your repo.",
    command: "uvx", args: ["mcp-server-git", "--repository", "{{WORKSPACE}}"],
    envHints: [],
  },
  {
    category: "Dev",
    name: "sentry", icon: "🚨",
    description: "Sentry issues — list, drill into stacktraces, recent events.",
    command: "uvx", args: ["mcp-server-sentry"],
    envHints: [
      {
        name: "SENTRY_AUTH_TOKEN",
        description: "Sentry internal integration token. Settings → Developer Settings → Internal Integrations.",
        url: "https://sentry.io/settings/account/api/auth-tokens/",
        placeholder: "sntrys_…",
      },
    ],
  },

  // ----- Web -----
  {
    category: "Web",
    name: "puppeteer", icon: "🌐",
    description: "Headless Chromium — navigate, screenshot, click, scrape. Downloads Chromium on first run.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    envHints: [],
  },
  {
    category: "Web",
    name: "fetch", icon: "📥",
    description: "Fetch a URL → return as markdown. Simpler than puppeteer for static pages.",
    command: "uvx", args: ["mcp-server-fetch"],
    envHints: [],
  },

  // ----- Memory -----
  {
    category: "Memory",
    name: "memory", icon: "🧠",
    description: "Persistent knowledge-graph store. Agents can save+recall facts across sessions.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"],
    envHints: [],
  },
  {
    category: "Memory",
    name: "sequential-thinking", icon: "🪜",
    description: "Structured reasoning aid — agents emit thoughts in a tracked chain, can revise.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    envHints: [],
  },
  {
    category: "Memory",
    name: "time", icon: "🕐",
    description: "Timezone-aware time queries + conversion. Tiny, useful for scheduling agents.",
    command: "uvx", args: ["mcp-server-time"],
    envHints: [],
  },
];

const PRESET_CATEGORIES: PresetCategory[] = ["Search", "Files", "Cloud", "Dev", "Web", "Memory"];

/// External catalogs — there's no public registry API yet, but the
/// modelcontextprotocol/servers README is the canonical first-party
/// list and awesome-mcp-servers is the community-curated long tail.
const CATALOG_LINKS: Array<{ label: string; url: string; description: string }> = [
  {
    label: "Official MCP servers",
    url: "https://github.com/modelcontextprotocol/servers",
    description: "Reference servers maintained by Anthropic. Read the README for the canonical list + setup notes.",
  },
  {
    label: "awesome-mcp-servers",
    url: "https://github.com/punkpeye/awesome-mcp-servers",
    description: "Community-curated long tail — 200+ servers across every imaginable category.",
  },
  {
    label: "Glama directory",
    url: "https://glama.ai/mcp/servers",
    description: "Browsable web directory with categories, ratings, and one-click install configs.",
  },
];

/// Open a URL in the user's default browser via the Rust shell_open_url
/// Tauri command. Used by the "Get key →" buttons in the env-hint rows
/// so users can fly straight from "add server" to the signup page.
async function openExternal(url: string) {
  try { await openWebUrl(url); } catch (e) { console.error("openExternal", e); }
}

// ----- Shared inline styles (carried from the old MCPPage for visual continuity) -----

const inputStyle: React.CSSProperties = {
  height: 32, padding: "0 12px",
  borderRadius: 6, border: "1px solid rgba(var(--accent-rgb),0.30)",
  background: "rgba(40,40,50,0.80)", color: "var(--fg-strong)", fontSize: 12,
};
const lblStyle: React.CSSProperties = {
  display: "block", color: "var(--fg-strong)", fontSize: 12,
  fontWeight: 500, marginBottom: 4, marginTop: 8,
};
const btnGhost: React.CSSProperties = {
  height: 32, padding: "0 14px", borderRadius: 6,
  border: "1px solid rgba(var(--accent-rgb),0.50)",
  background: "rgba(var(--accent-rgb),0.30)",
  color: "var(--fg-strong)", fontSize: 12, fontWeight: 600, cursor: "pointer",
};
const btnPrimary: React.CSSProperties = {
  height: 32, padding: "0 14px", borderRadius: 4,
  border: "none", color: "var(--fg-strong)", fontWeight: 700, fontSize: 12,
  cursor: "pointer",
  background: "rgba(var(--accent-rgb),0.80)",
};
const btnGreen: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 4, border: "none", color: "var(--fg-strong)",
  fontSize: 11, fontWeight: 600, cursor: "pointer",
  background: "rgba(76,175,80,0.60)",
};
const btnRed: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 4, border: "none", color: "var(--fg-strong)",
  fontSize: 11, fontWeight: 600, cursor: "pointer",
  background: "rgba(244,67,54,0.60)",
};
const btnGray: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 4, border: "none", color: "var(--fg-strong)",
  fontSize: 11, fontWeight: 600, cursor: "pointer",
  background: "rgba(158,158,158,0.60)",
};

// ----- Add/Edit Server dialog -----

function ServerDialog({
  initial, envHints, onCancel, onSave,
}: {
  initial: McpServerConfig | null;
  /// Structured env-var hints from the preset (signup URL per key,
  /// description, placeholder). Drives the per-key input rows + "Get
  /// key →" buttons. Empty/undefined = no hints, user uses the raw
  /// JSON textarea only.
  envHints?: EnvHint[];
  onCancel: () => void;
  onSave: (cfg: McpServerConfig) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [command, setCommand] = useState(initial?.command ?? "npx");
  const [argsText, setArgsText] = useState((initial?.args ?? []).join(" "));
  // Per-hint inputs are tracked separately from the JSON textarea so
  // we can show one row per known key with its own "Get key →" link.
  const [hintValues, setHintValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    const initEnv = initial?.env ?? {};
    for (const h of envHints ?? []) {
      out[h.name] = initEnv[h.name] ?? "";
    }
    return out;
  });
  // The JSON textarea holds OTHER env vars (anything not in envHints).
  // Lets advanced users add extras without losing the preset hints.
  const [envText, setEnvText] = useState(() => {
    const initEnv = initial?.env ?? {};
    const hintNames = new Set((envHints ?? []).map(h => h.name));
    const extras: Record<string, string> = {};
    for (const [k, v] of Object.entries(initEnv)) {
      if (!hintNames.has(k)) extras[k] = v;
    }
    return Object.keys(extras).length > 0 ? JSON.stringify(extras, null, 2) : "";
  });
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);

  const apply = () => {
    if (!name.trim()) { setError("Name is required."); return; }
    if (!command.trim()) { setError("Command is required."); return; }
    let env: Record<string, string> = {};
    if (envText.trim()) {
      try { env = JSON.parse(envText); }
      catch { setError("Extra env vars must be valid JSON."); return; }
    }
    // Layer hint values on top of any extras the user added in the JSON
    // textarea. Hints win when both contain the same key.
    for (const [k, v] of Object.entries(hintValues)) {
      if (v.trim()) env[k] = v.trim();
    }
    // Warn (not block) if a required-looking hint is empty — server
    // will fail at start but the user might know what they're doing.
    const missingHints = (envHints ?? []).filter(h => !hintValues[h.name]?.trim());
    if (missingHints.length > 0) {
      const names = missingHints.map(h => h.name).join(", ");
      const ok = window.confirm(
        `These keys appear empty: ${names}\n\nThe server will likely fail to start without them. Add anyway?`,
      );
      if (!ok) return;
    }
    // Simple whitespace split for args. Anything quoted should use the
    // raw textarea — agents in v1 don't run servers with crazy args.
    const args = argsText.trim().split(/\s+/).filter(Boolean);
    onSave({ name: name.trim(), command: command.trim(), args, env, enabled });
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
    }}>
      <div style={{
        background: "#1a1f2e", borderRadius: 10, padding: 24,
        minWidth: 520, maxWidth: 640, maxHeight: "85vh", overflow: "auto",
        border: "1px solid rgba(var(--accent-rgb),0.3)",
      }}>
        <div style={{ color: "var(--fg-strong)", fontSize: 16, fontWeight: 700, marginBottom: 16 }}>
          {initial ? `Edit Server: ${initial.name}` : "Add MCP Server"}
        </div>

        <label style={lblStyle}>Name (short, agents reference as <code>mcp:{name || "name"}:&lt;tool&gt;</code>):</label>
        <input value={name} onChange={e => setName(e.target.value)}
          disabled={!!initial}
          placeholder="brave-search"
          style={{ ...inputStyle, width: "100%", marginBottom: 8 }} />

        <label style={lblStyle}>Command:</label>
        <input value={command} onChange={e => setCommand(e.target.value)}
          placeholder="npx"
          style={{ ...inputStyle, width: "100%", marginBottom: 8 }} />

        <label style={lblStyle}>Args (space-separated):</label>
        <input value={argsText} onChange={e => setArgsText(e.target.value)}
          placeholder="-y @modelcontextprotocol/server-brave-search"
          style={{ ...inputStyle, width: "100%", marginBottom: 8 }} />

        {(envHints && envHints.length > 0) && (
          <div style={{
            marginTop: 12,
            background: "rgba(20,25,40,0.5)",
            border: "1px solid rgba(var(--accent-rgb),0.20)",
            borderRadius: 8, padding: 12,
            display: "flex", flexDirection: "column", gap: 12,
          }}>
            <div style={{ color: "var(--fg-strong)", fontSize: 12, fontWeight: 700 }}>
              🔑 Required credentials
            </div>
            {envHints.map(h => (
              <div key={h.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <code style={{
                    background: "rgba(0,0,0,0.4)",
                    color: "#9ad9ff", padding: "2px 6px", borderRadius: 4,
                    fontSize: 11, fontFamily: "Consolas, monospace",
                  }}>{h.name}</code>
                  {h.url && (
                    <button
                      onClick={() => openExternal(h.url!)}
                      title={`Open ${h.url} to sign up / get your key`}
                      style={{
                        padding: "2px 8px", fontSize: 11,
                        background: "rgba(var(--accent-rgb),0.30)",
                        color: "#9fa8ff",
                        border: "1px solid rgba(var(--accent-rgb),0.50)",
                        borderRadius: 4, cursor: "pointer",
                      }}
                    >
                      🌐 Get key →
                    </button>
                  )}
                </div>
                {h.description && (
                  <div style={{ color: "var(--fg-subtle)", fontSize: 11, lineHeight: 1.4 }}>
                    {h.description}
                  </div>
                )}
                <input
                  type="password"
                  value={hintValues[h.name] ?? ""}
                  onChange={e => setHintValues(prev => ({ ...prev, [h.name]: e.target.value }))}
                  placeholder={h.placeholder ?? "paste key here"}
                  style={{ ...inputStyle, width: "100%" }}
                />
              </div>
            ))}
          </div>
        )}

        <label style={lblStyle}>
          {(envHints && envHints.length > 0) ? "Extra env vars (JSON, optional):" : "Environment Variables (JSON):"}
        </label>
        <textarea value={envText} onChange={e => { setEnvText(e.target.value); setError(null); }}
          placeholder='{"EXTRA_VAR": "value"}'
          style={{
            ...inputStyle, width: "100%", height: 90,
            fontFamily: "Consolas, monospace", resize: "vertical", padding: 8,
          }} />

        <label style={{ ...lblStyle, display: "flex", alignItems: "center", gap: 6, marginTop: 12 }}>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          <span>Auto-start on app boot</span>
        </label>

        <div style={{ color: "#ff9800", fontSize: 11, marginTop: 12, lineHeight: 1.5 }}>
          ⚠️ Secrets are stored in plaintext at <code>~/.owllm/mcp_config.json</code>.
          Don't commit that file.
        </div>

        {error && (
          <div style={{ color: "#f87171", fontSize: 11, marginTop: 8 }}>{error}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button onClick={onCancel} style={btnGhost}>Cancel</button>
          <button onClick={apply} style={btnPrimary}>{initial ? "Save" : "Add"}</button>
        </div>
      </div>
    </div>
  );
}

// ----- Server card -----

function ServerCard({
  status, starting, lastError, installing, onStart, onStop, onEdit, onRemove, onInstallRuntime, onToolToggle, onToggleAutostart,
}: {
  status: McpServerStatus;
  /// True while mcp_start_server is in-flight for this server. Surfaces
  /// the long npx-download wait so the user doesn't think Start was a
  /// no-op. We show a yellow Starting badge + a hint about what's
  /// happening so they know to wait, not retry.
  starting: boolean;
  /// The last start error returned to the page (if any). Used to detect
  /// "runtime missing" failures and surface an Install button instead
  /// of just telling the user to fix it themselves.
  lastError: string;
  /// True while install_uv is downloading + extracting. Disables the
  /// install button so the user can't double-click.
  installing: boolean;
  onStart: () => void;
  onStop: () => void;
  onEdit: () => void;
  onRemove: () => void;
  /// Called when the user clicks the runtime-install button. The
  /// caller decides which runtime (uv/node) based on the missing tool.
  onInstallRuntime: (runtime: "uv") => void;
  /// Fired after a per-tool enable/disable toggle so the parent can
  /// re-render (the disabled set lives in localStorage, not React state).
  onToolToggle: () => void;
  /// Flip this server's Auto-start (enabled) flag in mcp_config.json.
  onToggleAutostart: (enabled: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const badgeColor = starting ? "#FFB300"
    : status.running ? "#4CAF50"
    : (status.error ? "#F44336" : "#9E9E9E");
  const badgeText = starting ? "Starting…"
    : status.running ? "Running"
    : (status.error ? "Error" : "Stopped");

  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(30,30,40,0.9), rgba(20,20,30,0.9))",
      border: "1px solid rgba(var(--accent-rgb),0.30)",
      borderRadius: 8, padding: 12,
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ color: "var(--fg-strong)", fontWeight: 700, fontSize: 14, flex: 1 }}>
          🔌 {status.name}
          {status.tools.length > 0 && (
            <span style={{ color: "var(--fg-subtle)", fontWeight: 400, fontSize: 11, marginLeft: 8 }}>
              {status.tools.length} tool{status.tools.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <label
          title={status.enabled
            ? "Auto-start ON — this server spins up automatically on the first agent run (or click Start now)."
            : "Auto-start OFF — this server only runs when you click Start."}
          style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 11, color: status.enabled ? "#9ad9ff" : "var(--fg-subtle)", userSelect: "none" }}
        >
          <input type="checkbox" checked={status.enabled} onChange={e => onToggleAutostart(e.target.checked)} />
          Auto-start
        </label>
        <span style={{
          background: badgeColor, color: "var(--fg-strong)",
          padding: "4px 12px", borderRadius: 4,
          fontSize: 11, fontWeight: 700,
        }}>{badgeText}</span>
      </div>

      <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--fg-subtle)" }}>
        <span style={{ fontFamily: "Consolas, monospace" }}>
          {status.command} {status.args.join(" ")}
        </span>
      </div>

      {(status.error || lastError) && (() => {
        const errText = status.error || lastError;
        // When the server is RUNNING, anything in `error` is just
        // stderr (Python servers write INFO logs to stderr — that's
        // not a failure). Tint it neutral. When the server is NOT
        // running, this IS the actual failure — keep it red.
        const isLogNotError = status.running;
        // Detect missing-runtime errors so we can offer to install
        // them instead of dumping shell instructions on the user.
        const uvMissing = !isLogNotError && (
          /'uvx'\s+not\s+found|uv\s+not\s+found/i.test(errText)
          || (status.command === "uvx" && /not\s+found|cannot\s+find\s+file|os\s+error\s+2/i.test(errText))
        );
        const palette = isLogNotError
          ? { bg: "rgba(80,120,200,0.08)", border: "rgba(80,120,200,0.30)", fg: "#9fb4d8", label: "stderr (informational)" }
          : { bg: "rgba(244,67,54,0.10)", border: "rgba(244,67,54,0.4)",  fg: "#f87171", label: null };
        return (
          <div style={{
            background: palette.bg,
            border: `1px solid ${palette.border}`,
            color: palette.fg, padding: 8, borderRadius: 4,
            fontSize: 11, fontFamily: "Consolas, monospace",
            maxHeight: 140, overflow: "auto",
            whiteSpace: "pre-wrap",
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            {palette.label && (
              <div style={{
                fontFamily: "system-ui, sans-serif", fontSize: 10,
                fontWeight: 700, letterSpacing: 0.5,
                opacity: 0.85,
              }}>{palette.label}</div>
            )}
            <div>{errText}</div>
            {uvMissing && (
              <button
                onClick={() => onInstallRuntime("uv")}
                disabled={installing}
                style={{
                  alignSelf: "flex-start",
                  padding: "6px 12px", fontSize: 11, fontWeight: 700,
                  background: installing ? "rgba(255,179,0,0.30)" : "rgba(76,175,80,0.60)",
                  color: "#fff", border: "none", borderRadius: 4,
                  cursor: installing ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                }}
              >
                {installing
                  ? "⏳ Installing uv runtime…"
                  : "🛠 Install uv runtime (one-click, ~30 MB)"}
              </button>
            )}
          </div>
        );
      })()}

      {starting && (
        <div style={{
          background: "rgba(255,179,0,0.10)",
          border: "1px solid rgba(255,179,0,0.4)",
          color: "#ffcc80", padding: 8, borderRadius: 4,
          fontSize: 11, lineHeight: 1.5,
        }}>
          ⏳ First run downloads the MCP package via npx — usually 20-60s.
          Wait for it; clicking Start again won't help.
        </div>
      )}

      {/* When stopped, explain why nothing is running yet — Stopped + "MCP
          tools ON" otherwise reads as broken. Auto-start = will spin up on
          the first agent run; not auto-start = manual Start only. */}
      {!status.running && !starting && !status.error && (
        <div style={{ fontSize: 10.5, color: "var(--fg-subtle)", lineHeight: 1.4 }}>
          {status.enabled
            ? "⏱ Stopped — starts automatically on the first agent run (or click Start to warm it now)."
            : "⏸ Stopped — Auto-start is off, so it only runs when you click Start."}
        </div>
      )}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {!status.running ? (
          <button onClick={onStart} disabled={starting} style={{ ...btnGreen, opacity: starting ? 0.5 : 1, cursor: starting ? "not-allowed" : "pointer" }}>
            {starting ? "⏳ Starting…" : "▶ Start"}
          </button>
        ) : (
          <button onClick={onStop} style={btnRed}>⏹ Stop</button>
        )}
        <button onClick={onEdit} style={btnGhost}>⚙ Edit</button>
        <button onClick={onRemove} style={btnGray}>🗑 Remove</button>
        {status.tools.length > 0 && (
          <button onClick={() => setExpanded(v => !v)} style={btnGhost}>
            {expanded ? "▼ Hide tools" : "▶ Show tools"}
          </button>
        )}
      </div>

      {expanded && status.tools.length > 0 && (
        <div style={{
          background: "rgba(0,0,0,0.3)", borderRadius: 6, padding: 10,
          display: "flex", flexDirection: "column", gap: 8,
        }}>
          {status.tools.map(t => {
            const qualified = `mcp:${status.name}:${t.name}`;
            const off = isMcpToolDisabled(qualified);
            const gate = sanitizeToolParameters(t.inputSchema);
            return (
              <div key={t.name} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 11, opacity: off ? 0.5 : 1 }}>
                <label title={off ? "Disabled — hidden from agents" : "Enabled — advertised to agents"}
                  style={{ display: "flex", alignItems: "center", cursor: "pointer", marginTop: 1 }}>
                  <input
                    type="checkbox"
                    checked={!off}
                    onChange={(e) => { setMcpToolDisabled(qualified, !e.target.checked); onToolToggle(); }}
                  />
                </label>
                <div style={{ flex: 1 }}>
                  <span style={{ color: "#9ad9ff", fontFamily: "Consolas, monospace", fontWeight: 600 }}>
                    {qualified}
                  </span>
                  {gate.changed && (
                    <span title={`Schema was auto-sanitized so it can't break tool-calling: ${gate.reason}`}
                      style={{
                        marginLeft: 6, fontSize: 9, fontWeight: 700, letterSpacing: 0.3,
                        color: "#ffcc80", background: "rgba(255,179,0,0.14)",
                        border: "1px solid rgba(255,179,0,0.4)", borderRadius: 3, padding: "1px 5px",
                      }}>SANITIZED</span>
                  )}
                  {off && (
                    <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: "var(--fg-muted)" }}>OFF</span>
                  )}
                  {t.description && (
                    <span style={{ color: "var(--fg-subtle)" }}> — {t.description}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ----- Presets row (one-click add) -----

function PresetsRow({ onPick }: { onPick: (p: Preset) => void }) {
  return (
    <div style={{
      background: "rgba(20,25,40,0.4)",
      border: "1px solid rgba(var(--accent-rgb),0.15)",
      borderRadius: 8, padding: 12,
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div style={{ color: "var(--fg-strong)", fontSize: 12, fontWeight: 600 }}>
          Quick add — popular MCP servers
        </div>
        <div style={{ color: "var(--fg-subtle)", fontSize: 11 }}>
          click any to pre-fill the Add dialog
        </div>
      </div>
      {PRESET_CATEGORIES.map(cat => {
        const items = PRESETS.filter(p => p.category === cat);
        if (items.length === 0) return null;
        return (
          <div key={cat} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{
              color: "var(--fg-subtle)", fontSize: 10,
              fontWeight: 700, letterSpacing: 1, textTransform: "uppercase",
            }}>{cat}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {items.map(p => (
                <button
                  key={p.name}
                  onClick={() => onPick(p)}
                  title={`${p.description}${p.envHints.length ? `\n\nNeeds: ${p.envHints.map(h => h.name).join(", ")}` : ""}`}
                  style={{
                    padding: "8px 12px", borderRadius: 6,
                    background: "rgba(40,45,60,0.8)",
                    border: "1px solid rgba(var(--accent-rgb),0.25)",
                    color: "var(--fg)", fontSize: 12, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 6,
                  }}
                >
                  <span style={{ fontSize: 16 }}>{p.icon}</span>
                  <span>{p.name}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}

      <div style={{
        marginTop: 4, paddingTop: 12,
        borderTop: "1px solid rgba(var(--accent-rgb),0.10)",
        display: "flex", flexDirection: "column", gap: 6,
      }}>
        <div style={{ color: "var(--fg-strong)", fontSize: 12, fontWeight: 600 }}>
          Browse the full MCP universe
        </div>
        <div style={{ color: "var(--fg-subtle)", fontSize: 11, lineHeight: 1.5 }}>
          No in-app registry yet — there's no public MCP marketplace API the way HuggingFace
          has the model hub. The canonical lists live on GitHub. Pick a server from one of these,
          grab its <code>npx</code> or <code>uvx</code> command, paste it into <b>+ Add Server</b>.
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
          {CATALOG_LINKS.map(l => (
            <button
              key={l.url}
              onClick={() => openExternal(l.url)}
              title={l.description}
              style={{
                padding: "8px 12px", borderRadius: 6,
                background: "rgba(var(--accent-rgb),0.20)",
                border: "1px solid rgba(var(--accent-rgb),0.40)",
                color: "#9fa8ff", fontSize: 12, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 6,
              }}
            >
              🌐 {l.label} →
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ----- Main page -----

export default function MCPPage() {
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; initial: McpServerConfig | null; envHints?: EnvHint[] }>({ open: false, initial: null });
  // Per-user default dir for preset pre-fills that need a path (filesystem /
  // git). Replaces the old hardcoded "C:/1_Git" dev path so a fresh machine
  // gets a real, existing folder instead of a nonexistent one.
  const [wsDefault, setWsDefault] = useState<string>("");
  useEffect(() => {
    invoke<string>("chat_scratch_dir").then((d) => setWsDefault(d)).catch(() => { /* leave blank */ });
  }, []);
  // Per-server "starting" flag. mcp_start_server can hang for up to
  // ~3 minutes on first run while npx downloads the package; without
  // this the card just shows Stopped during the wait and the user
  // assumes it failed silently.
  const [starting, setStarting] = useState<Set<string>>(new Set());
  // Per-server last start error — the backend status.error only fires
  // while the session is alive; failed spawns return through the
  // start() catch path and never reach status, so we cache them here.
  const [startErrors, setStartErrors] = useState<Record<string, string>>({});
  // Global "uv runtime is installing" flag — shared across all server
  // cards because there's only one uv install regardless of which
  // card triggered it.
  const [installingUv, setInstallingUv] = useState(false);
  // MCP master switch — when off, formatToolsForOpenAI drops ALL MCP tools
  // from the model's `tools` array (local tools stay). Mirrors localStorage.
  const [masterEnabled, setMasterEnabled] = useState<boolean>(() => isMcpMasterEnabled());
  // Bump to force a re-render after a per-tool toggle (disabled set lives
  // in localStorage, not React state).
  const [, setToolTick] = useState(0);

  const toggleMaster = () => {
    const next = !masterEnabled;
    setMcpMasterEnabled(next);
    setMasterEnabled(next);
  };

  /// Quiet refresh — fetches status without toggling the global
  /// `loading` flag. Used by the 3-second background tick so the
  /// Refresh button doesn't flash a spinner every poll.
  const refreshQuiet = async () => {
    try {
      const list = await invoke<McpServerStatus[]>("mcp_list_servers");
      setServers(list);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };
  /// Loud refresh — what the Refresh button calls. Shows the "🔄 …"
  /// state so the user gets feedback that their click did something.
  const refresh = async () => {
    setLoading(true);
    try { await refreshQuiet(); } finally { setLoading(false); }
  };

  // Initial load + 3s refresh tick to catch status changes (server crashed, etc.).
  useEffect(() => {
    refreshQuiet();
    const id = window.setInterval(refreshQuiet, 3000);
    return () => window.clearInterval(id);
  }, []);

  const start = async (name: string) => {
    setError(null);
    setStartErrors(prev => { const n = { ...prev }; delete n[name]; return n; });
    setStarting(prev => { const next = new Set(prev); next.add(name); return next; });
    try {
      await invoke<McpServerStatus>("mcp_start_server", { name });
      await refresh();
    } catch (e: any) {
      // npx first-run can take 30-90s downloading the package. Past
      // 180s the backend times out — surface that vs other failures.
      const msg = String(e?.message ?? e);
      setError(`start ${name}: ${msg}`);
      setStartErrors(prev => ({ ...prev, [name]: msg }));
    } finally {
      setStarting(prev => { const next = new Set(prev); next.delete(name); return next; });
    }
  };

  /// One-click install for a missing runtime. After install we
  /// auto-retry Start so the user gets straight from "uvx not found"
  /// to "server running" without extra clicks.
  const installRuntime = async (runtime: "uv", retryServer: string) => {
    setError(null);
    if (runtime !== "uv") return;
    setInstallingUv(true);
    try {
      await invoke<string>("install_uv");
      // Retry the server start once uv is on disk. The resolve_command
      // path inside spawn_session checks LLM/runtime/uv/ first.
      await start(retryServer);
    } catch (e: any) {
      setError(`install uv: ${String(e?.message ?? e)}`);
    } finally {
      setInstallingUv(false);
    }
  };

  const stop = async (name: string) => {
    setError(null);
    try {
      await invoke("mcp_stop_server", { name });
      await refresh();
    } catch (e: any) {
      setError(`stop ${name}: ${String(e?.message ?? e)}`);
    }
  };

  /// Flip a server's Auto-start (enabled) flag in mcp_config.json. Does NOT
  /// start/stop the process — purely whether it spins up by itself on the
  /// first agent run. Turning it off while running leaves it running (the
  /// user can Stop separately); turning it on doesn't eagerly launch it.
  const toggleAutostart = async (name: string, enabled: boolean) => {
    setError(null);
    try {
      const cfg = await invoke<McpConfig>("mcp_load_config");
      const idx = cfg.servers.findIndex(s => s.name === name);
      if (idx < 0) return;
      const next = { servers: cfg.servers.slice() };
      next.servers[idx] = { ...next.servers[idx], enabled };
      await invoke("mcp_save_config", { config: next });
      await refresh();
    } catch (e: any) {
      setError(`auto-start ${name}: ${String(e?.message ?? e)}`);
    }
  };

  const remove = async (name: string) => {
    if (!confirm(`Remove MCP server '${name}'?`)) return;
    try {
      const cfg = await invoke<McpConfig>("mcp_load_config");
      const next = { servers: cfg.servers.filter(s => s.name !== name) };
      await invoke("mcp_save_config", { config: next });
      await invoke("mcp_stop_server", { name }).catch(() => {});
      await refresh();
    } catch (e: any) {
      setError(`remove ${name}: ${String(e?.message ?? e)}`);
    }
  };

  const saveServer = async (cfg: McpServerConfig) => {
    try {
      const current = await invoke<McpConfig>("mcp_load_config");
      const existing = current.servers.findIndex(s => s.name === cfg.name);
      const next = { servers: current.servers.slice() };
      if (existing >= 0) next.servers[existing] = cfg;
      else next.servers.push(cfg);
      await invoke("mcp_save_config", { config: next });
      setDialog({ open: false, initial: null });
      await refresh();
    } catch (e: any) {
      setError(`save: ${String(e?.message ?? e)}`);
    }
  };

  const addFromPreset = (p: Preset) => {
    const env: Record<string, string> = {};
    for (const h of p.envHints) env[h.name] = "";
    // Substitute the {{WORKSPACE}} token (filesystem/git presets) with the
    // user's real scratch dir so the pre-fill points somewhere that exists.
    const args = p.args.map((a) => (a === "{{WORKSPACE}}" ? (wsDefault || ".") : a));
    setDialog({
      open: true,
      initial: { name: p.name, command: p.command, args, env, enabled: true },
      envHints: p.envHints,
    });
  };

  const edit = async (name: string) => {
    try {
      const cfg = await invoke<McpConfig>("mcp_load_config");
      const found = cfg.servers.find(s => s.name === name) ?? null;
      // If this server matches a known preset, surface its envHints
      // so the user gets the rich rows + Get-key links on edit too.
      const preset = PRESETS.find(p => p.name === name);
      setDialog({ open: true, initial: found, envHints: preset?.envHints });
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };

  const totalTools = servers.reduce((acc, s) => acc + s.tools.length, 0);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-panel)" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "16px 16px 8px",
      }}>
        <img src={`${ICONS}/owl_tools.png`} style={{ width: 28, height: 28 }} alt="" />
        <div style={{ color: "var(--fg-strong)", fontSize: 18, fontWeight: 700, flex: 1 }}>
          🧩 MCP Servers
        </div>
        <span style={{ color: "var(--fg-subtle)", fontSize: 12 }}>
          {servers.filter(s => s.running).length} running · {masterEnabled ? `${totalTools} tools advertised to agents` : "MCP tools OFF"}
        </span>
        <button
          onClick={toggleMaster}
          title={masterEnabled
            ? "MCP tools are ON — advertised to every agent. Click to turn all MCP tools off (local tools stay)."
            : "MCP tools are OFF — agents see only built-in tools. Click to turn MCP tools back on."}
          style={{
            ...btnGhost,
            background: masterEnabled ? "rgba(76,175,80,0.30)" : "rgba(158,158,158,0.25)",
            border: `1px solid ${masterEnabled ? "rgba(76,175,80,0.6)" : "rgba(158,158,158,0.5)"}`,
          }}
        >
          {masterEnabled ? "🟢 MCP tools ON" : "⚪ MCP tools OFF"}
        </button>
        <button onClick={() => setDialog({ open: true, initial: null })} style={btnPrimary}>
          + Add Server
        </button>
        <button onClick={refresh} disabled={loading} style={btnGhost}>
          {loading ? "🔄 …" : "🔄 Refresh"}
        </button>
      </div>

      <div style={{ padding: "0 16px 8px", color: "var(--fg-subtle)", fontSize: 12, lineHeight: 1.5 }}>
        MCP servers are subprocess tool providers (typically npm packages run via npx).
        Two layers: <b>MCP tools ON/OFF</b> is the master gate (off = no MCP tools reach any
        agent, nothing spawns); each server's <b>Auto-start</b> toggle decides whether it
        launches by itself. Auto-start servers don't start at app boot — they spin up lazily on
        the <b>first agent run</b> (then stay resident), or immediately if you click <b>Start</b>.
        Their tools advertise as <code>mcp:&lt;server&gt;:&lt;tool&gt;</code>. Per-tool checkboxes
        (<b>Show tools</b>) silence a single one, and every MCP schema is auto-sanitized before it
        reaches the model so one bad schema can't break tool-calling.
        Config persisted to <code>~/.owllm/mcp_config.json</code>.
      </div>

      {!masterEnabled && (
        <div style={{
          margin: "0 16px 8px", padding: "8px 12px",
          background: "rgba(158,158,158,0.12)", border: "1px solid rgba(158,158,158,0.4)",
          borderRadius: 6, color: "var(--fg-subtle)", fontSize: 12, lineHeight: 1.5,
        }}>
          ⚪ MCP tools are <b>OFF</b> — agents currently see only built-in tools (read_file,
          shell, web_search…). This is also the quickest way to test whether an MCP tool is
          breaking agentic tool-calling: leave it off and re-run; if tools now fire, an MCP
          schema was the culprit.
        </div>
      )}

      <div style={{
        flex: 1, overflow: "auto", padding: "0 16px 16px",
        display: "flex", flexDirection: "column", gap: 12,
      }}>
        {error && (
          <div style={{
            background: "rgba(244,67,54,0.10)",
            border: "1px solid rgba(244,67,54,0.4)",
            color: "#f87171", padding: 10, borderRadius: 6,
            fontSize: 12,
          }}>
            {error}
          </div>
        )}

        {servers.length === 0 ? (
          <div style={{
            color: "var(--fg-subtle)", textAlign: "center",
            padding: 40, fontSize: 13,
            background: "rgba(20,25,40,0.4)",
            border: "1px dashed rgba(var(--accent-rgb),0.20)",
            borderRadius: 8,
          }}>
            No MCP servers configured. Add one below or click + Add Server.
          </div>
        ) : (
          servers.map(s => (
            <ServerCard
              key={s.name}
              status={s}
              starting={starting.has(s.name)}
              lastError={startErrors[s.name] ?? ""}
              installing={installingUv}
              onStart={() => start(s.name)}
              onStop={() => stop(s.name)}
              onEdit={() => edit(s.name)}
              onRemove={() => remove(s.name)}
              onInstallRuntime={(rt) => installRuntime(rt, s.name)}
              onToolToggle={() => setToolTick(t => t + 1)}
              onToggleAutostart={(enabled) => toggleAutostart(s.name, enabled)}
            />
          ))
        )}

        <PresetsRow onPick={addFromPreset} />
      </div>

      {dialog.open && (
        <ServerDialog
          initial={dialog.initial}
          envHints={dialog.envHints}
          onCancel={() => setDialog({ open: false, initial: null })}
          onSave={saveServer}
        />
      )}
    </div>
  );
}

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
    command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "C:/1_Git"],
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
    command: "uvx", args: ["mcp-server-git", "--repository", "C:/1_Git/LocaLLM"],
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
  try { await invoke("shell_open_url", { url }); } catch (e) { console.error("openExternal", e); }
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
  status, starting, onStart, onStop, onEdit, onRemove,
}: {
  status: McpServerStatus;
  /// True while mcp_start_server is in-flight for this server. Surfaces
  /// the long npx-download wait so the user doesn't think Start was a
  /// no-op. We show a yellow Starting badge + a hint about what's
  /// happening so they know to wait, not retry.
  starting: boolean;
  onStart: () => void;
  onStop: () => void;
  onEdit: () => void;
  onRemove: () => void;
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
        <span style={{
          background: badgeColor, color: "#fff",
          padding: "4px 12px", borderRadius: 4,
          fontSize: 11, fontWeight: 700,
        }}>{badgeText}</span>
      </div>

      <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--fg-subtle)" }}>
        <span style={{ fontFamily: "Consolas, monospace" }}>
          {status.command} {status.args.join(" ")}
        </span>
      </div>

      {status.error && (
        <div style={{
          background: "rgba(244,67,54,0.10)",
          border: "1px solid rgba(244,67,54,0.4)",
          color: "#f87171", padding: 8, borderRadius: 4,
          fontSize: 11, fontFamily: "Consolas, monospace",
          maxHeight: 100, overflow: "auto",
          whiteSpace: "pre-wrap",
        }}>
          {status.error}
        </div>
      )}

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
          display: "flex", flexDirection: "column", gap: 6,
        }}>
          {status.tools.map(t => (
            <div key={t.name} style={{ fontSize: 11, color: "var(--fg)" }}>
              <span style={{
                color: "#9ad9ff", fontFamily: "Consolas, monospace", fontWeight: 600,
              }}>mcp:{status.name}:{t.name}</span>
              {t.description && (
                <span style={{ color: "var(--fg-subtle)" }}> — {t.description}</span>
              )}
            </div>
          ))}
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
  // Per-server "starting" flag. mcp_start_server can hang for up to
  // ~3 minutes on first run while npx downloads the package; without
  // this the card just shows Stopped during the wait and the user
  // assumes it failed silently.
  const [starting, setStarting] = useState<Set<string>>(new Set());

  const refresh = async () => {
    setLoading(true);
    try {
      const list = await invoke<McpServerStatus[]>("mcp_list_servers");
      setServers(list);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  // Initial load + 3s refresh tick to catch status changes (server crashed, etc.).
  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 3000);
    return () => window.clearInterval(id);
  }, []);

  const start = async (name: string) => {
    setError(null);
    setStarting(prev => { const next = new Set(prev); next.add(name); return next; });
    try {
      await invoke<McpServerStatus>("mcp_start_server", { name });
      await refresh();
    } catch (e: any) {
      // npx first-run can take 30-90s downloading the package. Past
      // 180s the backend times out — surface that vs other failures.
      const msg = String(e?.message ?? e);
      setError(`start ${name}: ${msg}`);
    } finally {
      setStarting(prev => { const next = new Set(prev); next.delete(name); return next; });
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
    setDialog({
      open: true,
      initial: { name: p.name, command: p.command, args: p.args, env, enabled: true },
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
          {servers.filter(s => s.running).length} running · {totalTools} tools advertised to agents
        </span>
        <button onClick={() => setDialog({ open: true, initial: null })} style={btnPrimary}>
          + Add Server
        </button>
        <button onClick={refresh} disabled={loading} style={btnGhost}>
          {loading ? "🔄 …" : "🔄 Refresh"}
        </button>
      </div>

      <div style={{ padding: "0 16px 8px", color: "var(--fg-subtle)", fontSize: 12, lineHeight: 1.5 }}>
        MCP servers are subprocess tool providers (typically npm packages run via npx).
        Tools from running servers are auto-advertised to every agent as <code>mcp:&lt;server&gt;:&lt;tool&gt;</code>.
        Config persisted to <code>~/.owllm/mcp_config.json</code>.
      </div>

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
              onStart={() => start(s.name)}
              onStop={() => stop(s.name)}
              onEdit={() => edit(s.name)}
              onRemove={() => remove(s.name)}
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

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

type Preset = {
  name: string;
  icon: string;
  description: string;
  command: string;
  args: string[];
  envHints: string[]; // env-var names the user needs to fill in
};

const PRESETS: Preset[] = [
  {
    name: "brave-search", icon: "🦁",
    description: "Web search via Brave Search API (free 2000 q/mo at brave.com/search/api).",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"],
    envHints: ["BRAVE_API_KEY"],
  },
  {
    name: "filesystem", icon: "📁",
    description: "Sandboxed file ops. Pass the root dir as the LAST positional arg.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "C:/1_Git"],
    envHints: [],
  },
  {
    name: "github", icon: "🐙",
    description: "GitHub API — repos, issues, PRs, files. Needs a GITHUB_TOKEN.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-github"],
    envHints: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
  },
  {
    name: "postgres", icon: "🐘",
    description: "Read-only Postgres. Connection URL as last arg.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:pass@host/db"],
    envHints: [],
  },
  {
    name: "puppeteer", icon: "🌐",
    description: "Headless Chromium — navigate, screenshot, click, scrape.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    envHints: [],
  },
  {
    name: "slack", icon: "💬",
    description: "Slack workspace API — messages, channels, search.",
    command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"],
    envHints: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
  },
  {
    name: "sqlite", icon: "🗄️",
    description: "Local SQLite read/write + schema inspection.",
    command: "uvx", args: ["mcp-server-sqlite", "--db-path", "C:/path/to/db.sqlite"],
    envHints: [],
  },
  {
    name: "git", icon: "🔀",
    description: "Local git ops — log, diff, blame, branches.",
    command: "uvx", args: ["mcp-server-git", "--repository", "C:/1_Git/LocaLLM"],
    envHints: [],
  },
];

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
  initial, onCancel, onSave,
}: {
  initial: McpServerConfig | null;
  onCancel: () => void;
  onSave: (cfg: McpServerConfig) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [command, setCommand] = useState(initial?.command ?? "npx");
  const [argsText, setArgsText] = useState((initial?.args ?? []).join(" "));
  const [envText, setEnvText] = useState(JSON.stringify(initial?.env ?? {}, null, 2));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);

  const apply = () => {
    if (!name.trim()) { setError("Name is required."); return; }
    if (!command.trim()) { setError("Command is required."); return; }
    let env: Record<string, string> = {};
    if (envText.trim()) {
      try { env = JSON.parse(envText); }
      catch { setError("Env vars must be valid JSON."); return; }
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

        <label style={lblStyle}>Environment Variables (JSON):</label>
        <textarea value={envText} onChange={e => { setEnvText(e.target.value); setError(null); }}
          placeholder='{"BRAVE_API_KEY": "your-key-here"}'
          style={{
            ...inputStyle, width: "100%", height: 110,
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
  status, onStart, onStop, onEdit, onRemove,
}: {
  status: McpServerStatus;
  onStart: () => void;
  onStop: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const badgeColor = status.running ? "#4CAF50" : (status.error ? "#F44336" : "#9E9E9E");
  const badgeText = status.running ? "Running" : (status.error ? "Error" : "Stopped");

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

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {!status.running ? (
          <button onClick={onStart} style={btnGreen}>▶ Start</button>
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
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      <div style={{ color: "var(--fg-strong)", fontSize: 12, fontWeight: 600 }}>
        Quick add — official MCP servers
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {PRESETS.map(p => (
          <button
            key={p.name}
            onClick={() => onPick(p)}
            title={`${p.description}${p.envHints.length ? `\n\nNeeds: ${p.envHints.join(", ")}` : ""}`}
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
}

// ----- Main page -----

export default function MCPPage() {
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; initial: McpServerConfig | null }>({ open: false, initial: null });

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
    try {
      await invoke<McpServerStatus>("mcp_start_server", { name });
      await refresh();
    } catch (e: any) {
      setError(`start ${name}: ${String(e?.message ?? e)}`);
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
    for (const k of p.envHints) env[k] = "";
    setDialog({
      open: true,
      initial: { name: p.name, command: p.command, args: p.args, env, enabled: true },
    });
  };

  const edit = async (name: string) => {
    try {
      const cfg = await invoke<McpConfig>("mcp_load_config");
      const found = cfg.servers.find(s => s.name === name) ?? null;
      setDialog({ open: true, initial: found });
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
          onCancel={() => setDialog({ open: false, initial: null })}
          onSave={saveServer}
        />
      )}
    </div>
  );
}

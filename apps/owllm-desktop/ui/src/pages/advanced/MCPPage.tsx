// MCPPage — ported from LLM/desktop_app/pages/mcp_page.py (MCPPage, line 14).
// Tabbed container with three sub-tabs:
//
//   📦 Catalog     — browse MCP servers from the registry
//                    (mcp_catalog_page.py)
//   🔌 Connections — manage installed/configured MCP server connections
//                    (mcp_connections_page.py)
//   🧩 Tools       — aggregated tools from connected servers
//                    (mcp_tools_page.py)
//
// The PySide6 version lazy-loads each sub-page on first click; we render
// all three (state stays per-tab). Background: #0e1117 per page style.
// Sub-tabs use rgba(var(--accent-rgb),0.8) selected / rgba(30,30,40,0.8) idle
// — see mcp_page.py:36-58.
import React, { useMemo, useState } from "react";

type SubTab = "catalog" | "connections" | "tools";

const ICONS = "/Page_icons";
const PANEL_BG = "var(--bg-panel)";

// ---------------------------------------------------------------------
// CATALOG  — mcp_catalog_page.py
// ---------------------------------------------------------------------
// Server card fields (server_card.py:20-136):
//   id|name (required), icon (emoji), description, categories[]|tags[],
//   publisher, install_method (npm|pip|docker|git), package_name,
//   repo_url, branch.
// Catalog search filters by name + description + categories
// (mcp_catalog_page.py:324-336).
// Sort options: ["Popular", "Recent"]  (mcp_catalog_page.py:185).
// Category combo seeded with "All Categories", expanded from server
// categories/tags after fetch (mcp_catalog_page.py:346-355).

type CatalogServer = {
  id: string;
  name: string;
  icon?: string;
  description: string;
  categories: string[];
  publisher: string;
  install_method: "npm" | "pip" | "docker" | "git";
  package_name: string;
  installed?: boolean;
};

// Sample seed data — Qt fetches this from registry.modelcontextprotocol.io
// at runtime (registry_client.py:16). The registry endpoint isn't public
// yet (registry_client.py:71-74 shows it 404s), so the Qt UI shows a
// warning banner and an empty list. We seed a handful of well-known
// official MCP servers from modelcontextprotocol.io/examples so the
// shell isn't empty in dev.
const SAMPLE_CATALOG: CatalogServer[] = [
  {
    id: "github-mcp", name: "github-mcp", icon: "🐙",
    publisher: "anthropic", install_method: "npm",
    package_name: "@modelcontextprotocol/server-github",
    categories: ["Cloud", "VCS"],
    description: "GitHub API — repo browse, issue read/write, PR review, gh CLI passthrough.",
    installed: true,
  },
  {
    id: "puppeteer", name: "puppeteer", icon: "🌐",
    publisher: "modelcontextprotocol", install_method: "npm",
    package_name: "@modelcontextprotocol/server-puppeteer",
    categories: ["Browser"],
    description: "Headless Chromium driver. Navigate, screenshot, click, fill forms, scrape.",
    installed: false,
  },
  {
    id: "postgres", name: "postgres", icon: "🐘",
    publisher: "modelcontextprotocol", install_method: "npm",
    package_name: "@modelcontextprotocol/server-postgres",
    categories: ["Database"],
    description: "Read-only PostgreSQL access. Schema inspection + safe SELECT queries.",
    installed: false,
  },
  {
    id: "filesystem", name: "filesystem", icon: "📁",
    publisher: "modelcontextprotocol", install_method: "npm",
    package_name: "@modelcontextprotocol/server-filesystem",
    categories: ["Files"],
    description: "Sandboxed file ops — read, write, list, search. Constrained to a root dir.",
    installed: true,
  },
  {
    id: "slack", name: "slack", icon: "💬",
    publisher: "modelcontextprotocol", install_method: "npm",
    package_name: "@modelcontextprotocol/server-slack",
    categories: ["Cloud", "Chat"],
    description: "Slack workspace API — read messages, post, list channels, search history.",
    installed: false,
  },
  {
    id: "brave-search", name: "brave-search", icon: "🦁",
    publisher: "brave", install_method: "npm",
    package_name: "@modelcontextprotocol/server-brave-search",
    categories: ["Browser", "Search"],
    description: "Brave web search API. Privacy-preserving, no Google.",
    installed: false,
  },
  {
    id: "sqlite", name: "sqlite", icon: "🗄️",
    publisher: "modelcontextprotocol", install_method: "pip",
    package_name: "mcp-server-sqlite",
    categories: ["Database"],
    description: "Local SQLite database read/write with schema inspection.",
    installed: false,
  },
  {
    id: "git", name: "git", icon: "🔀",
    publisher: "modelcontextprotocol", install_method: "pip",
    package_name: "mcp-server-git",
    categories: ["VCS"],
    description: "Local git repo operations — log, diff, blame, branches.",
    installed: false,
  },
];

function InstallConfirmDialog({
  server, onCancel, onConfirm,
}: {
  server: CatalogServer;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Ported from mcp_catalog_page.py:382-400 — QMessageBox.question with
  // server name, method, package_name fields shown.
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
    }}>
      <div style={{
        background: "#1a1f2e", borderRadius: 10, padding: 24,
        minWidth: 420, maxWidth: 520,
        border: "1px solid rgba(var(--accent-rgb),0.3)",
      }}>
        <div style={{ color: "var(--fg-strong)", fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
          Confirm Installation
        </div>
        <div style={{ color: "var(--fg)", fontSize: 13, lineHeight: 1.6 }}>
          Install <b>{server.name}</b>?
          <div style={{ marginTop: 10 }}><b>Method:</b> {server.install_method}</div>
          <div><b>Package:</b> {server.package_name}</div>
          <div style={{ marginTop: 10, color: "var(--fg-muted)" }}>
            This will download and install the server. Continue?
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button onClick={onCancel} style={btnGhost}>Cancel</button>
          <button onClick={onConfirm} style={btnPrimary}>Install</button>
        </div>
      </div>
    </div>
  );
}

function ServerCard({ server, onInstall }: {
  server: CatalogServer;
  onInstall: (id: string) => void;
}) {
  // server_card.py:26-136 — gradient bg, rounded 8, hover border, icon
  // 32x32, name bold 12pt, description wrap, categories (max 3) as
  // badges, "by {publisher}" + "📦 {install_method}" footer, install
  // button with green→purple gradient.
  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(30,30,40,0.9), rgba(20,20,30,0.9))",
      border: "1px solid rgba(var(--accent-rgb),0.30)",
      borderRadius: 8, padding: 12,
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{
          width: 32, height: 32, fontSize: 22,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {server.icon || "🔌"}
        </div>
        <div style={{ color: "var(--fg-strong)", fontWeight: 700, fontSize: 14 }}>
          {server.name}
        </div>
      </div>
      <div style={{ color: "#cccccc", fontSize: 12, lineHeight: 1.4 }}>
        {server.description}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {server.categories.slice(0, 3).map(cat => (  // max 3 per server_card.py:84
          <span key={cat} style={{
            background: "rgba(var(--accent-rgb),0.30)", color: "var(--fg-strong)",
            padding: "2px 8px", borderRadius: 4, fontSize: 11,
          }}>{cat}</span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, fontSize: 11, color: "var(--fg-subtle)" }}>
        {server.publisher && <span>by {server.publisher}</span>}
        <span>📦 {server.install_method}</span>
      </div>
      <button
        onClick={() => onInstall(server.id)}
        disabled={server.installed}
        style={{
          padding: 8, borderRadius: 4, border: "none", color: "var(--fg-strong)",
          fontWeight: 700, fontSize: 12, marginTop: 4,
          cursor: server.installed ? "default" : "pointer",
          background: server.installed
            ? "rgba(154,160,166,0.25)"
            : "linear-gradient(90deg, rgba(var(--accent-rgb),0.8), rgba(76,175,80,0.8))",
        }}
      >
        {server.installed ? "✓ Installed" : "📥 Install"}
      </button>
    </div>
  );
}

function CatalogTab() {
  const [servers, setServers] = useState<CatalogServer[]>(SAMPLE_CATALOG);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All Categories");
  const [sort, setSort] = useState<"Popular" | "Recent">("Popular");
  const [status, setStatus] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [installTarget, setInstallTarget] = useState<CatalogServer | null>(null);

  // Build category list from servers + "All Categories" sentinel
  // (mcp_catalog_page.py:346-355).
  const categories = useMemo(() => {
    const set = new Set<string>(["All Categories"]);
    for (const s of servers) for (const c of s.categories) set.add(c);
    return Array.from(set).sort();
  }, [servers]);

  // Client-side filter — mcp_catalog_page.py:324-336 matches against
  // name + description + (space-joined) categories.
  const visible = servers.filter(s => {
    if (category !== "All Categories" && !s.categories.includes(category)) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return s.name.toLowerCase().includes(q)
        || s.description.toLowerCase().includes(q)
        || s.categories.join(" ").toLowerCase().includes(q);
  });

  const refresh = () => {
    // Qt does a FetchServersThread against registry.modelcontextprotocol.io
    // (mcp_catalog_page.py:245-293). We just simulate the async cycle.
    setRefreshing(true);
    setStatus(null);
    setTimeout(() => {
      setRefreshing(false);
      // Mimic the 404 banner from registry_client.py:71-74.
      setStatus(
        "MCP registry API not available yet. Showing built-in catalog. " +
        "You can manually add servers in the Connections tab."
      );
    }, 600);
  };

  const onInstallConfirm = () => {
    if (!installTarget) return;
    setServers(prev => prev.map(s => s.id === installTarget.id ? { ...s, installed: true } : s));
    setStatus(`Installed ${installTarget.name} (${installTarget.install_method})`);
    setInstallTarget(null);
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 16, gap: 12, overflow: "hidden" }}>
      {/* Title — mcp_catalog_page.py:154 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <img src={`${ICONS}/owl_tools.png`} style={{ width: 28, height: 28 }} alt="" />
        <div style={{ color: "var(--fg-strong)", fontSize: 18, fontWeight: 700 }}>📦 MCP Catalog</div>
      </div>

      {/* Top bar — Search | Category | Sort | Refresh
          mcp_catalog_page.py:158-193 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--fg-strong)", fontSize: 12 }}>Search:</span>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search servers..."
          style={inputStyle}
        />
        <span style={{ color: "var(--fg-strong)", fontSize: 12 }}>Category:</span>
        <select value={category} onChange={e => setCategory(e.target.value)} style={selectStyle}>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <span style={{ color: "var(--fg-strong)", fontSize: 12 }}>Sort:</span>
        <select
          value={sort}
          onChange={e => setSort(e.target.value as "Popular" | "Recent")}
          style={selectStyle}
        >
          {/* mcp_catalog_page.py:185 — addItems(["Popular", "Recent"]) */}
          <option>Popular</option>
          <option>Recent</option>
        </select>
        <button onClick={refresh} disabled={refreshing} style={btnGhost}>
          {refreshing ? "🔄 Refreshing..." : "🔄 Refresh"}
        </button>
      </div>

      {/* Status banner — mcp_catalog_page.py:196-214
          orange bg #ff9800 @ 0.2 alpha, border @ 0.6 alpha */}
      {status && (
        <div style={{
          background: "rgba(255,152,0,0.20)",
          border: "1px solid rgba(255,152,0,0.60)",
          borderRadius: 6, padding: 8,
          color: "#ffcc80", fontSize: 12,
        }}>
          {status}
        </div>
      )}

      {/* Server cards — vertical list, spacing 12 (mcp_catalog_page.py:224) */}
      <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
        {visible.length === 0 && (
          <div style={{ color: "var(--fg-subtle)", textAlign: "center", padding: 40, fontSize: 12 }}>
            No servers match the current filters.
          </div>
        )}
        {visible.map(s => (
          <ServerCard key={s.id} server={s} onInstall={() => setInstallTarget(s)} />
        ))}
      </div>

      {installTarget && (
        <InstallConfirmDialog
          server={installTarget}
          onCancel={() => setInstallTarget(null)}
          onConfirm={onInstallConfirm}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// CONNECTIONS  — mcp_connections_page.py
// ---------------------------------------------------------------------
// ConnectionCard fields (connection_card.py:24-238):
//   server_id (required), name, install_method (npm|pip|docker|git|local),
//   status ∈ {installed, configured, running, connected, stopped},
//   config: {url, auth_token, env_vars}.
// Status badge colors (connection_card.py:201-206):
//   installed=#9E9E9E, configured=#FF9800, running=#4CAF50,
//   connected=#2196F3.
// For install_method=="local", Start/Stop are hidden (connection_card.py:225-230).
// Buttons: Configure / Start / Stop / Connect / Disconnect.
// Header has "🔗 Connect to Local Server" + "🔄 Refresh"
// (mcp_connections_page.py:171-191).

type ConnStatus = "installed" | "configured" | "running" | "connected" | "stopped";

type Connection = {
  server_id: string;
  name: string;
  install_method: "npm" | "pip" | "docker" | "git" | "local";
  status: ConnStatus;
  config: { url: string; auth_token: string; env_vars: Record<string, string> };
};

const STATUS_META: Record<ConnStatus, { color: string; label: string }> = {
  // connection_card.py:201-206
  installed:  { color: "#9E9E9E", label: "Installed"  },
  configured: { color: "#FF9800", label: "Configured" },
  running:    { color: "#4CAF50", label: "Running"    },
  connected:  { color: "#2196F3", label: "Connected"  },
  stopped:    { color: "var(--fg-subtle)",    label: "Stopped"    },
};

const SAMPLE_CONNECTIONS: Connection[] = [
  {
    server_id: "github-mcp", name: "github-mcp",
    install_method: "npm", status: "connected",
    config: {
      url: "stdio:npx @modelcontextprotocol/server-github",
      auth_token: "", env_vars: { GITHUB_TOKEN: "ghp_***" },
    },
  },
  {
    server_id: "filesystem", name: "filesystem",
    install_method: "npm", status: "running",
    config: {
      url: "stdio:npx @modelcontextprotocol/server-filesystem ./",
      auth_token: "", env_vars: {},
    },
  },
  {
    server_id: "local_tool_server", name: "Local Tool Server",
    install_method: "local", status: "configured",
    config: { url: "http://127.0.0.1:8765", auth_token: "CHANGE_ME", env_vars: {} },
  },
  {
    server_id: "postgres-dev", name: "postgres",
    install_method: "npm", status: "stopped",
    config: { url: "http://localhost:8765/mcp", auth_token: "", env_vars: {} },
  },
];

function ConfigureDialog({
  conn, onCancel, onSave,
}: {
  conn: Connection;
  onCancel: () => void;
  onSave: (cfg: Connection["config"]) => void;
}) {
  // Ported from ConfigureServerDialog (mcp_connections_page.py:26-133).
  // Fields: Server URL, Auth Token (password), Env Vars (JSON text area),
  // warning banner about plaintext secrets.
  const [url, setUrl] = useState(conn.config.url);
  const [token, setToken] = useState(conn.config.auth_token);
  const [envText, setEnvText] = useState(JSON.stringify(conn.config.env_vars, null, 2));
  const [envError, setEnvError] = useState<string | null>(null);

  const save = () => {
    // Normalize 0.0.0.0 → 127.0.0.1 (mcp_connections_page.py:115).
    const normalizedUrl = url.replace("0.0.0.0", "127.0.0.1").trim();
    let env_vars: Record<string, string> = {};
    if (envText.trim()) {
      try {
        env_vars = JSON.parse(envText);
      } catch {
        setEnvError("Invalid JSON — env vars not saved.");
        env_vars = {};
      }
    }
    onSave({ url: normalizedUrl, auth_token: token.trim(), env_vars });
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
    }}>
      <div style={{
        background: "#1a1f2e", borderRadius: 10, padding: 24,
        minWidth: 500, maxWidth: 600, maxHeight: "85vh", overflow: "auto",
        border: "1px solid rgba(var(--accent-rgb),0.3)",
      }}>
        <div style={{ color: "var(--fg-strong)", fontSize: 16, fontWeight: 700, marginBottom: 16 }}>
          Configure: {conn.name}
        </div>

        <label style={lblStyle}>Server URL:</label>
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="http://127.0.0.1:8000"
          style={{ ...inputStyle, width: "100%", marginBottom: 12 }}
        />

        <label style={lblStyle}>Auth Token (optional):</label>
        <input
          type="password"
          value={token}
          onChange={e => setToken(e.target.value)}
          placeholder="Leave empty if not required"
          style={{ ...inputStyle, width: "100%", marginBottom: 12 }}
        />

        <label style={lblStyle}>Environment Variables (JSON format):</label>
        <textarea
          value={envText}
          onChange={e => { setEnvText(e.target.value); setEnvError(null); }}
          style={{
            ...inputStyle, width: "100%", height: 130,
            fontFamily: "Consolas, monospace", resize: "vertical",
            padding: 8,
          }}
        />
        {envError && (
          <div style={{ color: "#f87171", fontSize: 11, marginTop: 4 }}>{envError}</div>
        )}

        {/* Plaintext warning — mcp_connections_page.py:77-82 */}
        <div style={{ color: "#ff9800", fontSize: 11, marginTop: 12, lineHeight: 1.5 }}>
          ⚠️ Secrets are stored in plaintext. Use OS credential store if available.
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button onClick={onCancel} style={btnGhost}>Cancel</button>
          <button onClick={save} style={btnPrimary}>Save</button>
        </div>
      </div>
    </div>
  );
}

function HandshakeInspector({ conn, onClose }: { conn: Connection; onClose: () => void }) {
  // The Qt code doesn't have a dedicated handshake dialog — Connect()
  // pops a QMessageBox showing tool count (mcp_connections_page.py:444-459).
  // Here we render a richer read-only inspector to surface that info.
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
    }}>
      <div style={{
        background: "#1a1f2e", borderRadius: 10, padding: 24,
        minWidth: 480, maxWidth: 640,
        border: "1px solid rgba(var(--accent-rgb),0.3)",
      }}>
        <div style={{ color: "var(--fg-strong)", fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
          Handshake — {conn.name}
        </div>
        <div style={{ color: "var(--fg)", fontSize: 12, lineHeight: 1.7 }}>
          <div><b>server_id:</b> <code>{conn.server_id}</code></div>
          <div><b>install_method:</b> {conn.install_method}</div>
          <div><b>status:</b> {STATUS_META[conn.status].label}</div>
          <div><b>endpoint:</b> <code>{conn.config.url}</code></div>
          <div><b>auth_token:</b> {conn.config.auth_token ? "(set)" : "(none)"}</div>
          <div style={{ marginTop: 8 }}>
            <b>env_vars:</b>
            <pre style={{
              background: "rgba(0,0,0,0.4)", padding: 10, borderRadius: 6,
              fontSize: 11, color: "#4ade80", marginTop: 4,
              fontFamily: "Consolas, monospace",
            }}>
{JSON.stringify(conn.config.env_vars, null, 2)}
            </pre>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={onClose} style={btnPrimary}>Close</button>
        </div>
      </div>
    </div>
  );
}

function ConnectionCard({
  conn, onConfigure, onStart, onStop, onConnect, onDisconnect, onInspect,
}: {
  conn: Connection;
  onConfigure: (id: string) => void;
  onStart:     (id: string) => void;
  onStop:      (id: string) => void;
  onConnect:   (id: string) => void;
  onDisconnect:(id: string) => void;
  onInspect:   (id: string) => void;
}) {
  // connection_card.py:31-238 — gradient bg, top row name+status badge,
  // info row "Method: {install_method}", buttons row, collapsible logs.
  // For install_method=="local", Start/Stop are hidden.
  const meta = STATUS_META[conn.status];
  const isLocal = conn.install_method === "local";
  // Button enable rules from connection_card.py:222-238.
  const startEnabled = ["installed", "configured", "stopped"].includes(conn.status);
  const stopEnabled  = conn.status === "running";
  const connectEnabled = isLocal
    ? ["configured", "running", "installed"].includes(conn.status)
    : conn.status === "running";
  const disconnectEnabled = conn.status === "connected";

  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(30,30,40,0.9), rgba(20,20,30,0.9))",
      border: "1px solid rgba(var(--accent-rgb),0.30)",
      borderRadius: 8, padding: 12,
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ color: "var(--fg-strong)", fontWeight: 700, fontSize: 14, flex: 1 }}>
          {conn.name}
        </div>
        <button
          onClick={() => onInspect(conn.server_id)}
          title="Inspect handshake / capabilities"
          style={{ ...btnGhost, padding: "4px 10px", fontSize: 11 }}
        >
          🔍 Inspect
        </button>
        <span style={{
          background: meta.color, color: "var(--fg-strong)",
          padding: "4px 12px", borderRadius: 4,
          fontSize: 11, fontWeight: 700,
        }}>{meta.label}</span>
      </div>

      <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--fg-subtle)" }}>
        <span>Method: {conn.install_method}</span>
        <span style={{ fontFamily: "Consolas, monospace" }}>{conn.config.url}</span>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button onClick={() => onConfigure(conn.server_id)} style={btnPurple}>⚙️ Configure</button>
        {!isLocal && (
          <button onClick={() => onStart(conn.server_id)} disabled={!startEnabled}
            style={{ ...btnGreen, opacity: startEnabled ? 1 : 0.4 }}>▶ Start</button>
        )}
        {!isLocal && (
          <button onClick={() => onStop(conn.server_id)} disabled={!stopEnabled}
            style={{ ...btnRed, opacity: stopEnabled ? 1 : 0.4 }}>⏹ Stop</button>
        )}
        <button onClick={() => onConnect(conn.server_id)} disabled={!connectEnabled}
          style={{ ...btnPurple, opacity: connectEnabled ? 1 : 0.4 }}>🔗 Connect</button>
        <button onClick={() => onDisconnect(conn.server_id)} disabled={!disconnectEnabled}
          style={{ ...btnGray, opacity: disconnectEnabled ? 1 : 0.4 }}>🔌 Disconnect</button>
      </div>
    </div>
  );
}

function ConnectionsTab() {
  const [conns, setConns] = useState<Connection[]>(SAMPLE_CONNECTIONS);
  const [configuring, setConfiguring] = useState<Connection | null>(null);
  const [inspecting, setInspecting] = useState<Connection | null>(null);

  // mcp_connections_page.py:523-666 — auto-add server_id=local_tool_server
  // pointing at http://127.0.0.1:{port} reading host/port/token from
  // the server config; then auto-connect after 500ms.
  const connectLocal = () => {
    setConns(prev => {
      if (prev.some(c => c.server_id === "local_tool_server")) return prev;
      const local: Connection = {
        server_id: "local_tool_server", name: "Local Tool Server",
        install_method: "local", status: "configured",
        config: { url: "http://127.0.0.1:8765", auth_token: "CHANGE_ME", env_vars: {} },
      };
      return [...prev, local];
    });
  };

  const refresh = () => {
    // Qt re-reads from connection_manager (mcp_connections_page.py:217-225).
    // No-op for local mock state.
  };

  const onConfigure = (id: string) => {
    const c = conns.find(x => x.server_id === id);
    if (c) setConfiguring(c);
  };
  const saveConfig = (cfg: Connection["config"]) => {
    if (!configuring) return;
    setConns(prev => prev.map(c =>
      c.server_id === configuring.server_id
        ? { ...c, config: cfg, status: "configured" } : c));
    setConfiguring(null);
  };
  // Status transitions match Qt handlers in mcp_connections_page.py.
  const onStart      = (id: string) => setConns(p => p.map(c => c.server_id === id ? { ...c, status: "running"    } : c));
  const onStop       = (id: string) => setConns(p => p.map(c => c.server_id === id ? { ...c, status: "stopped"    } : c));
  const onConnect    = (id: string) => setConns(p => p.map(c => c.server_id === id ? { ...c, status: "connected"  } : c));
  const onDisconnect = (id: string) => setConns(p => p.map(c => c.server_id === id ? { ...c, status: "configured" } : c));
  const onInspect    = (id: string) => {
    const c = conns.find(x => x.server_id === id);
    if (c) setInspecting(c);
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 16, gap: 12, overflow: "hidden" }}>
      {/* Header — mcp_connections_page.py:163-193 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <img src={`${ICONS}/owl_server.png`} style={{ width: 28, height: 28 }} alt="" />
        <div style={{ color: "var(--fg-strong)", fontSize: 18, fontWeight: 700, flex: 1 }}>
          🔌 MCP Connections
        </div>
        <button onClick={connectLocal} style={btnPrimary}>🔗 Connect to Local Server</button>
        <button onClick={refresh} style={btnGhost}>🔄 Refresh</button>
      </div>

      {/* Info subtitle — mcp_connections_page.py:196-201 */}
      <div style={{ color: "var(--fg-subtle)", fontSize: 12 }}>
        Manage installed MCP servers. Configure, start, and connect to servers to use their tools.
      </div>

      <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
        {conns.length === 0 && (
          <div style={{ color: "var(--fg-subtle)", textAlign: "center", padding: 40, fontSize: 12 }}>
            No servers installed. Go to Catalog to install servers.
          </div>
        )}
        {conns.map(c => (
          <ConnectionCard
            key={c.server_id} conn={c}
            onConfigure={onConfigure}
            onStart={onStart} onStop={onStop}
            onConnect={onConnect} onDisconnect={onDisconnect}
            onInspect={onInspect}
          />
        ))}
      </div>

      {configuring && (
        <ConfigureDialog
          conn={configuring}
          onCancel={() => setConfiguring(null)}
          onSave={saveConfig}
        />
      )}
      {inspecting && (
        <HandshakeInspector conn={inspecting} onClose={() => setInspecting(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// TOOLS  — mcp_tools_page.py
// ---------------------------------------------------------------------
// Tool fields (tool_card.py:38-218):
//   name, description, source_server (origin connection name),
//   category, danger_level ∈ {safe, warning, dangerous}, enabled,
//   args_schema_json | input_schema (JSON-schema for params).
// Danger colors (tool_card.py:32-36):
//   safe=#4CAF50, warning=#FF9800, dangerous=#F44336.
// Layout: 2 scroll columns of cards + right exec panel
// (mcp_tools_page.py:269-505) — we keep that intent but render the
// cards in a CSS grid and only show the right panel when a tool is
// selected.
// Per-tool enabled state is persisted in config.enabled_tools
// (mcp_tools_page.py:639-684) — represents the tool_allowlist UI.

type Tool = {
  name: string;
  description: string;
  source_server: string;
  category: string;
  danger_level: "safe" | "warning" | "dangerous";
  enabled: boolean;
  input_schema?: Record<string, unknown>;
};

const DANGER_COLORS = {
  safe:      "#4CAF50",
  warning:   "#FF9800",
  dangerous: "#F44336",
} as const;

const SAMPLE_TOOLS: Tool[] = [
  { name: "list_repos",  source_server: "github-mcp", category: "VCS",   danger_level: "safe",      enabled: true,
    description: "List repos for the authenticated user." },
  { name: "get_pr",      source_server: "github-mcp", category: "VCS",   danger_level: "safe",      enabled: true,
    description: "Fetch a PR by number with diff + comments.",
    input_schema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, number: { type: "integer" } }, required: ["owner", "repo", "number"] } },
  { name: "create_pr",   source_server: "github-mcp", category: "VCS",   danger_level: "warning",   enabled: true,
    description: "Open a new PR against a target branch.",
    input_schema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, base: { type: "string" }, head: { type: "string" } }, required: ["title", "base", "head"] } },
  { name: "merge_pr",    source_server: "github-mcp", category: "VCS",   danger_level: "dangerous", enabled: false,
    description: "Squash-merge a PR (requires write scope)." },
  { name: "read_file",   source_server: "filesystem", category: "Files", danger_level: "safe",      enabled: true,
    description: "Read a file inside the sandboxed root.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file",  source_server: "filesystem", category: "Files", danger_level: "warning",   enabled: true,
    description: "Write/overwrite a file inside the root." },
  { name: "list_dir",    source_server: "filesystem", category: "Files", danger_level: "safe",      enabled: true,
    description: "List entries in a directory." },
  { name: "search",      source_server: "filesystem", category: "Files", danger_level: "safe",      enabled: true,
    description: "Recursive glob/regex search over the root." },
];

function SchemaViewer({ schema }: { schema?: Record<string, unknown> }) {
  // tool_card.py uses SchemaForm to render an input form from the
  // JSON-schema. Here we show a read-only viewer (matches the Qt
  // schema_form intent at mcp_tools_page.py:80-94).
  if (!schema) return (
    <div style={{ color: "var(--fg-subtle)", fontSize: 11, fontStyle: "italic" }}>
      No parameters required.
    </div>
  );
  return (
    <pre style={{
      background: "rgba(0,0,0,0.4)", color: "#9fa8ff",
      padding: 10, borderRadius: 6, fontSize: 11,
      fontFamily: "Consolas, monospace", overflow: "auto", maxHeight: 200,
    }}>
{JSON.stringify(schema, null, 2)}
    </pre>
  );
}

function ToolCard({ tool, onRun, onToggle, onSelect }: {
  tool: Tool;
  onRun: (n: string) => void;
  onToggle: (n: string, v: boolean) => void;
  onSelect: (n: string) => void;
}) {
  // tool_card.py:44-218 — gradient bg, icon 40x40, name 14pt, desc,
  // badges row [source_server, category, danger_level], enable
  // checkbox, run button.
  const danger = DANGER_COLORS[tool.danger_level];
  return (
    <div
      onClick={() => onSelect(tool.name)}
      style={{
        background: "linear-gradient(180deg, rgba(40,40,55,0.6), rgba(25,25,35,0.6))",
        border: "1px solid rgba(var(--accent-rgb),0.20)",
        borderRadius: 12, padding: 16,
        display: "flex", flexDirection: "column", gap: 8,
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{
          width: 40, height: 40, fontSize: 20,
          background: "rgba(var(--accent-rgb),0.15)", borderRadius: 8,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>🔧</div>
        <div style={{ color: "var(--fg-strong)", fontSize: 14, fontWeight: 700, flex: 1 }}>
          {tool.name}
        </div>
        <label
          onClick={e => e.stopPropagation()}
          style={{ color: "#b0b0b0", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}
        >
          <input
            type="checkbox"
            checked={tool.enabled}
            onChange={e => onToggle(tool.name, e.target.checked)}
          />
          Enable
        </label>
      </div>
      <div style={{ color: "#b0b0b0", fontSize: 11, lineHeight: 1.4 }}>
        {tool.description}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span style={{
          background: "rgba(156,39,176,0.20)", color: "#ce93d8",
          padding: "3px 8px", borderRadius: 8, fontSize: 10, fontWeight: 600,
          border: "1px solid rgba(156,39,176,0.30)",
        }}>🔌 {tool.source_server}</span>
        <span style={{
          background: "rgba(var(--accent-rgb),0.20)", color: "#9fa8ff",
          padding: "3px 8px", borderRadius: 8, fontSize: 10, fontWeight: 500,
          border: "1px solid rgba(var(--accent-rgb),0.30)",
        }}>{tool.category}</span>
        <span style={{
          background: `${danger}33`, color: danger,
          padding: "3px 8px", borderRadius: 8, fontSize: 10, fontWeight: 600,
          border: `1px solid ${danger}66`,
          textTransform: "uppercase",
        }}>{tool.danger_level}</span>
      </div>
      <button
        onClick={e => { e.stopPropagation(); onRun(tool.name); }}
        style={{
          padding: 8, borderRadius: 6, border: "1px solid rgba(var(--accent-rgb),0.40)",
          background: "linear-gradient(90deg, rgba(var(--accent-rgb),0.30), rgba(118,75,162,0.30))",
          color: "var(--fg-strong)", fontWeight: 600, fontSize: 11, cursor: "pointer",
        }}
      >▶ Run Tool</button>
    </div>
  );
}

function ToolsTab() {
  const [tools, setTools] = useState<Tool[]>(SAMPLE_TOOLS);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All Categories");
  const [selected, setSelected] = useState<Tool | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const [output, setOutput] = useState<string>("");

  const categories = useMemo(() => {
    const set = new Set<string>(["All Categories"]);
    for (const t of tools) set.add(t.category || "General");
    return Array.from(set).sort();
  }, [tools]);

  // Filter rules — mcp_tools_page.py:561-570.
  const visible = tools.filter(t => {
    const ms = !search ||
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.description.toLowerCase().includes(search.toLowerCase());
    const mc = category === "All Categories" || t.category === category;
    return ms && mc;
  });

  const onToggle = (name: string, enabled: boolean) => {
    // tool_allowlist persistence — mcp_tools_page.py:671-684.
    setTools(prev => prev.map(t => t.name === name ? { ...t, enabled } : t));
  };
  const onRun = (name: string) => {
    const t = tools.find(x => x.name === name) || null;
    setSelected(t);
    setOutput("");
    setDryRun(false);
  };
  const execute = () => {
    if (!selected) return;
    if (dryRun) {
      // mcp_tools_page.py:746-749
      setOutput(`[DRY RUN] Would execute: ${selected.name}\n\nArgs: (form values)`);
      return;
    }
    setOutput(`Executing ${selected.name}... (backend not wired in dev shell)`);
  };
  const copyOutput = () => {
    if (output) navigator.clipboard?.writeText(output);
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 16, gap: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <img src={`${ICONS}/owl_tools.png`} style={{ width: 28, height: 28 }} alt="" />
        <div style={{ color: "var(--fg-strong)", fontSize: 18, fontWeight: 700 }}>🧩 MCP Tools</div>
      </div>

      {/* Top bar — Search | Category | Refresh (mcp_tools_page.py:246-266) */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search tools..."
          style={{ ...inputStyle, flex: 1 }}
        />
        <select value={category} onChange={e => setCategory(e.target.value)} style={selectStyle}>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button style={btnGhost}>🔄 Refresh</button>
      </div>

      <div style={{ color: "var(--fg)", fontSize: 12 }}>
        {tools.length} tool(s) from {new Set(tools.map(t => t.source_server)).size} connected
        server(s). Agents can call any of these per their tool_allowlist
        (toggle <i>Enable</i> on each card).
      </div>

      {/* Two-pane layout: cards grid + right exec panel
          mcp_tools_page.py:269-505 uses QSplitter with 1/3 ratios. */}
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: selected ? "2fr 1fr" : "1fr", gap: 12, overflow: "hidden" }}>
        <div style={{ overflow: "auto" }}>
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 12,
          }}>
            {visible.map(t => (
              <ToolCard key={t.name} tool={t}
                onRun={onRun} onToggle={onToggle}
                onSelect={n => onRun(n)} />
            ))}
          </div>
          {visible.length === 0 && (
            <div style={{ color: "var(--fg-subtle)", textAlign: "center", padding: 40, fontSize: 12 }}>
              No tools available. Connect to servers first.
            </div>
          )}
        </div>

        {selected && (
          <div style={{
            background: "rgba(20,25,40,0.55)",
            border: "1px solid rgba(var(--accent-rgb),0.20)",
            borderRadius: 10, padding: 16,
            display: "flex", flexDirection: "column", gap: 10, overflow: "auto",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ color: "var(--fg-strong)", fontSize: 16, fontWeight: 700, flex: 1 }}>
                {selected.name}
              </div>
              <button onClick={() => setSelected(null)} style={{ ...btnGhost, padding: "2px 8px", fontSize: 14 }}>✕</button>
            </div>
            <div style={{ color: "var(--fg-subtle)", fontSize: 11 }}>From: {selected.source_server}</div>
            <div style={{ color: "#b0b0b0", fontSize: 12, lineHeight: 1.5 }}>
              {selected.description}
            </div>

            <div style={{
              color: "#667eea", fontSize: 11, fontWeight: 700,
              letterSpacing: 1, paddingTop: 6,
              borderTop: "1px solid rgba(var(--accent-rgb),0.20)",
            }}>PARAMETERS (JSON-Schema)</div>
            <SchemaViewer schema={selected.input_schema} />

            <label style={{ color: "#b0b0b0", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} />
              Dry run (validate only, don't execute)
            </label>

            <button onClick={execute} style={{
              padding: 10, borderRadius: 8, border: "1px solid rgba(76,175,80,0.50)",
              background: "linear-gradient(90deg, rgba(76,175,80,0.30), rgba(var(--accent-rgb),0.30))",
              color: "var(--fg-strong)", fontWeight: 600, fontSize: 12, cursor: "pointer",
            }}>▶ Execute Tool</button>

            {output && (
              <>
                <div style={{
                  color: "#667eea", fontSize: 11, fontWeight: 700,
                  letterSpacing: 1, paddingTop: 6,
                  borderTop: "1px solid rgba(var(--accent-rgb),0.20)",
                }}>OUTPUT</div>
                <pre style={{
                  background: "rgba(0,0,0,0.40)", color: "#4ade80",
                  fontFamily: "Consolas, monospace", fontSize: 11,
                  padding: 10, borderRadius: 6,
                  border: "1px solid rgba(var(--accent-rgb),0.20)",
                  whiteSpace: "pre-wrap", margin: 0,
                }}>{output}</pre>
                <button onClick={copyOutput} style={btnGhost}>📋 Copy Output</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Shared inline styles
// ---------------------------------------------------------------------
const inputStyle: React.CSSProperties = {
  height: 32, padding: "0 12px",
  borderRadius: 6, border: "1px solid rgba(var(--accent-rgb),0.30)",
  background: "rgba(40,40,50,0.80)", color: "var(--fg-strong)", fontSize: 12,
};
const selectStyle: React.CSSProperties = {
  ...inputStyle, padding: "0 10px",
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
const btnPurple: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 4, border: "none", color: "var(--fg-strong)",
  fontSize: 11, fontWeight: 600, cursor: "pointer",
  background: "rgba(var(--accent-rgb),0.60)",
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

// ---------------------------------------------------------------------
// Main — tab strip per mcp_page.py:36-58
// ---------------------------------------------------------------------
const TABS: { key: SubTab; label: string }[] = [
  { key: "catalog",     label: "📦 Catalog" },
  { key: "connections", label: "🔌 Connections" },
  { key: "tools",       label: "🧩 Tools" },
];

export default function MCPPage() {
  const [tab, setTab] = useState<SubTab>("catalog");
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: PANEL_BG }}>
      {/* Tab strip — mcp_page.py:36-58 (padding 10/20, min-height 22+padding,
          radius 6 top-only, selected bg rgba(var(--accent-rgb),0.8)) */}
      <div style={{
        display: "flex", gap: 4,
        padding: "8px 16px 0",
        borderBottom: "1px solid rgba(var(--accent-rgb),0.10)",
      }}>
        {TABS.map(t => {
          const active = t.key === tab;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: "10px 20px",
                background: active ? "rgba(var(--accent-rgb),0.80)" : "rgba(30,30,40,0.80)",
                color: "var(--fg-strong)", border: "none",
                borderTopLeftRadius: 6, borderTopRightRadius: 6,
                fontSize: 13, fontWeight: 600,
                cursor: "pointer", minHeight: 32,
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {tab === "catalog"     && <CatalogTab />}
      {tab === "connections" && <ConnectionsTab />}
      {tab === "tools"       && <ToolsTab />}
    </div>
  );
}

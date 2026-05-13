// MCPPage — ported from LLM/desktop_app/pages/mcp_page.py
// (MCPPage, line 14). Tabbed container with three sub-tabs:
//
//   📦 Catalog     — browse MCP servers from the registry
//   🔌 Connections — manage active MCP server connections
//   🧩 Tools       — list tools exposed by connected MCPs
//
// The PySide6 version lazy-loads each sub-page on first click; we
// just render all three (they're small enough). Each sub-tab maps
// to mcp_catalog_page.py / mcp_connections_page.py /
// mcp_tools_page.py respectively.
import React, { useState } from "react";

type SubTab = "catalog" | "connections" | "tools";

// ---------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------
function SearchBar({
  search, setSearch, category, setCategory, sort, setSort,
}: {
  search: string; setSearch: (v: string) => void;
  category: string; setCategory: (v: string) => void;
  sort: string; setSort: (v: string) => void;
}) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      paddingBottom: 8,
    }}>
      <span style={{ color: "#fff", fontSize: 13 }}>Search:</span>
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search servers..."
        style={{
          flex: 1, height: 32, padding: "0 12px",
          borderRadius: 6, border: "1px solid rgba(255,255,255,0.10)",
          background: "#0f0f19", color: "#dadcdf", fontSize: 13,
        }}
      />
      <span style={{ color: "#fff", fontSize: 13 }}>Category:</span>
      <select
        value={category}
        onChange={e => setCategory(e.target.value)}
        style={{ height: 32, padding: "0 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.10)", background: "#0f0f19", color: "#fff", fontSize: 13 }}
      >
        <option>All Categories</option>
        <option>Browser</option>
        <option>Files</option>
        <option>Database</option>
        <option>Cloud</option>
      </select>
      <span style={{ color: "#fff", fontSize: 13 }}>Sort:</span>
      <select
        value={sort}
        onChange={e => setSort(e.target.value)}
        style={{ height: 32, padding: "0 10px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.10)", background: "#0f0f19", color: "#fff", fontSize: 13 }}
      >
        <option>Popular</option>
        <option>Recent</option>
      </select>
      <button className="ghost-btn" style={{ height: 32 }}>🔄 Refresh</button>
    </div>
  );
}

function ServerCard({ name, vendor, description, installed, category }: {
  name: string; vendor: string; description: string;
  installed: boolean; category: string;
}) {
  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(45,52,68,0.85), rgba(30,35,46,0.85))",
      border: "1px solid rgba(127,223,255,0.10)",
      borderRadius: 12,
      padding: "14px 18px",
      display: "flex",
      alignItems: "center",
      gap: 14,
    }}>
      <div style={{ width: 44, height: 44, borderRadius: 8, background: "rgba(127,223,255,0.10)",
                   display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>
        🔧
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ color: "#fff", fontWeight: 700, fontSize: 14 }}>{name}</div>
          <div style={{
            color: "#9aa0a6", fontSize: 11,
            background: "rgba(154,160,166,0.15)",
            padding: "2px 6px", borderRadius: 4,
            textTransform: "uppercase", letterSpacing: 0.4,
          }}>{category}</div>
        </div>
        <div style={{ color: "#7888a8", fontSize: 11, marginTop: 2 }}>by {vendor}</div>
        <div style={{ color: "#dadcdf", fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>{description}</div>
      </div>
      <button
        style={{
          height: 32, padding: "0 14px",
          borderRadius: 6, border: "none",
          background: installed
            ? "rgba(154,160,166,0.18)"
            : "linear-gradient(180deg, #4a6cff, #3a55cc)",
          color: installed ? "#dadcdf" : "#fff",
          fontWeight: 700, fontSize: 12,
          cursor: installed ? "default" : "pointer",
        }}
      >
        {installed ? "✓ Installed" : "Install"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------
function CatalogTab() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All Categories");
  const [sort, setSort] = useState("Popular");
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 16, gap: 12, overflow: "hidden" }}>
      <SearchBar
        search={search} setSearch={setSearch}
        category={category} setCategory={setCategory}
        sort={sort} setSort={setSort}
      />
      <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
        <ServerCard
          name="github-mcp" vendor="anthropic" category="Cloud"
          description="GitHub API — repo browse, issue read/write, PR review, gh CLI passthrough."
          installed={true}
        />
        <ServerCard
          name="puppeteer" vendor="modelcontextprotocol" category="Browser"
          description="Headless Chromium driver. Navigate, screenshot, click, fill forms, scrape."
          installed={false}
        />
        <ServerCard
          name="postgres" vendor="modelcontextprotocol" category="Database"
          description="Read-only PostgreSQL access. Schema inspection + safe SELECT queries."
          installed={false}
        />
        <ServerCard
          name="filesystem" vendor="modelcontextprotocol" category="Files"
          description="Sandboxed file ops — read, write, list, search. Constrained to a root dir."
          installed={true}
        />
        <ServerCard
          name="slack" vendor="modelcontextprotocol" category="Cloud"
          description="Slack workspace API — read messages, post, list channels, search history."
          installed={false}
        />
        <ServerCard
          name="brave-search" vendor="brave" category="Browser"
          description="Brave web search API. Privacy-preserving, no Google."
          installed={false}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------
function ConnectionRow({ name, endpoint, status }: {
  name: string; endpoint: string; status: "connected" | "disconnected" | "error";
}) {
  const color = status === "connected" ? "#22c55e"
              : status === "error"     ? "#ef4444" : "#9aa0a6";
  return (
    <div style={{
      background: "rgba(255,255,255,0.03)",
      borderRadius: 8, padding: "12px 16px",
      display: "flex", alignItems: "center", gap: 14,
    }}>
      <span style={{ width: 10, height: 10, borderRadius: 5, background: color, boxShadow: `0 0 6px ${color}` }} />
      <div style={{ flex: 1 }}>
        <div style={{ color: "#fff", fontWeight: 700, fontSize: 13 }}>{name}</div>
        <div style={{ color: "#9aa0a6", fontSize: 11, fontFamily: "Consolas, monospace" }}>{endpoint}</div>
      </div>
      <button className="ghost-btn" style={{ height: 30 }}>{status === "connected" ? "Disconnect" : "Connect"}</button>
      <button className="ghost-btn" style={{ height: 30 }}>⚙</button>
    </div>
  );
}

function ConnectionsTab() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 16, gap: 12, overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ fontSize: 13, color: "#dadcdf", flex: 1 }}>
          Active MCP server connections. Click an entry to inspect its handshake / capabilities.
        </div>
        <button className="ghost-btn" style={{ height: 32 }}>+ New Connection</button>
        <button className="ghost-btn" style={{ height: 32 }}>🔄 Refresh</button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <ConnectionRow name="github-mcp"   endpoint="stdio · npx @modelcontextprotocol/server-github"   status="connected" />
        <ConnectionRow name="filesystem"   endpoint="stdio · npx @modelcontextprotocol/server-filesystem ./" status="connected" />
        <ConnectionRow name="postgres-dev" endpoint="http://localhost:8765/mcp"                          status="disconnected" />
        <ConnectionRow name="puppeteer"    endpoint="stdio · npx @modelcontextprotocol/server-puppeteer" status="error" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------
function ToolRow({ name, server, description }: {
  name: string; server: string; description: string;
}) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.03)",
      borderRadius: 8, padding: "10px 16px",
      display: "flex", alignItems: "center", gap: 14,
    }}>
      <div style={{ fontSize: 20, opacity: 0.7 }}>🧩</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: "#fff", fontFamily: "Consolas, monospace", fontSize: 12 }}>
          <span style={{ color: "#7fdfff" }}>{server}.</span>{name}
        </div>
        <div style={{ color: "#9aa0a6", fontSize: 11, marginTop: 2 }}>{description}</div>
      </div>
    </div>
  );
}

function ToolsTab() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 16, gap: 10, overflow: "auto" }}>
      <div style={{ fontSize: 13, color: "#dadcdf" }}>
        15 tools exposed by 2 connected MCP servers. Agents can call any of these per their tool_allowlist.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <ToolRow server="github-mcp" name="list_repos"  description="List repos for the authenticated user."     />
        <ToolRow server="github-mcp" name="get_pr"      description="Fetch a PR by number with diff + comments." />
        <ToolRow server="github-mcp" name="create_pr"   description="Open a new PR against a target branch."     />
        <ToolRow server="github-mcp" name="merge_pr"    description="Squash-merge a PR (requires write scope)."  />
        <ToolRow server="filesystem" name="read_file"   description="Read a file inside the sandboxed root."     />
        <ToolRow server="filesystem" name="write_file"  description="Write/overwrite a file inside the root."    />
        <ToolRow server="filesystem" name="list_dir"    description="List entries in a directory."               />
        <ToolRow server="filesystem" name="search"      description="Recursive glob/regex search over the root." />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
const TABS: { key: SubTab; label: string }[] = [
  { key: "catalog",     label: "📦 Catalog" },
  { key: "connections", label: "🔌 Connections" },
  { key: "tools",       label: "🧩 Tools" },
];

export default function MCPPage() {
  const [tab, setTab] = useState<SubTab>("catalog");
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{
        display: "flex",
        gap: 4,
        padding: "8px 16px 0",
        borderBottom: "1px solid rgba(127,223,255,0.10)",
      }}>
        {TABS.map(t => {
          const active = t.key === tab;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: "10px 20px",
                background: active ? "rgba(102,126,234,0.80)" : "rgba(30,30,40,0.80)",
                color: "#fff",
                border: "none",
                borderTopLeftRadius: 6,
                borderTopRightRadius: 6,
                fontSize: 13, fontWeight: 600,
                cursor: "pointer",
                minHeight: 32,
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

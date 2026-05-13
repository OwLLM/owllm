// AppShell — the persistent chrome wrapping every page: HybridFrame
// (corners + badge), the top ModeBar, and the SubTabs nav. Owns
// active-tab state; renders the matching page in the body.
//
// Pages are intentionally framework-light: each one is just a React
// component that returns the body content (LocationRow + workspace
// for Agents, the server controls for Server, etc.). The frame +
// header + tabs come from here.
import React, { useState } from "react";
import AgentsPage from "./pages/AgentsPage";
import AccountsPage from "./pages/AccountsPage";
import BridgesPage from "./pages/BridgesPage";
import CodePage from "./pages/CodePage";
import HomePage from "./pages/HomePage";
import MCPPage from "./pages/MCPPage";
import ServerPage from "./pages/ServerPage";
import StubPage from "./pages/StubPage";
import StudioPage from "./pages/StudioPage";

const INNER_W = 1600, INNER_H = 960;

// Tab order + display labels mirror the PySide6 nav: 🏠 Home,
// 🖥 Server, 🔌 Bridges, 🎭 Agents, 🛠 Studio, 💻 Code, 🔐 Accounts,
// 🔧 MCP. The key is what we route on internally; the label is what
// renders in SubTabs.
type TabKey =
  | "home" | "server" | "bridges" | "agents"
  | "studio" | "code" | "accounts" | "mcp";

const TABS: { key: TabKey; label: string }[] = [
  { key: "home",     label: "🏠 Home" },
  { key: "server",   label: "🖥 Server" },
  { key: "bridges",  label: "🔌 Bridges" },
  { key: "agents",   label: "🎭 Agents" },
  { key: "studio",   label: "🛠 Studio" },
  { key: "code",     label: "💻 Code" },
  { key: "accounts", label: "🔐 Accounts" },
  { key: "mcp",      label: "🔧 MCP" },
];

const ICONS = "/Page_icons";
const CORNERS = `${ICONS}/CornersNew`;

function HybridFrame({ children, width, height }: {
  children: React.ReactNode; width: number; height: number;
}) {
  const CORNER = 96, BORDER = 18, BADGE_H = 58;
  const FRAME_LEFT = 19, FRAME_TOP = 116, RIGHT_OVERHANG = 79, BOTTOM_OVERHANG = 19;
  const outerW = width + FRAME_LEFT + RIGHT_OVERHANG;
  const outerH = height + FRAME_TOP + BOTTOM_OVERHANG;
  const fc = "rgba(120, 220, 255, 0.86)";
  const ac = "rgba(120, 220, 255, 0.78)";
  return (
    <div style={{ position:"relative", width:outerW, height:outerH, background:"transparent" }}>
      <div style={{ position:"absolute", left:FRAME_LEFT, top:FRAME_TOP, width, height, background:"#14152a", overflow:"hidden" }}>
        {children}
      </div>
      <div style={{ position:"absolute", left:FRAME_LEFT+CORNER/2, width:width-CORNER, top:FRAME_TOP-BORDER/2, height:BORDER, background:`linear-gradient(90deg, ${ac}, ${fc}, ${ac})`, opacity:0.85 }} />
      <div style={{ position:"absolute", left:FRAME_LEFT+CORNER/2, width:width-CORNER, top:FRAME_TOP+height-BORDER/2, height:BORDER, background:`linear-gradient(90deg, ${ac}, ${fc}, ${ac})`, opacity:0.85 }} />
      <div style={{ position:"absolute", top:FRAME_TOP+CORNER/2, height:height-CORNER, left:FRAME_LEFT-BORDER/2, width:BORDER, background:`linear-gradient(180deg, ${ac}, ${fc}, ${ac})`, opacity:0.85 }} />
      <div style={{ position:"absolute", top:FRAME_TOP+CORNER/2, height:height-CORNER, left:FRAME_LEFT+width-BORDER/2, width:BORDER, background:`linear-gradient(180deg, ${ac}, ${fc}, ${ac})`, opacity:0.85 }} />
      <img src={`${CORNERS}/corner_ul.png`} style={{ position:"absolute", left:FRAME_LEFT-CORNER/2, top:FRAME_TOP-CORNER/2, width:CORNER, height:CORNER, pointerEvents:"none" }} />
      <img src={`${CORNERS}/corner_ur.png`} style={{ position:"absolute", left:FRAME_LEFT+width-CORNER/2, top:FRAME_TOP-CORNER/2, width:CORNER, height:CORNER, pointerEvents:"none" }} />
      <img src={`${CORNERS}/corner_bl.png`} style={{ position:"absolute", left:FRAME_LEFT-CORNER/2, top:FRAME_TOP+height-CORNER/2, width:CORNER, height:CORNER, pointerEvents:"none" }} />
      <img src={`${CORNERS}/corner_br.png`} style={{ position:"absolute", left:FRAME_LEFT+width-CORNER/2, top:FRAME_TOP+height-CORNER/2, width:CORNER, height:CORNER, pointerEvents:"none" }} />
      <img src={`${ICONS}/owl_studio_square.png`} style={{ position:"absolute", left:FRAME_LEFT+width/2-BADGE_H/2, top:FRAME_TOP-BADGE_H/2-6, width:BADGE_H, height:BADGE_H, pointerEvents:"none" }} />
    </div>
  );
}

function ModeBar() {
  const buttonStyle: React.CSSProperties = { height:50, padding:"0 14px", background:"linear-gradient(180deg, rgba(60,60,80,0.8), rgba(40,40,60,0.8))", color:"#fff", border:"1px solid rgba(120,220,255,0.0)", borderRadius:6, fontSize:13, fontWeight:700, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", lineHeight:1.05, gap:2 };
  const activeButton: React.CSSProperties = { ...buttonStyle, border:"1px solid #ffd080", background:"linear-gradient(180deg, rgba(80,70,50,0.85), rgba(60,50,30,0.85))" };
  const colorBtn = (c: string): React.CSSProperties => ({ width:18, height:18, borderRadius:3, background:c, border:"none", padding:0 });
  return (
    <div data-ui="AppHeader" style={{ height:80, display:"grid", gridTemplateColumns:"auto 1fr auto", alignItems:"center", padding:"10px 50px 10px 20px", gap:16, background:"#1c2244" }}>
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <div data-ui="DarkModeBtn" style={{ width:70, height:50, borderRadius:6, background:"linear-gradient(180deg, rgba(60,60,80,0.8), rgba(40,40,60,0.8))", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", lineHeight:1.0 }}>
          <div style={{ fontSize:22 }}>🌙</div>
          <div style={{ fontSize:11, fontWeight:700, color:"#fff" }}>Dark</div>
        </div>
        <div data-ui="ColorSelector" style={{ width:70, height:50, padding:4, display:"grid", gridTemplateColumns:"repeat(3, 18px)", gridTemplateRows:"repeat(2, 18px)", gap:3, background:"rgba(60,60,80,0.4)", borderRadius:6 }}>
          {["#667eea","#fbbf24","#ef4444","#3b82f6","#10b981","#6b7280"].map(c => <button key={c} style={colorBtn(c)} />)}
        </div>
        <button data-ui="AdvancedToggle" style={{...buttonStyle, width:114}}><span style={{fontSize:18}}>⚙</span><span>Advanced</span></button>
        <button data-ui="FineTuningToggle" style={{...buttonStyle, width:129}}><span style={{fontSize:18}}>🛠</span><span>Fine Tuning</span></button>
        <button data-ui="AgenticTeamToggle" style={{...activeButton, width:147}}><span style={{fontSize:18}}>🎭</span><span>Agentic Team</span></button>
        <button data-ui="GamifyToggle" style={{...buttonStyle, width:91}}><span style={{fontSize:18}}>🎮</span><span>Gamify</span></button>
      </div>
      <div style={{ display:"flex", justifyContent:"center" }}>
        <div data-ui="AppTitle" style={{ textAlign:"center", width:128, height:45, fontSize:34, fontWeight:700, color:"#fff", letterSpacing:2, lineHeight:"45px" }}>OWLLM</div>
      </div>
      <div data-ui="SysInfoBlock" style={{ minWidth:543, width:543, height:60, display:"flex", flexDirection:"column", alignItems:"stretch", justifyContent:"center", gap:3, fontSize:12, fontWeight:700, color:"#fff", textAlign:"right" }}>
        <div data-ui="HeaderServersLabel"><span className="status-dot" style={{ background:"#22c55e", color:"#22c55e" }} />Servers: 1 [Quagenmed-K4] Abbreviated Q4_K_M GGUF…</div>
        <div data-ui="HeaderApiKeyLabel"><span className="status-dot" style={{ background:"#22c55e", color:"#22c55e" }} />API key: owllm-local</div>
        <div data-ui="HeaderVramLabel"><span className="status-dot" style={{ background:"#fbbf24", color:"#fbbf24" }} />VRAM: N/N</div>
      </div>
    </div>
  );
}

function SubTabs({ activeTab, onChange }: {
  activeTab: TabKey; onChange: (k: TabKey) => void;
}) {
  return (
    <div style={{ height:76, background:"#1a1f2c", display:"flex", alignItems:"center", padding:"0 24px", gap:6, fontSize:13, color:"#dadcdf" }}>
      {TABS.map(t => {
        const active = t.key === activeTab;
        return (
          <div
            key={t.key}
            onClick={() => onChange(t.key)}
            style={{
              padding:"10px 16px",
              background:active?"rgba(120,220,255,0.20)":"transparent",
              color:active?"#7fdfff":"#9aa0a6",
              borderRadius:8,
              fontWeight:600,
              borderBottom:active?"2px solid #7fdfff":"2px solid transparent",
              cursor:"pointer",
              userSelect:"none",
            }}
          >
            {t.label}
          </div>
        );
      })}
      <div style={{ flex:1 }} />
      <div style={{ color:"#888", fontSize:11 }}>Product Studio Test ▾</div>
      <button className="ghost-btn">Team</button>
      <button className="ghost-btn">+ New</button>
      <button className="ghost-btn">Rename</button>
      <button className="ghost-btn">Delete</button>
    </div>
  );
}

export default function AppShell() {
  const [tab, setTab] = useState<TabKey>("agents");
  let body: React.ReactNode;
  switch (tab) {
    case "agents":   body = <AgentsPage />; break;
    case "server":   body = <ServerPage />; break;
    case "home":     body = <HomePage />; break;
    case "bridges":  body = <BridgesPage />; break;
    case "studio":   body = <StudioPage />; break;
    case "code":     body = <CodePage />; break;
    case "accounts": body = <AccountsPage />; break;
    case "mcp":      body = <MCPPage />; break;
  }
  return (
    <HybridFrame width={INNER_W} height={INNER_H}>
      <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
        <ModeBar />
        <SubTabs activeTab={tab} onChange={setTab} />
        <div style={{ flex:1, overflow:"auto" }}>
          {body}
        </div>
      </div>
    </HybridFrame>
  );
}

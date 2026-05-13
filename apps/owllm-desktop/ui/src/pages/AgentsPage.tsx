// AgentsPage — ported from the legacy desktop_app/web_replica HTML preview
// into the real Tauri React tree. TwinForge's code-aware Coder iterates
// THIS file going forward; the HTML preview is being retired.
//
// Asset URLs are root-relative ("/Page_icons/owl_agentic.png") and resolve
// via Vite's publicDir, which points at the repo's icons/ directory.
import React from "react";

const ICONS = "/Page_icons";
const CORNERS = `${ICONS}/CornersNew`;

type HybridFrameProps = {
  children: React.ReactNode;
  width: number;
  height: number;
};

function HybridFrame({ children, width, height }: HybridFrameProps) {
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
  const activeButton: React.CSSProperties = { ...buttonStyle, border:"1px solid #d4af37", background:"linear-gradient(180deg, rgba(80,80,110,0.9), rgba(50,50,80,0.9))" };
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
      <div data-ui="SysInfoBlock" style={{ minWidth:567, width:567, height:60, display:"flex", flexDirection:"column", alignItems:"stretch", justifyContent:"center", gap:3, fontSize:13, fontWeight:700, color:"#fff", textAlign:"right" }}>
        <div data-ui="HeaderServersLabel"><span className="status-dot" style={{ background:"#22c55e", color:"#22c55e" }} />Servers: 0</div>
        <div data-ui="HeaderApiKeyLabel"><span className="status-dot" style={{ background:"#22c55e", color:"#22c55e" }} />API key: owllm-local</div>
        <div data-ui="HeaderVramLabel"><span className="status-dot" style={{ background:"#fbbf24", color:"#fbbf24" }} />VRAM: N/N</div>
      </div>
    </div>
  );
}

function SubTabs() {
  const tabs = ["🏠 Home","🖥 Server","🔌 Bridges","🎭 Agents","🛠 Studio","💻 Code","🔐 Accounts","🔧 MCP"];
  return (
    <div style={{ height:76, background:"#1a1f2c", display:"flex", alignItems:"center", padding:"0 24px", gap:6, fontSize:13, color:"#dadcdf" }}>
      {tabs.map(t => {
        const active = t.includes("Agents");
        return (
          <div key={t} style={{ padding:"10px 16px", background:active?"rgba(120,220,255,0.20)":"transparent", color:active?"#7fdfff":"#9aa0a6", borderRadius:8, fontWeight:600, borderBottom:active?"2px solid #7fdfff":"2px solid transparent" }}>{t}</div>
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

function LocationRow() {
  return (
    <div style={{ height:52, padding:"10px 23px", background:"linear-gradient(180deg, #1f2632, #181c29)", borderRadius:10, margin:"0 23px", display:"flex", alignItems:"center", gap:10 }}>
      <div data-ui="LocationLabel" style={{ display:"inline-flex", alignItems:"center", height:32, width:58, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:0.6, marginRight:4 }}>LOCATION</div>
      <input data-ui="LocationInput" defaultValue="/path/to/repo · esp-flash · github.com/me/x" style={{ width:346, height:32, borderRadius:8, padding:"0 12px", fontSize:13, background:"#0f0f19", color:"#dadcdf", border:"1px solid rgba(255,255,255,0.06)" }} />
      <button data-ui="LocationBrowseBtn" className="ghost-btn" style={{ width:79 }}>Browse…</button>
      <label data-ui="TrustWritesCheckbox" style={{ display:"inline-flex", alignItems:"center", width:94, height:16, lineHeight:"16px", fontSize:12, color:"#dadcdf", padding:0 }}>
        <input type="checkbox" defaultChecked style={{ marginRight:6, width:13, height:13, accentColor:"#7fdfff" }} />
        Trust writes
      </label>
      <span data-ui="SandboxBadge" style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", height:32, width:86, padding:"0 10px", background:"rgba(60,200,120,0.18)", color:"#69e6a1", borderRadius:8, fontSize:11, textTransform:"uppercase", fontWeight:700, letterSpacing:0.6 }}>SANDBOX</span>
      <span data-ui="BridgeBadge" style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", height:32, width:91, padding:"0 10px", background:"rgba(140,140,160,0.18)", color:"#aab", borderRadius:8, fontSize:11, textTransform:"uppercase", fontWeight:700, letterSpacing:0.6 }}>Bridge: OFF</span>
      <span style={{ display:"inline-flex", alignItems:"center", height:32, padding:"0 12px", fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:0.6 }}>Project</span>
      <select data-ui="ProjectCombo" defaultValue="psm" style={{ width:346, height:32, padding:"0 12px", borderRadius:8, border:"none", background:"#0f0f19", color:"#fff", fontSize:13 }}>
        <option value="psm">Product Studio Test</option>
      </select>
      <span style={{ padding:"4px 10px", background:"rgba(255,160,80,0.18)", color:"#ffb87a", borderRadius:8, fontSize:11, textTransform:"uppercase" }}>MP no-key</span>
    </div>
  );
}

function GoalRow() {
  return (
    <div style={{ height:38, padding:"0 23px", margin:"12px 0", background:"transparent", display:"flex", alignItems:"center", gap:10 }}>
      <button data-ui="GoalAttachBtn" className="ghost-btn" style={{ height:38, width:51, padding:0, fontSize:16 }}>📎</button>
      <input data-ui="GoalInput" defaultValue="summarize the last commit and propose a follow-up. design image + build notes" style={{ flex:1, height:38, borderRadius:10, padding:"0 14px", fontSize:13, background:"#161623", color:"#fff", border:"none" }} />
      <button data-ui="GoalRunBtn" style={{ height:38, width:82, padding:0, borderRadius:10, border:"none", background:"#4a6cff", color:"#fff", fontWeight:700, fontSize:18 }}>Run</button>
      <button data-ui="GoalCancelBtn" style={{ height:38, width:98, padding:0, borderRadius:10, border:"1px solid rgba(255,140,140,0.30)", background:"rgba(255,140,140,0.08)", color:"#ff8c8c", fontSize:18 }}>Cancel</button>
      <button data-ui="GoalTelemetryBtn" className="ghost-btn" style={{ height:38, width:44, padding:0, fontSize:16 }}>📊</button>
      <button data-ui="GoalVoiceBtn" className="ghost-btn" style={{ height:38, width:64, padding:0, fontSize:16, fontWeight:"normal" }}>🔈</button>
    </div>
  );
}

function FlowHeader() {
  return (
    <div style={{ display:"flex", alignItems:"center", padding:"6px 10px", gap:6, borderBottom:"1px solid rgba(255,255,255,0.04)" }}>
      <div data-ui="FlowTitle" style={{ fontSize:20, fontWeight:700, color:"#fff", width:48, height:28, display:"flex", alignItems:"center", fontFamily:"Segoe UI" }}>Flow</div>
      <div style={{ flex:1 }} />
      <button data-ui="FlowDeleteEdgeBtn" className="ghost-btn" style={{ height:28, width:59, padding:"0 8px", fontSize:11 }}>✕ Edge</button>
      <button data-ui="FlowReverseEdgeBtn" className="ghost-btn" style={{ height:28, width:72, padding:"0 8px", fontSize:11 }}>⇄ Reverse</button>
      <button data-ui="FlowLayoutBtn" className="ghost-btn" style={{ height:28, width:68, padding:"0 8px", fontSize:11 }}>⟲ Layout</button>
      <button data-ui="FlowRefreshBtn" className="ghost-btn" style={{ height:28, width:30, padding:0, fontSize:11 }}>⟳</button>
      <button data-ui="FlowViewToggleBtn" className="ghost-btn" style={{ height:28, width:90, padding:"0 8px", fontSize:11 }}>◐ Graph view</button>
    </div>
  );
}

function DesignStudioCard() {
  return (
    <div style={{ margin:"8px 10px", padding:12, borderRadius:12, background:"linear-gradient(180deg, #1d2336, #131726)", border:"1px solid rgba(120,220,255,0.18)" }}>
      <div data-ui="StudioFxThumbnail" style={{ position:"relative", width:"100%", height:88, borderRadius:10, marginBottom:10, background:"linear-gradient(135deg, #2a3458 0%, #4a3868 50%, #1a2240 100%)", border:"1px solid rgba(120,220,255,0.25)", overflow:"hidden", display:"flex", alignItems:"center", justifyContent:"center" }}>
        <img src={`${ICONS}/owl_studio_square.png`} style={{ width:48, height:48, opacity:0.95, filter:"drop-shadow(0 2px 6px rgba(0,0,0,0.5))" }} />
        <div style={{ position:"absolute", left:8, bottom:6, fontSize:10, fontWeight:700, color:"#7fdfff", textTransform:"uppercase", letterSpacing:0.8 }}>uBoit Studio fx</div>
        <div style={{ position:"absolute", right:8, top:6, padding:"2px 6px", borderRadius:4, background:"rgba(120,220,255,0.25)", color:"#fff", fontSize:9, fontWeight:700 }}>TILE</div>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:6 }}>
        <img src={`${ICONS}/owl_studio_square.png`} style={{ width:28, height:28 }} />
        <div style={{ fontSize:11, color:"#aaa", textTransform:"uppercase" }}>Design Studio Team</div>
      </div>
      <div style={{ fontSize:11, color:"#9aa0a6", lineHeight:1.4 }}>Stage 1 / 3 — sketch the brief, iterate interview and design board, then ship.</div>
      <div style={{ fontSize:12, fontWeight:700, color:"#fff", marginTop:6 }}>sBach Studio Tr</div>
      <div style={{ marginTop:6, display:"flex", gap:12, fontSize:10, color:"#7888a8", textTransform:"uppercase" }}>
        <div>I<br /><span style={{ color:"#fff", fontSize:18 }}>16</span></div>
        <div>—<br /><span style={{ color:"#fff", fontSize:18 }}>—</span></div>
      </div>
    </div>
  );
}

function SuperUserCard() {
  return (
    <div data-ui="SuperUserCard" style={{ margin:"8px 10px", padding:"10px 12px", borderRadius:12, background:"#181c29", border:"1px solid rgba(120,220,255,0.10)", width:320, height:280, display:"flex", flexDirection:"column", gap:8 }}>
      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
        <div data-ui="suAvatar" style={{ width:28, height:28, borderRadius:14, background:"linear-gradient(135deg, #4a6cff, #7fdfff)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, color:"#fff", fontWeight:700 }}>👤</div>
        <div style={{ flex:1 }}>
          <div data-ui="suName" style={{ fontSize:18, fontWeight:700, color:"#fff", height:26, lineHeight:"26px" }}>Super User</div>
          <div data-ui="suHint" style={{ fontSize:11, color:"#7888a8", height:74, lineHeight:1.4 }}>Team: PuShed Team — idle the agent team auger in Bach. Agents team page +1 detailed.</div>
        </div>
        <button data-ui="suIconBtn" className="ghost-btn" style={{ width:30, height:26, padding:0, fontSize:12 }}>⇱⇲</button>
        <button data-ui="suIconBtn" className="ghost-btn" style={{ width:26, height:26, padding:0, fontSize:14 }}>⚙</button>
      </div>
      <div style={{ flex:1, minHeight:60, background:"rgba(0,0,0,0.28)", borderRadius:8, padding:"8px 10px", fontSize:11, color:"#9aa0a6", lineHeight:1.5 }}>
        <span style={{ color:"#7fdfff", fontWeight:700 }}>You:</span> sBach Studio Tr — agent team auger in Bach is here +1 detailed lan ok desktop_app pages dev mu1
      </div>
      <div data-ui="suInputRow" style={{ display:"flex", alignItems:"center", gap:6 }}>
        <input placeholder="Reply to the team…" style={{ flex:1, height:28, borderRadius:6, padding:"0 10px", background:"#0f1218", color:"#fff", fontSize:11, border:"1px solid rgba(120,220,255,0.15)" }} />
        <button data-ui="suSendBtn" style={{ height:28, padding:"0 12px", borderRadius:6, border:"none", background:"linear-gradient(180deg, #5e82ff, #3a55cc)", color:"#fff", fontSize:11, fontWeight:700 }}>Send</button>
      </div>
      <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:11, color:"#dadcdf" }}>
        <input type="checkbox" />
        <span>auto-approve tool requests</span>
      </label>
    </div>
  );
}

type CanvasProps = { width: number; height: number };

function TeamCanvas({ width, height }: CanvasProps) {
  const w = width, h = height;
  const card_reserve = Math.min(410, w * 0.35);
  const cx = card_reserve + (w - card_reserve) / 2;
  const cy = h / 2;
  const max_radius = Math.max(120, Math.min(w, h * 1.5) * 0.30);
  const inner_offset = 130;
  const max_depth = 1;
  const step = (max_radius - inner_offset) / Math.max(1, max_depth);
  const ring_radius = inner_offset + step;
  const N = 8;
  const arc_span = (Math.PI * 2) * (340 / 360);
  const start_angle = -Math.PI / 2 - arc_span / 2;
  const nodes: { x: number; y: number; label: string; active: boolean }[] = [];
  const labels = ["Workshop Writer","Onboarded Coder","Backend Server","UI Designer","Backend Hub","Design Critic","Frontend Coder","Workshop Owl"];
  for (let i = 0; i < N; i++) {
    const a = start_angle + (i + 0.5) * arc_span / N;
    nodes.push({ x: cx + ring_radius * Math.cos(a), y: cy + ring_radius * Math.sin(a), label: labels[i], active: (i === 0 || i === 3) });
  }
  const orchestrator_r = 32;
  return (
    <div data-ui="AgentTeamCanvas" style={{ position:"relative", width:w, height:h, background:`radial-gradient(ellipse at ${cx}px ${cy}px, rgba(60, 120, 200, 0.22) 0%, rgba(0, 0, 0, 0) 60%), linear-gradient(180deg, #101522 0%, #06080d 100%)`, overflow:"hidden" }}>
      <svg width={w} height={h} style={{ position:"absolute", left:0, top:0 }}>
        <defs>
          <radialGradient id="halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(120,220,255,0.85)" />
            <stop offset="45%" stopColor="rgba(120,220,255,0.35)" />
            <stop offset="100%" stopColor="rgba(120,220,255,0)" />
          </radialGradient>
          <radialGradient id="haloActive" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(127,223,255,1)" />
            <stop offset="40%" stopColor="rgba(127,223,255,0.55)" />
            <stop offset="100%" stopColor="rgba(127,223,255,0)" />
          </radialGradient>
          <radialGradient id="orchHalo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(255,200,100,0.85)" />
            <stop offset="45%" stopColor="rgba(255,180,80,0.40)" />
            <stop offset="100%" stopColor="rgba(255,180,80,0)" />
          </radialGradient>
        </defs>
        <circle cx={cx} cy={cy} r={ring_radius} fill="none" stroke="rgba(120,220,255,0.25)" strokeWidth="1.6" strokeDasharray="4 4" />
        {nodes.map((n,i) => (
          <line key={"sp"+i} x1={cx} y1={cy} x2={n.x} y2={n.y} stroke={n.active?"rgba(120,220,255,0.55)":"rgba(120,220,255,0.12)"} strokeWidth={n.active?1.6:1.2} />
        ))}
        {nodes.map((n,i) => (
          <circle key={"h"+i} cx={n.x} cy={n.y} r={n.active?52:38} fill={n.active?"url(#haloActive)":"url(#halo)"} />
        ))}
        {nodes.map((n,i) => (
          <circle key={"d"+i} cx={n.x} cy={n.y} r={22} fill="#3b4a7a" stroke={n.active?"#7fdfff":"rgba(120,220,255,0.6)"} strokeWidth={n.active?2.4:1.6} />
        ))}
        {nodes.filter(n=>n.active).map((n,i) => (
          <circle key={"r"+i} cx={n.x} cy={n.y} r={28} fill="none" stroke="rgba(127,223,255,0.7)" strokeWidth="1.4" />
        ))}
        <circle cx={cx} cy={cy} r={orchestrator_r * 3.0} fill="url(#orchHalo)" />
        <circle cx={cx} cy={cy} r={orchestrator_r * 1.5} fill="#1a2240" stroke="rgba(255,200,100,0.75)" strokeWidth="2.5" />
        <circle cx={cx} cy={cy} r={orchestrator_r * 1.5} fill="none" stroke="rgba(127,223,255,0.45)" strokeWidth="1.2" strokeDasharray="3 3" />
      </svg>
      <img src={`${ICONS}/owl_agentic.png`} style={{ position:"absolute", left:cx - orchestrator_r * 1.25, top:cy - orchestrator_r * 1.25, width:orchestrator_r * 2.5, height:orchestrator_r * 2.5, pointerEvents:"none", filter:"drop-shadow(0 0 12px rgba(255,200,100,0.55))" }} />
      <div style={{ position:"absolute", left:cx-60, top:cy + orchestrator_r * 1.6, width:120, textAlign:"center", fontSize:11, fontWeight:700, color:"#ffd97a", textTransform:"uppercase", letterSpacing:0.8, textShadow:"0 1px 3px rgba(0,0,0,0.9)", pointerEvents:"none" }}>Orchestrator</div>
      {nodes.map((n,i) => (
        <div key={"l"+i} style={{ position:"absolute", left:n.x - 60, top:n.y + 30, width:120, textAlign:"center", fontSize:12, fontWeight:600, color:n.active?"#ffffff":"#e6e8eb", textTransform:"uppercase", letterSpacing:0.4, pointerEvents:"none", textShadow:"0 1px 3px rgba(0,0,0,0.9)" }}>{n.label}</div>
      ))}
    </div>
  );
}

function OrchestratorPane() {
  const code = `* peripheral is active.
"TEXT" — selected agent "Sg" agent name header.
def __name__ == "TEAM": team is given a default
config; each task starts with stalecaching agents
that aren't named so OK to make a default
"" stage.
"TEAM" — selected agent "Sg" agent name header.
"selected_path" — list left in place hue
rendered well until 2025 mirrors pending agent
to renew current 25.0 + every "ms" — pretty
much "wow" then 7.

if we
to make the goal in running, all only is
oriented should think the "I shall not
fail-call.thought_method". because given by the
last action from m,h is left protected.`;
  const messages = [
    { role:"orchestrator", color:"#ffd97a", text:"Routing task to UI Designer — stage 1 sketch." },
    { role:"UI Designer",   color:"#7fdfff", text:"Drafted the brief outline; uploading mock." },
    { role:"Workshop Writer", color:"#dcb0ff", text:"Will pair narrative with the mock once received." },
  ];
  return (
    <div data-ui="RosterRight" style={{ display:"flex", flexDirection:"column", height:"100%", background:"#0c0f1a" }}>
      <div data-ui="LogHeader" style={{ height:26, padding:"0 12px", background:"linear-gradient(90deg, rgba(120,220,255,0.22) 0%, rgba(220,180,255,0.16) 60%, rgba(255,200,100,0.14) 100%)", borderBottom:"1px solid rgba(120,220,255,0.35)", display:"flex", alignItems:"center", gap:8 }}>
        <button style={{ padding:"6px 14px", borderRadius:18, border:"1px solid rgba(127,223,255,0.55)", background:"rgba(127,223,255,0.30)", color:"#ffffff", fontSize:12, fontWeight:700, display:"inline-flex", alignItems:"center", gap:4 }}>💬 Reply</button>
        <button style={{ padding:"6px 14px", borderRadius:18, border:"1px solid rgba(220,180,255,0.40)", background:"rgba(220,180,255,0.18)", color:"#dcb0ff", fontSize:12, fontWeight:700, display:"inline-flex", alignItems:"center", gap:4 }}>🧠 Thought</button>
        <div style={{ flex:1, fontSize:11, color:"#9aa0a6", paddingLeft:8 }}>Click an agent on the canvas to view its log.</div>
        <button className="ghost-btn" style={{ height:28, padding:"0 10px", fontSize:11 }}>🎯 Route</button>
        <button className="ghost-btn" style={{ height:28, padding:"0 10px", fontSize:11 }}>⤴ Send</button>
      </div>
      <div data-ui="OrchestratorLogTabs" style={{ flex:1, padding:"10px 10px", display:"flex", flexDirection:"column", gap:8, overflow:"hidden" }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display:"flex", alignItems:"flex-start", gap:8 }}>
            <div style={{ width:28, height:28, flexShrink:0, borderRadius:14, background:m.color, opacity:0.85, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, color:"#06080d" }}>{m.role[0]}</div>
            <div style={{ flex:1, background:"rgba(255,255,255,0.04)", borderLeft:`3px solid ${m.color}`, borderRadius:8, padding:"6px 10px" }}>
              <div style={{ fontSize:10, fontWeight:700, color:m.color, textTransform:"uppercase", letterSpacing:0.5, marginBottom:2 }}>{m.role}</div>
              <div style={{ fontSize:12, color:"#dadcdf", lineHeight:1.4 }}>{m.text}</div>
            </div>
          </div>
        ))}
        <div data-ui="OrchestratorReplyView" style={{ flex:1, background:"#0f1218", borderRadius:8, padding:10, overflow:"hidden", fontFamily:"Consolas, 'Cascadia Mono', monospace", fontSize:12, lineHeight:1.5, color:"#cbd2e0", whiteSpace:"pre-wrap", border:"1px solid rgba(120,220,255,0.08)" }}>{code}</div>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const INNER_W = 1600, INNER_H = 960;
  const LEFT_W = 1014, RIGHT_W = 532, SPLITTER_W = 8;
  return (
    <HybridFrame width={INNER_W} height={INNER_H}>
      <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
        <ModeBar />
        <SubTabs />
        <LocationRow />
        <GoalRow />
        <div data-ui="WorkspaceStack" style={{ height:665, width:1554, margin:"0 23px", display:"flex", overflow:"hidden", background:"#06080d", padding:0 }}>
          <div data-ui="RosterLeft" style={{ width:LEFT_W, display:"flex", flexDirection:"column", background:"#0a0d14" }}>
            <FlowHeader />
            <div data-ui="CanvasStack" style={{ height:607, position:"relative" }}>
              <TeamCanvas width={LEFT_W} height={607} />
              <div style={{ position:"absolute", top:8, left:8, width:360 }}>
                <DesignStudioCard />
                <SuperUserCard />
              </div>
            </div>
          </div>
          <div data-ui="RosterSplitter" style={{ width:SPLITTER_W, background:"#1a1f2c" }} />
          <div style={{ width:RIGHT_W }}>
            <OrchestratorPane />
          </div>
        </div>
      </div>
    </HybridFrame>
  );
}

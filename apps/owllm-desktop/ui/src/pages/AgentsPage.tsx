// AgentsPage — page content only. Frame + header + tabs come from
// AppShell. This component is just the agents-tab body: location row,
// goal row, then the workspace (canvas + cards + orchestrator pane).
//
// Asset URLs are root-relative ("/Page_icons/owl_agentic.png") and
// resolve via the dev-only middleware in vite.config.ts.
import React from "react";

const ICONS = "/Page_icons";

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
      <button data-ui="GoalTestCodeBtn" className="ghost-btn" style={{ height:38, width:84, padding:0, fontSize:12 }}>Test code</button>
      <button data-ui="GoalConvertBtn" className="ghost-btn" style={{ height:38, width:78, padding:0, fontSize:12 }}>Convert</button>
      <select data-ui="GoalModelCombo" defaultValue="m1" style={{ height:38, width:130, padding:"0 10px", borderRadius:10, border:"none", background:"#161623", color:"#fff", fontSize:12 }}>
        <option value="m1">Qwen2.5-Coder Q4</option>
      </select>
      <button data-ui="GoalRunBtn" style={{ height:38, width:82, padding:0, borderRadius:10, border:"none", background:"#22c55e", color:"#fff", fontWeight:700, fontSize:18 }}>Run</button>
      <button data-ui="GoalCancelBtn" style={{ height:38, width:98, padding:0, borderRadius:10, border:"1px solid rgba(255,80,80,0.55)", background:"#ef4444", color:"#fff", fontWeight:700, fontSize:18 }}>Cancel</button>
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
      <div style={{ marginTop:6, display:"flex", gap:12, alignItems:"flex-end", fontSize:10, color:"#7888a8", textTransform:"uppercase" }}>
        <div><span style={{ color:"#fff", fontSize:18, fontWeight:700 }}>10</span></div>
        <div><span style={{ color:"#fff", fontSize:18, fontWeight:700 }}>6</span></div>
        <div style={{ marginLeft:"auto", fontSize:10, color:"#7888a8" }}>Cleared</div>
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
  // Each ring node = one agent in the active Team (mirrors the team JSON
  // schema at LLM/core/agents/teams/*.json: every agent has a name + an
  // `icon` field like "owl:owl_coder" that resolves to
  // /Page_icons/Agents/owl_coder.png; the Qt `agent_team_canvas.py`
  // paints those PNGs on top of the colored disc — we do the same here.
  type Node = { x: number; y: number; label: string; icon: string; active: boolean };
  const roster: { label: string; icon: string }[] = [
    { label: "Workshop Writer",  icon: "Agents/owl_documentation.png" },
    { label: "Onboarded Coder",  icon: "Agents/owl_coder.png" },
    { label: "Backend Server",   icon: "owl_server.png" },
    { label: "UI Designer",      icon: "Agents/owl_webapp.png" },
    { label: "Product Studio",   icon: "owl_studio_square.png" },
    { label: "Knowledge Doctor", icon: "Agents/owl_researcher.png" },
    { label: "Frontend Coder",   icon: "Agents/owl_asssitant.png" },
    { label: "Workshop Owl",     icon: "Agents/owl_critic.png" },
  ];
  const nodes: Node[] = [];
  for (let i = 0; i < N; i++) {
    const a = start_angle + (i + 0.5) * arc_span / N;
    nodes.push({
      x: cx + ring_radius * Math.cos(a),
      y: cy + ring_radius * Math.sin(a),
      label: roster[i].label,
      icon:  roster[i].icon,
      active: (i === 0 || i === 3),
    });
  }
  const NODE_R = 22; // matches `r = 22 + 4*pulse` in agent_team_canvas.py:1081
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
          {/* Spoke gradient — cyan(α=110) → blue(α=30), mirrors the
              QLinearGradient(_NEON_CYAN→_NEON_BLUE) at
              agent_team_canvas.py:853-857. */}
          {nodes.map((n,i) => (
            <linearGradient key={"spg"+i} id={`spokeGrad${i}`} gradientUnits="userSpaceOnUse" x1={cx} y1={cy} x2={n.x} y2={n.y}>
              <stop offset="0%" stopColor="rgba(92,240,255,0.43)" />
              <stop offset="100%" stopColor="rgba(116,164,255,0.12)" />
            </linearGradient>
          ))}
        </defs>
        <circle cx={cx} cy={cy} r={ring_radius} fill="none" stroke="rgba(120,220,255,0.25)" strokeWidth="1.6" strokeDasharray="4 4" />
        {nodes.map((n,i) => (
          <line key={"sp"+i} x1={cx} y1={cy} x2={n.x} y2={n.y} stroke={n.active?"rgba(120,220,255,0.55)":`url(#spokeGrad${i})`} strokeWidth={n.active?1.6:1.3} />
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
        // Owl PNG ON TOP of each agent disc — same job as the
        // `_paint_icon(p, icon_rect, agent.icon)` call at
        // agent_team_canvas.py:1134. icon_rect = (-r,-r,2r,2r), so
        // the image fills the disc.
        <img
          key={"i"+i}
          src={`${ICONS}/${n.icon}`}
          style={{
            position: "absolute",
            left: n.x - NODE_R,
            top:  n.y - NODE_R,
            width:  NODE_R * 2,
            height: NODE_R * 2,
            objectFit: "contain",
            pointerEvents: "none",
            filter: n.active
              ? "drop-shadow(0 0 6px rgba(127,223,255,0.85))"
              : "drop-shadow(0 1px 2px rgba(0,0,0,0.5))",
          }}
        />
      ))}
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
        <button style={{ padding:"6px 14px", borderRadius:18, border:"1px solid rgba(60,242,107,0.70)", background:"rgba(60,242,107,0.18)", color:"#69e6a1", fontSize:12, fontWeight:700, display:"inline-flex", alignItems:"center", gap:4 }}>💬 1 Reply</button>
        <button style={{ padding:"6px 14px", borderRadius:18, border:"1px solid rgba(60,242,107,0.70)", background:"rgba(60,242,107,0.18)", color:"#69e6a1", fontSize:12, fontWeight:700, display:"inline-flex", alignItems:"center", gap:4 }}>🧠 1 Thought</button>
        <div style={{ flex:1, fontSize:11, color:"#9aa0a6", paddingLeft:8 }}>Click an agent on the canvas to view its log.</div>
        <button className="ghost-btn" style={{ height:28, padding:"0 10px", fontSize:11 }}>🎯 Route</button>
        <button className="ghost-btn" style={{ height:28, padding:"0 10px", fontSize:11 }}>⤴ Send</button>
      </div>
      <div data-ui="OrchestratorLogTabs" style={{ flex:1, padding:"10px 10px", display:"flex", flexDirection:"column", gap:8, overflow:"hidden" }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display:"flex", alignItems:"flex-start", gap:8 }}>
            <div style={{ width:28, height:28, flexShrink:0, borderRadius:14, background:m.color, opacity:0.85, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, color:"#06080d" }}>{m.role[0]}</div>
            <div style={{ flex:1, background:"rgba(255,255,255,0.04)", borderLeft:`3px solid ${m.color}`, borderRadius:8, padding:"4px 10px" }}>
              <div style={{ fontSize:10, fontWeight:700, color:m.color, textTransform:"uppercase", letterSpacing:0.5, marginBottom:2 }}>{m.role}</div>
              <div style={{ fontSize:12, color:"#dadcdf", lineHeight:1.3 }}>{m.text}</div>
            </div>
          </div>
        ))}
        <div data-ui="OrchestratorReplyView" style={{ flex:1, background:"#0f1218", borderRadius:8, padding:10, overflow:"hidden", fontFamily:"Consolas, 'Cascadia Mono', monospace", fontSize:12, lineHeight:1.5, color:"#cbd2e0", whiteSpace:"pre-wrap", border:"1px solid rgba(120,220,255,0.08)" }}>{code}</div>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const LEFT_W = 1014, RIGHT_W = 532, SPLITTER_W = 8;
  return (
    <>
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
    </>
  );
}

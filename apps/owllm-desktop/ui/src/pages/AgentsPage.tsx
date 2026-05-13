// AgentsPage — page content only. Frame + header + tabs come from
// AppShell. This component is just the agents-tab body: location row,
// goal row, then the workspace (canvas + cards + orchestrator pane).
//
// Asset URLs are root-relative ("/Page_icons/owl_agentic.png") and
// resolve via the dev-only middleware in vite.config.ts.
import React from "react";

const ICONS = "/Page_icons";

// LocationRow — mirrors _build_project_strip in agents_page.py:2845-3029.
// The Qt frame is a QFrame#ProjectStrip with a vertical gradient
// (#1f2632 → palette(alternate-base)) and 14/10 padding. Children
// in order: Location label, location QLineEdit (stretch=2), Browse…
// button, "Trust writes" QCheckBox, Sandbox QLabel pill, Bridge QLabel
// pill, "Project" label, ProjectCombo (stretch=2), Team…, + New,
// Rename, Delete. The "MP no-key" chip on the right is NOT in Qt — it
// came from the v11 web mock — kept here with a fixme since the user
// requested it. Same for the placeholder values shown.
function LocationRow() {
  return (
    <div data-ui="ProjectStrip" style={{ height:52, padding:"10px 14px", background:"linear-gradient(180deg, #1f2632, #181c29)", borderRadius:10, margin:"0 23px", display:"flex", alignItems:"center", gap:10 }}>
      {/* Location label — agents_page.py:2865-2871: 11px #aaa uppercase 0.6 ls. */}
      <div data-ui="LocationLabel" style={{ display:"inline-flex", alignItems:"center", height:32, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:0.6, marginRight:4 }}>LOCATION</div>
      {/* Location QLineEdit — agents_page.py:2873-2888. Stretch=2. */}
      <input data-ui="LocationInput" defaultValue="/path/to/repo · esp-flash · github.com/me/x" placeholder="/path/to/repo · esp-flash · github.com/me/x" style={{ flex:2, minWidth:240, height:32, borderRadius:8, padding:"0 12px", fontSize:13, background:"#0f0f19", color:"#fff", border:"1px solid rgba(255,255,255,0.06)" }} />
      {/* Browse… — agents_page.py:2893-2898, _GHOST_BTN_STYLE, h=32. */}
      <button data-ui="LocationBrowseBtn" className="ghost-btn" style={{ height:32, width:79 }}>Browse…</button>
      {/* Trust writes — agents_page.py:2904-2915. 12px #dadcdf checkbox. */}
      <label data-ui="TrustWritesCheckbox" style={{ display:"inline-flex", alignItems:"center", fontSize:12, color:"#dadcdf", padding:"0 6px" }}>
        <input type="checkbox" defaultChecked style={{ marginRight:6, width:13, height:13, accentColor:"#7fdfff" }} />
        Trust writes
      </label>
      {/* Sandbox pill — agents_page.py:_refresh_sandbox_badge:3093-3169.
          READY state: text "🟢 Sandboxed", color #5af09c, bg #0e2418,
          border #2c5a3c. 11px font-weight:600, 2px/8px padding, 6px radius. */}
      <span data-ui="SandboxBadge" style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", height:24, padding:"2px 8px", background:"#0e2418", color:"#5af09c", border:"1px solid #2c5a3c", borderRadius:6, fontSize:11, fontWeight:600, whiteSpace:"nowrap" }}>🟢 Sandboxed</span>
      {/* Bridge pill — agents_page.py:_refresh_bridge_badge:3171-3234.
          OFF state: text "📱 Bridge: OFF", color #7d8595, bg #1a1f2a, border #2a3148. */}
      <span data-ui="BridgeBadge" style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", height:24, padding:"2px 8px", background:"#1a1f2a", color:"#7d8595", border:"1px solid #2a3148", borderRadius:6, fontSize:11, fontWeight:600, whiteSpace:"nowrap" }}>📱 Bridge: OFF</span>
      {/* Project label — agents_page.py:2976-2981, identical style to LOCATION. */}
      <span style={{ display:"inline-flex", alignItems:"center", height:32, padding:"0 12px", fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:0.6 }}>Project</span>
      {/* ProjectCombo — agents_page.py:2983-2994. minWidth=200, stretch=2. */}
      <select data-ui="ProjectCombo" defaultValue="psm" style={{ flex:2, minWidth:200, height:32, padding:"0 12px", borderRadius:8, border:"none", background:"#0f0f19", color:"#fff", fontSize:13 }}>
        <option value="psm">Product Studio Test</option>
      </select>
      {/* Project management buttons — agents_page.py:2996-3027. All _GHOST_BTN_STYLE, h=32. */}
      <button className="ghost-btn" style={{ height:32, padding:"0 12px" }}>Team…</button>
      <button className="ghost-btn" style={{ height:32, padding:"0 12px" }}>+ New</button>
      <button className="ghost-btn" style={{ height:32, padding:"0 12px" }}>Rename</button>
      {/* Delete — destructive ghost style (red tint). */}
      <button style={{ height:32, padding:"0 12px", background:"rgba(255,140,140,0.10)", color:"#ff8c8c", border:"none", borderRadius:8, fontSize:12, fontWeight:600 }}>Delete</button>
    </div>
  );
}

// GoalRow — mirrors _build_goal_row in agents_page.py:1757-1910. Layout
// order (left to right): 📎 attach, goal QLineEdit (stretch=1), Run, Cancel,
// 📊 telemetry, 🔊/🔈 voice (QToolButton with menu dropdown caret). The
// previous v11 mock had "Test code", "Convert" and a "GoalModelCombo"
// here — none of those exist in Qt and have been removed (cf.
// agents_page.py:1904-1909 — only attach/input/run/cancel/telemetry/voice).
function GoalRow() {
  return (
    <div style={{ height:38, padding:"0 23px", margin:"12px 0", background:"transparent", display:"flex", alignItems:"center", gap:10 }}>
      {/* 📎 — agents_page.py:1768-1783. minWidth=44, h=38, fs=16, 10-radius. */}
      <button data-ui="GoalAttachBtn" title="Attach an image or audio file" style={{ height:38, minWidth:44, padding:"0 10px", border:"none", borderRadius:10, background:"rgba(255,255,255,0.05)", color:"#dadcdf", fontSize:16 }}>📎</button>
      {/* Goal QLineEdit — agents_page.py:1785-1803. Placeholder per :1787-1790. */}
      <input data-ui="GoalInput" defaultValue="summarize the last commit and propose a follow-up. design image + build notes" placeholder="Goal — e.g. 'summarise the last commit and propose a follow-up' (drop an image / audio here)" style={{ flex:1, height:38, borderRadius:10, padding:"0 14px", fontSize:13, background:"#161623", color:"#fff", border:"none" }} />
      {/* Run — agents_page.py:1805-1817. #4a6cff bg, fw:600, padding:0 24px. */}
      <button data-ui="GoalRunBtn" style={{ height:38, padding:"0 24px", borderRadius:10, border:"none", background:"#4a6cff", color:"#fff", fontWeight:600, fontSize:14 }}>Run</button>
      {/* Cancel — agents_page.py:1819-1831. padding:0 18px, ff8c8c on red-tint. */}
      <button data-ui="GoalCancelBtn" disabled style={{ height:38, padding:"0 18px", borderRadius:10, border:"none", background:"rgba(255,140,140,0.10)", color:"#555", fontWeight:600, fontSize:14 }}>Cancel</button>
      {/* 📊 telemetry — agents_page.py:1838-1850. Fixed 44px, h=38, 8-radius. */}
      <button data-ui="GoalTelemetryBtn" title="Open the tool-call telemetry panel" style={{ height:38, width:44, padding:0, border:"none", borderRadius:8, background:"rgba(255,255,255,0.05)", color:"#dadcdf", fontSize:16 }}>📊</button>
      {/* 🔊 voice QToolButton with menu — agents_page.py:1863-1902. minWidth=64,
          h=38, 8-radius. Speaker emoji flips 🔊↔🔈 with the master toggle
          (_update_voice_btn_text :1972-1974). The "▾" caret marks the
          MenuButtonPopup dropdown — Qt renders an 18px menu-button on the
          right edge per the stylesheet at :1884-1894. */}
      <button data-ui="GoalVoiceBtn" title="Speak agent replies aloud — voice per agent. Click ▾ to switch engine." style={{ height:38, minWidth:64, padding:"0 6px", border:"none", borderRadius:8, background:"rgba(92,240,255,0.18)", color:"#5cf0ff", fontSize:16, display:"inline-flex", alignItems:"center", justifyContent:"center", gap:4 }}>🔊<span style={{ fontSize:11, opacity:0.7 }}>▾</span></button>
    </div>
  );
}

// FlowHeader — mirrors the canvas_header in agents_page.py:2540-2596.
// "Flow" QLabel is QFont(pointSize=12, bold=True) — ~16px in CSS at the
// default Qt 96-DPI / 9pt-per-point ratio. Buttons are h=28 ghost-style
// per _GHOST_BTN_STYLE_SMALL. Tooltips quoted from the Qt source.
function FlowHeader() {
  return (
    <div style={{ display:"flex", alignItems:"center", padding:"6px 10px", gap:6, borderBottom:"1px solid rgba(255,255,255,0.04)" }}>
      <div data-ui="FlowTitle" style={{ fontSize:16, fontWeight:700, color:"#fff", height:28, display:"flex", alignItems:"center", fontFamily:"Segoe UI", paddingRight:8 }}>Flow</div>
      <div style={{ flex:1 }} />
      <button data-ui="FlowDeleteEdgeBtn" className="ghost-btn" title="Delete the selected edge (or press Delete)" style={{ height:28, padding:"0 8px", fontSize:11 }}>✕ Edge</button>
      <button data-ui="FlowReverseEdgeBtn" className="ghost-btn" title="Reverse the direction of the selected edge" style={{ height:28, padding:"0 8px", fontSize:11 }}>⇄ Reverse</button>
      <button data-ui="FlowLayoutBtn" className="ghost-btn" title="Top-down hierarchical layout — orchestrator on top, then specialists in rows by dispatch distance" style={{ height:28, padding:"0 8px", fontSize:11 }}>⟲ Layout</button>
      <button data-ui="FlowRefreshBtn" className="ghost-btn" title="Refresh model lists in every picker" style={{ height:28, width:30, padding:0, fontSize:11 }}>⟳</button>
      <button data-ui="FlowViewToggleBtn" className="ghost-btn" title="Switch between the live diagram and the editable graph" style={{ height:28, padding:"0 8px", fontSize:11 }}>◐ Graph view</button>
    </div>
  );
}

// TeamInfoCard — faithful port of paint_team_card in
// agent_info_card.py:394-521. Shown when no agent is selected (i.e.
// the default canvas overlay). Layout, in order:
//   * Card rect — CARD_W_MAX=320 × CARD_H_TEAM=264 (lines 92/102), 12px
//     radius. Diagonal background gradient #121622@230 → #080b12@230
//     (lines 416-418). Diagonal CYAN→VIOLET border at alpha 220 / 1.6px
//     (lines 420-423). _NEON_CYAN = "#5cf0ff", _NEON_VIOLET = "#c08aff".
//   * '● TEAM' ribbon — top of card, 22px tall, 8/8/8/8 inset, 6px
//     radius. Horizontal gradient cyan@60 → violet@10 (lines 426-432).
//     Label is 9pt bold _TEXT_BRIGHT = #e6f0ff (lines 433-442).
//   * Owl picture — 100×100 disc at (14, 38) from card origin. Cyan
//     radial halo (cyan@110 → cyan@0), then dark fill #1e2434 with
//     1.4px _TEXT_BRIGHT@200 ring (lines 444-456). Owl pixmap scaled
//     to pic_size * 0.85 (lines 458-470).
//   * Team name — centred 11pt bold under the picture (lines 478-484).
//   * Description block — 9pt _TEXT_BRIGHT word-wrapped, 96px tall,
//     to the right of the picture (info_x = pic_x + 100 + 18 = 132)
//     starting at pic_y - 4 = 34. Truncated to 240 chars (lines 486-502).
//   * AGENTS / CONNECTIONS stat row — at card bottom (above the
//     picker reserve area = 38 + CARD_PICKER_RESERVE=44). 8pt bold
//     _TEXT_DIM = #7888a8 labels, 11pt bold _TEXT_BRIGHT values.
//     Stats are offset by 90px from info_x (lines 504-520).
function TeamInfoCard() {
  // Card constants — mirror agent_info_card.py:86-102.
  const CARD_W = 320;
  const CARD_H = 264;
  const TEAM_NAME = "Design Studio Team";
  const TEAM_DESC = "Sketch the brief, iterate interview and design board, then ship — three-stage flow that pairs UI sketches with narrative notes from the workshop writer.";
  const AGENT_COUNT = 8;
  const EDGE_COUNT = 12;
  // Inner geometry — pic_x/y, info_x/y, stat_y — match paint_team_card.
  const pic_x = 14, pic_y = 38, pic_size = 100;
  const info_x = pic_x + pic_size + 18;        // 132
  const info_y = pic_y - 4;                    // 34
  const info_w = CARD_W - 14 - info_x;         // 174
  const stat_y = CARD_H - 38 - 44;             // 182 (card_h - 38 - CARD_PICKER_RESERVE)
  return (
    <div data-ui="TeamInfoCard" style={{ position:"relative", width:CARD_W, height:CARD_H, borderRadius:12, background:"linear-gradient(135deg, rgba(18,22,34,0.90) 0%, rgba(8,11,18,0.90) 100%)", boxShadow:"inset 0 0 0 1.6px transparent", border:"1.6px solid transparent", backgroundOrigin:"border-box", backgroundClip:"padding-box, border-box", overflow:"hidden" }}>
      {/* Border overlay — separate layer because gradient borders aren't
          a single-property CSS feature. Mirrors the diagonal CYAN→VIOLET
          QPen at agent_info_card.py:420-423. */}
      <div style={{ position:"absolute", inset:0, borderRadius:12, padding:"1.6px", background:"linear-gradient(135deg, rgba(92,240,255,0.86) 0%, rgba(192,138,255,0.86) 100%)", WebkitMask:"linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)", WebkitMaskComposite:"xor", maskComposite:"exclude", pointerEvents:"none" }} />
      {/* '● TEAM' ribbon — 22px tall, 8px inset from card edges. */}
      <div data-ui="TeamRibbon" style={{ position:"absolute", left:8, top:8, width:CARD_W - 16, height:22, borderRadius:6, background:"linear-gradient(90deg, rgba(92,240,255,0.235) 0%, rgba(192,138,255,0.039) 100%)", border:"1px solid rgba(92,240,255,0.47)", display:"flex", alignItems:"center", paddingLeft:10, fontSize:12, fontWeight:700, color:"#e6f0ff", fontFamily:"Segoe UI", letterSpacing:0.2 }}>● TEAM</div>
      {/* Owl picture — 100×100 disc with cyan radial halo. */}
      <div style={{ position:"absolute", left:pic_x - 6, top:pic_y - 6, width:pic_size + 12, height:pic_size + 12, borderRadius:"50%", background:"radial-gradient(circle, rgba(92,240,255,0.43) 0%, rgba(92,240,255,0) 100%)", pointerEvents:"none" }} />
      <div style={{ position:"absolute", left:pic_x, top:pic_y, width:pic_size, height:pic_size, borderRadius:"50%", background:"#1e2434", border:"1.4px solid rgba(230,240,255,0.78)", display:"flex", alignItems:"center", justifyContent:"center", overflow:"hidden" }}>
        <img src={`${ICONS}/owl_AgenticTeam.png`} style={{ width:pic_size * 0.85, height:pic_size * 0.85, objectFit:"contain" }} />
      </div>
      {/* Team name — centred 11pt bold under the picture. 11pt ≈ 15px CSS. */}
      <div style={{ position:"absolute", left:pic_x - 6, top:pic_y + pic_size + 6, width:pic_size + 12, height:20, textAlign:"center", fontSize:15, fontWeight:700, color:"#e6f0ff", fontFamily:"Segoe UI", lineHeight:"20px" }}>{TEAM_NAME}</div>
      {/* Description block — 9pt _TEXT_BRIGHT word-wrapped, capped at 240 chars. */}
      <div style={{ position:"absolute", left:info_x, top:info_y, width:info_w, height:96, fontSize:12, color:"#e6f0ff", fontFamily:"Segoe UI", lineHeight:1.35, overflow:"hidden" }}>{TEAM_DESC.length > 240 ? TEAM_DESC.slice(0, 237) + "…" : TEAM_DESC}</div>
      {/* AGENTS / CONNECTIONS stat row — 8pt bold _TEXT_DIM labels,
          11pt bold _TEXT_BRIGHT values, 90px column gap. */}
      <div style={{ position:"absolute", left:info_x, top:stat_y, width:info_w, height:14, display:"flex", alignItems:"center", fontSize:11, fontWeight:700, color:"#7888a8", fontFamily:"Segoe UI", letterSpacing:0.4 }}>
        <span style={{ width:90 }}>AGENTS</span>
        <span>CONNECTIONS</span>
      </div>
      <div style={{ position:"absolute", left:info_x, top:stat_y + 14, width:info_w, height:18, display:"flex", alignItems:"center", fontSize:15, fontWeight:700, color:"#e6f0ff", fontFamily:"Segoe UI" }}>
        <span style={{ width:90 }}>{AGENT_COUNT}</span>
        <span>{EDGE_COUNT}</span>
      </div>
    </div>
  );
}

// SuperUserCard — mirrors widgets/super_user_card.py::SuperUserCard.
// Colors / typography quoted verbatim from the _BASE_QSS stylesheet
// (super_user_card.py:37-97) and _IDLE state (:99).
//   * Frame: bg #11151e, border 1px #1d2434, radius 12 (qss :39-42).
//   * Outer margins 12,10,12,10 spacing=8 (super_user_card.py:138-139).
//   * minimumHeight 180 (:135) — overlay card; the team-avatar row +
//     reply row + auto-approve row push the actual height to ~240.
//   * Avatar QLabel#suAvatar bg #1a2030, radius 16, 18px (qss :43-48).
//   * suName #e6f0ff bold (qss :49) — Qt sets pointSize 12 (~16px CSS).
//   * suHint #6b7794 12px uppercase ls 0.4 (qss :50-51). Default text
//     comes from set_attention(False) at super_user_card.py:291.
//   * Mini chat #suChat bg #0a0d14, color #cbd2e0, border #1d2434
//     (qss :52-59). Empty-state message at super_user_card.py:417-420.
//   * Reply QLineEdit #suReply bg #0a0d14, fg #e6f0ff, border #2a3148
//     (qss :60-65). Placeholder "Reply to the team — Enter to send"
//     (super_user_card.py:248).
//   * Send button: bg #5cf0ff, fg #0a0d14, fontWeight 700 (qss :67-71).
//   * Trust checkbox #suTrust color #7888a8 (qss :87) — when checked,
//     #ff8c8c (qss :93).
//   * Header buttons #suIconBtn bg #1a2030 border #2a3148 (qss :76-82).
//   * The "team-avatar peek" row is a React-only addition (per the
//     porting task) — uses real owl PNGs from icons/Page_icons/Agents.
function SuperUserCard() {
  // Agent-team peek — Page_icons/Agents/* — picks reflect the live
  // canvas roster so the user sees "who's on this team" at a glance.
  // owl_creator.png is not in the icon set; we use owl_critic +
  // owl_asssitant (sic, the existing 3-s spelling) + owl_coder, which
  // are already wired in TeamCanvas above.
  const avatarPngs = [
    `${ICONS}/Agents/owl_critic.png`,
    `${ICONS}/Agents/owl_asssitant.png`,
    `${ICONS}/Agents/owl_coder.png`,
    `${ICONS}/Agents/owl_researcher.png`,
  ];
  return (
    <div data-ui="SuperUserCard" style={{ margin:"8px 10px", padding:"10px 12px", borderRadius:12, background:"#11151e", border:"1px solid #1d2434", width:320, minHeight:180, display:"flex", flexDirection:"column", gap:8 }}>
      {/* Header — avatar + name/hint stack + enlarge + gear. super_user_card.py:168-216. */}
      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
        <div data-ui="suAvatar" style={{ width:28, height:28, borderRadius:16, background:"#1a2030", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, color:"#e6f0ff" }}>👤</div>
        <div style={{ flex:1, minWidth:0 }}>
          <div data-ui="suName" style={{ fontSize:16, fontWeight:700, color:"#e6f0ff", lineHeight:"22px" }}>Super User</div>
          {/* Default hint — super_user_card.py:191 + :291. */}
          <div data-ui="suHint" style={{ fontSize:12, color:"#6b7794", letterSpacing:0.4, textTransform:"uppercase", lineHeight:1.4 }}>idle — team pings you here</div>
        </div>
        {/* Enlarge — super_user_card.py:200-207. ASCII "⇱⇲" because BMP
            arrows render blank on many Windows fonts. */}
        <button data-ui="suIconBtn" title="Open chat in a side panel (4:5, full window height, docked right)" style={{ width:30, height:26, padding:0, background:"#1a2030", color:"#e6f0ff", border:"1px solid #2a3148", borderRadius:6, fontSize:14, fontWeight:700 }}>⇱⇲</button>
        {/* Gear — super_user_card.py:210-215. */}
        <button data-ui="suIconBtn" title="Notification settings (Telegram, etc.)" style={{ width:26, height:26, padding:0, background:"#1a2030", color:"#e6f0ff", border:"1px solid #2a3148", borderRadius:6, fontSize:16, fontWeight:700 }}>⚙</button>
      </div>
      {/* Agent-team peek — React-only extension per porting task. Shows
          a horizontal owl strip so the user knows which agents are on
          the team without leaving the card. */}
      <div data-ui="suTeamPeek" style={{ display:"flex", alignItems:"center", gap:4, padding:"0 2px" }}>
        {avatarPngs.map((src, i) => (
          <img key={i} src={src} style={{ width:20, height:20, opacity:0.85, filter:"drop-shadow(0 1px 1px rgba(0,0,0,0.5))" }} />
        ))}
        <div style={{ fontSize:10, color:"#6b7794", letterSpacing:0.4, textTransform:"uppercase", marginLeft:4 }}>4 agents on team</div>
      </div>
      {/* Mini chat QTextEdit#suChat — super_user_card.py:235-240, fixedHeight 80.
          When empty, _refresh_chat (:415-421) renders the placeholder line. */}
      <div data-ui="suChat" style={{ height:80, background:"#0a0d14", color:"#cbd2e0", border:"1px solid #1d2434", borderRadius:8, padding:"8px 10px", fontSize:13, lineHeight:1.5, overflow:"hidden" }}>
        {/* Pre-seeded "You" line so the card isn't blank — Qt renders
            user messages prefixed "You:" with #5cf0ff (super_user_card.py:424-437). */}
        <div style={{ marginBottom:6 }}>
          <span style={{ color:"#5cf0ff", fontWeight:700 }}>You:</span>{" "}
          <span style={{ color:"#cbd2e0" }}>summarize the last commit and propose a follow-up</span>
        </div>
        <div>
          <span style={{ color:"#ffc060", fontWeight:700 }}>Team:</span>{" "}
          <span style={{ color:"#cbd2e0" }}>routing to UI Designer — stage 1 sketch.</span>
        </div>
      </div>
      {/* Reply input + Send — super_user_card.py:242-256. */}
      <div data-ui="suInputRow" style={{ display:"flex", alignItems:"center", gap:8 }}>
        <input data-ui="suReply" placeholder="Reply to the team — Enter to send" style={{ flex:1, height:32, borderRadius:8, padding:"6px 10px", background:"#0a0d14", color:"#e6f0ff", fontSize:14, border:"1px solid #2a3148" }} />
        <button data-ui="suSend" style={{ height:32, padding:"6px 14px", borderRadius:8, border:"1px solid #5cf0ff", background:"#5cf0ff", color:"#0a0d14", fontSize:13, fontWeight:700 }}>Send</button>
      </div>
      {/* Auto-approve QCheckBox#suTrust — super_user_card.py:218-233.
          12px wide indicator with red fill when checked (qss :88-96). */}
      <label data-ui="suTrust" style={{ display:"flex", alignItems:"center", gap:6, fontSize:13, color:"#7888a8" }}>
        <input type="checkbox" style={{ width:12, height:12, accentColor:"#ff6060" }} />
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
  // Animated phase for the centre's rotating gold arc-rings — mirrors
  // _paint_centre's QTimer-driven _phase in agent_team_canvas.py:979-1067.
  const [arcPhase, setArcPhase] = React.useState(0);
  React.useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      setArcPhase(((now - start) / 1000) * 36); // 36 deg/sec
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  // LAYER_COLORS — IDENTICAL to agent_team_canvas.py:178-187. Index =
  // BFS layer from the orchestrator (0=gold, 1=green, 2=blue, …). The
  // orbital diagram and the graph view share this palette.
  const LAYER_COLORS = [
    "#f1c44a", "#48d486", "#3aa0ff", "#ee5b5b",
    "#ff9a3a", "#9aa3b2", "#a578ff", "#ff79c4",
  ];
  // Per-agent BFS depth from the orchestrator — mirrors _depth in
  // agent_team_canvas.py:225-235. Real edges from set_edges() aren't
  // wired into the React replica yet, so we fake two depth tiers
  // among the 8 roster entries so the multi-ring shape reads
  // correctly (suggestion from finding [0]).
  const roster: { label: string; icon: string; depth: number; active: boolean }[] = [
    { label: "Workshop Writer",  icon: "Agents/owl_documentation.png", depth: 1, active: true  },
    { label: "Backend Server",   icon: "owl_server.png",               depth: 1, active: false },
    { label: "UI Designer",      icon: "Agents/owl_webapp.png",        depth: 1, active: true  },
    { label: "Knowledge Doctor", icon: "Agents/owl_researcher.png",    depth: 1, active: false },
    { label: "Onboarded Coder",  icon: "Agents/owl_coder.png",         depth: 2, active: false },
    { label: "Product Studio",   icon: "owl_studio_square.png",        depth: 2, active: false },
    { label: "Frontend Coder",   icon: "Agents/owl_asssitant.png",     depth: 2, active: false },
    { label: "Workshop Owl",     icon: "Agents/owl_critic.png",        depth: 2, active: false },
  ];
  // Group by depth — mirrors by_depth in agent_team_canvas.py:653-657.
  const depthMap = new Map<number, typeof roster>();
  for (const r of roster) {
    if (!depthMap.has(r.depth)) depthMap.set(r.depth, []);
    depthMap.get(r.depth)!.push(r);
  }
  const sortedDepths = Array.from(depthMap.keys()).sort((a, b) => a - b);
  const max_depth = sortedDepths[sortedDepths.length - 1];
  // Geometry — mirrors agent_team_canvas.py:668-685. inner_offset is
  // the centre clearance; step is the gap between consecutive rings,
  // floor-clamped so rings don't collapse onto the orchestrator. The
  // 90 floor is from Qt at zoom=1.
  const canvas_cap = Math.min(w - card_reserve, h) * 0.45;
  const max_radius = Math.min(canvas_cap, Math.min(w, h) * 0.45);
  const inner_offset = 130;
  let step = (max_radius - inner_offset) / Math.max(1, max_depth);
  if (step < 90) step = 90;
  // Cached ring radii for the visible-ring painter — agent_team_canvas.py:683.
  const ring_radii = sortedDepths.map(d => inner_offset + step * d);
  const arc_span = (Math.PI * 2) * (340 / 360);
  type Node = { x: number; y: number; label: string; icon: string; active: boolean; depth: number };
  const nodes: Node[] = [];
  // Distribute agents on each ring across a 340° arc — mirrors
  // agent_team_canvas.py:705-714. theta = arc_span*(i+1)/count - π/2.
  for (const depth of sortedDepths) {
    const ringAgents = depthMap.get(depth)!;
    const count = ringAgents.length;
    const r = inner_offset + step * depth;
    for (let i = 0; i < count; i++) {
      const a = ringAgents[i];
      const theta = count === 1
        ? -Math.PI / 2
        : (arc_span * (i + 1)) / count - Math.PI / 2;
      nodes.push({
        x: cx + r * Math.cos(theta),
        y: cy + r * Math.sin(theta),
        label: a.label,
        icon:  a.icon,
        active: a.active,
        depth,
      });
    }
  }
  const NODE_R = 22; // matches `r = 22 + 4*pulse` in agent_team_canvas.py:1081
  // Scale off canvas — matches agent_team_canvas.py where r ≈ 0.18 * min(w,h)
  // for the centre. We use a slightly tighter 0.10 floor so the hub
  // dominates the centre without overlapping the agent ring.
  const orchestrator_r = Math.max(48, Math.min(w, h) * 0.10);
  // Rotating gold arc-rings — outer #f1c44a at r_out, inner #ffd76a at 0.7*r_out.
  // Three 60° arcs at offsets 0/130/240 on the outer ring; three 70° arcs
  // at 0/110/230 on the inner ring (counter-rotating). Mirrors
  // agent_team_canvas.py:996-1011.
  const arc_r_out = orchestrator_r * 1.7;
  const arc_r_in  = orchestrator_r * 1.2;
  // Alpha pulse on the arcs + core — mirrors agent_team_canvas.py:1017
  // (pulse = 0.5 + 0.5*sin(phase*2.6)). Drives the arc opacity envelope
  // and the gold-core gradient stops so the hub feels alive instead of
  // statically printed.
  const pulse = 0.5 + 0.5 * Math.sin((arcPhase * Math.PI) / 180);
  const arcAlphaOut = 0.78 + 0.14 * pulse;
  const arcAlphaIn  = 0.70 + 0.16 * pulse;
  const coreInner = 0.43 + 0.27 * pulse;  // Qt: 110+70*pulse → /255
  const coreMid   = 0.20 + 0.16 * pulse;  // Qt: 50+40*pulse → /255
  const arcPath = (rad: number, startDeg: number, sweepDeg: number) => {
    const a0 = (startDeg * Math.PI) / 180;
    const a1 = ((startDeg + sweepDeg) * Math.PI) / 180;
    const sx = cx + rad * Math.cos(a0);
    const sy = cy + rad * Math.sin(a0);
    const ex = cx + rad * Math.cos(a1);
    const ey = cy + rad * Math.sin(a1);
    const large = sweepDeg > 180 ? 1 : 0;
    return `M ${sx} ${sy} A ${rad} ${rad} 0 ${large} 1 ${ex} ${ey}`;
  };
  return (
    <div data-ui="AgentTeamCanvas" style={{ position:"relative", width:w, height:h, background:`radial-gradient(ellipse at ${w/2}px ${h/2}px, rgba(192,138,255,0.10) 0%, rgba(116,164,255,0.06) 30%, rgba(40,60,110,0.04) 60%, rgba(0,0,0,0) 85%), linear-gradient(180deg, #101522 0%, #06080d 100%)`, overflow:"hidden" }}>
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
          {/* Soft glowing gold core — translucent so the inner arc-ring
              shows through. Replaces the opaque #1a2240 hub disk that was
              masking the inner arc. Mirrors the QRadialGradient core at
              agent_team_canvas.py:1018-1024 — alpha-pulsed gold center
              fading to transparent. */}
          <radialGradient id="orchCore" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor={`rgba(255,215,106,${coreInner.toFixed(3)})`} />
            <stop offset="60%"  stopColor={`rgba(241,196,74,${coreMid.toFixed(3)})`} />
            <stop offset="100%" stopColor="rgba(10,13,20,0)" />
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
        {/* Visible orbit rings — one per BFS depth, coloured with
            LAYER_COLORS so ring 1 = green, ring 2 = blue, etc. Pen
            1.6px, alpha ~200/255. Mirrors _paint_rings in
            agent_team_canvas.py:823-840. */}
        {ring_radii.map((r, idx) => {
          const layer = idx + 1;
          const col = LAYER_COLORS[layer % LAYER_COLORS.length];
          return (
            <circle
              key={"ring" + idx}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={col}
              strokeOpacity={200 / 255}
              strokeWidth={1.6}
              strokeLinecap="round"
            />
          );
        })}
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
        {/* Translucent gold core replaces the opaque #1a2240 hub disk so
            the inner arc-ring is no longer masked. The thin gold outline
            stays for definition. */}
        <circle cx={cx} cy={cy} r={orchestrator_r * 1.5} fill="url(#orchCore)" stroke="rgba(255,200,100,0.55)" strokeWidth="1.6" />
        {/* Outer rotating gold arc-ring — 3 × 60° arcs at offsets 0/130/240. */}
        {[0, 130, 240].map((off, i) => (
          <path
            key={"arcOut" + i}
            d={arcPath(arc_r_out, arcPhase + off, 60)}
            stroke="#f1c44a"
            strokeWidth={2.6}
            strokeLinecap="round"
            fill="none"
            opacity={arcAlphaOut}
          />
        ))}
        {/* Inner rotating gold arc-ring — 3 × 70° arcs at offsets 0/110/230,
            counter-rotating. Mirrors agent_team_canvas.py:1010-1011. */}
        {[0, 110, 230].map((off, i) => (
          <path
            key={"arcIn" + i}
            d={arcPath(arc_r_in, -arcPhase * 1.3 + off, 70)}
            stroke="#ffd76a"
            strokeWidth={2.0}
            strokeLinecap="round"
            fill="none"
            opacity={arcAlphaIn}
          />
        ))}
      </svg>
      <img src={`${ICONS}/owl_agentic.png`} style={{ position:"absolute", left:cx - orchestrator_r * 1.12, top:cy - orchestrator_r * 1.12, width:orchestrator_r * 2.24, height:orchestrator_r * 2.24, pointerEvents:"none", filter:"drop-shadow(0 0 16px rgba(255,200,100,0.55)) drop-shadow(0 0 28px rgba(255,180,80,0.35))" }} />
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
        <div key={"l"+i} style={{ position:"absolute", left:n.x - 60, top:n.y + 30, width:120, textAlign:"center", fontSize:12, fontWeight:600, color:n.active?"#ffffff":"#e6e8eb", letterSpacing:0.4, pointerEvents:"none", textShadow:"0 1px 3px rgba(0,0,0,0.9)" }}>{n.label}</div>
      ))}
    </div>
  );
}

// OrchestratorPane — mirrors the RIGHT pane of _build_roster
// (agents_page.py:2683-2779). Structure:
//   1. log_header QLabel — agents_page.py:2692-2699. 12pt bold #fff.
//      Default text "Click an agent on the canvas to view its log."
//      Once an agent is selected: f"📜 {display_label}"
//      (agents_page.py:5355).
//   2. picker_host — Model picker for selected agent. Hidden until
//      a node is clicked (:2721).
//   3. voice_host — Voice row for selected agent. Hidden by default (:2744).
//   4. QTabWidget#OrchestratorLogTabs with two tabs:
//        💬 Reply  (QTextEdit#OrchestratorReplyView, agents_page.py:2771)
//        🧠 Thought (QTextEdit#OrchestratorThoughtView, :2772)
//      Tab style — Qt default plus the log_view_css at :2749-2757
//      (#0f1218 bg, Consolas, 14px).
function OrchestratorPane() {
  // Sample chain-of-thought blob — placeholder until the bus is wired.
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
  // Per-role border + label colour palette — mirrors
  // _append_log_line's prefix_color map in agents_page.py:5411-5419.
  // user → #9ad9ff, reply → #a8e7a0, thought → #dcb0ff, etc.
  const messages = [
    { role:"orchestrator", color:"#ffd97a", text:"Routing task to UI Designer — stage 1 sketch." },
    { role:"UI Designer",  color:"#7fdfff", text:"Drafted the brief outline; uploading mock." },
    { role:"Workshop Writer", color:"#dcb0ff", text:"Will pair narrative with the mock once received." },
  ];
  // Reply is the default tab — agents_page.py:2773 / :5367.
  const [activeTab, setActiveTab] = React.useState<"reply"|"thought">("reply");
  return (
    <div data-ui="RosterRight" style={{ display:"flex", flexDirection:"column", height:"100%", background:"#0c0f1a", padding:"0 0 0 8px" }}>
      {/* log_header QLabel — 12pt bold white. Default-state text per :2692.
          Once a node is clicked, agents_page.py:5355 swaps in "📜 <label>". */}
      <div data-ui="LogHeader" style={{ padding:"8px 12px 4px", display:"flex", alignItems:"center", gap:8 }}>
        {/* Default state — agents_page.py:2692 plain "Click an agent…" string.
            Once an agent is selected, agents_page.py:5355 swaps to
            f"📜 {display_label}" (no "ORCHESTRATOR —" prefix exists anywhere
            in Qt). 12pt bold #fff per :2694-2698. */}
        <div style={{ fontSize:16, fontWeight:700, color:"#fff", letterSpacing:0.3 }}>Click an agent on the canvas to view its log.</div>
        <div style={{ flex:1 }} />
      </div>
      {/* picker_host — agents_page.py:2704-2721. "MODEL" 11px #aaa label
          + ModelPickerButton slot. Hidden until an agent is selected; we
          show a representative state so the user sees the surface. */}
      <div data-ui="PickerHost" style={{ padding:"0 12px 4px", display:"flex", alignItems:"center", gap:8 }}>
        <span style={{ fontSize:11, color:"#aaa", letterSpacing:0.6, textTransform:"uppercase" }}>Model</span>
        <button style={{ flex:1, height:28, padding:"0 10px", background:"rgba(0,0,0,0.28)", color:"#e6e8eb", border:"none", borderRadius:6, fontSize:12, textAlign:"left" }}>Qwen2.5-Coder Q4 ▾</button>
      </div>
      {/* voice_host — agents_page.py:2727-2744. "VOICE" label + _AgentVoiceRow:
          enable cb, voice button, rate spin, ▶ preview, ➤ broadcast. */}
      <div data-ui="VoiceHost" style={{ padding:"0 12px 8px", display:"flex", alignItems:"center", gap:8 }}>
        <span style={{ fontSize:11, color:"#aaa", letterSpacing:0.6, textTransform:"uppercase" }}>Voice</span>
        <input type="checkbox" defaultChecked style={{ width:13, height:13, accentColor:"#5cf0ff" }} title="Speak this agent's replies aloud" />
        <button style={{ flex:1, height:28, padding:"0 10px", background:"rgba(0,0,0,0.28)", color:"#e6e8eb", border:"none", borderRadius:6, fontSize:12, textAlign:"left" }}>Auto voice</button>
        <input type="number" defaultValue={0} style={{ width:78, height:28, padding:"0 8px", background:"rgba(0,0,0,0.28)", color:"#e6e8eb", border:"none", borderRadius:6, fontSize:12 }} title="Speaking rate (words per minute)" />
        <button style={{ width:28, height:28, padding:0, background:"rgba(255,255,255,0.06)", color:"#dadcdf", border:"none", borderRadius:6, fontSize:12 }} title="Preview this voice">▶</button>
        <button style={{ width:28, height:28, padding:0, background:"rgba(255,255,255,0.06)", color:"#dadcdf", border:"none", borderRadius:6, fontSize:14 }} title="Apply this voice to every agent on the team">➤</button>
      </div>
      {/* QTabWidget#OrchestratorLogTabs — agents_page.py:2769-2773. Two
          tabs (💬 Reply, 🧠 Thought). Reply is the default. The tab
          headers are Qt's standard QTabBar; cyan when active. */}
      <div data-ui="OrchestratorLogTabs" style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", padding:"0 0 8px" }}>
        <div style={{ display:"flex", alignItems:"center", padding:"0 12px", gap:0, borderBottom:"1px solid rgba(120,220,255,0.10)" }}>
          {/* Tab weights/underline tuned to match Qt's native QTabBar:
              500 weight + 1.5px underline reads closer to the thin
              native accent line than 600 + 2px did. */}
          <button onClick={() => setActiveTab("reply")} style={{ padding:"8px 14px", border:"none", background:"transparent", color: activeTab === "reply" ? "#7fdfff" : "#9aa0a6", fontSize:13, fontWeight:500, borderBottom: activeTab === "reply" ? "1.5px solid #7fdfff" : "1.5px solid transparent", display:"inline-flex", alignItems:"center", gap:4 }}>💬 Reply</button>
          <button onClick={() => setActiveTab("thought")} style={{ padding:"8px 14px", border:"none", background:"transparent", color: activeTab === "thought" ? "#dcb0ff" : "#9aa0a6", fontSize:13, fontWeight:500, borderBottom: activeTab === "thought" ? "1.5px solid #dcb0ff" : "1.5px solid transparent", display:"inline-flex", alignItems:"center", gap:4 }}>🧠 Thought</button>
          <div style={{ flex:1 }} />
        </div>
        {/* Reply tab body — QTextEdit#OrchestratorReplyView. log_view_css
            from agents_page.py:2749-2757: #0f1218 bg #cbd2e0 fg, Consolas
            14px. Inside: agent-prefixed lines + the code block. */}
        <div data-ui="OrchestratorReplyView" style={{ flex:1, display: activeTab === "reply" ? "flex" : "none", flexDirection:"column", margin:"8px 10px 0", padding:10, gap:8, background:"#0f1218", border:"1px solid rgba(120,220,255,0.08)", borderRadius:8, overflow:"hidden", fontFamily:"Consolas, 'JetBrains Mono', monospace", fontSize:14, lineHeight:1.5, color:"#cbd2e0" }}>
          {messages.map((m, i) => (
            <div key={i} style={{ display:"flex", alignItems:"flex-start", gap:8 }}>
              <div style={{ width:28, height:28, flexShrink:0, borderRadius:14, background:m.color, opacity:0.85, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, color:"#06080d", fontFamily:"Segoe UI, sans-serif" }}>{m.role[0].toUpperCase()}</div>
              <div style={{ flex:1, background:"rgba(255,255,255,0.04)", borderLeft:`3px solid ${m.color}`, borderRadius:8, padding:"4px 10px" }}>
                <div style={{ fontSize:10, fontWeight:700, color:m.color, textTransform:"uppercase", letterSpacing:0.5, marginBottom:2, fontFamily:"Segoe UI, sans-serif" }}>{m.role}</div>
                <div style={{ fontSize:12, color:"#dadcdf", lineHeight:1.3, fontFamily:"Segoe UI, sans-serif" }}>{m.text}</div>
              </div>
            </div>
          ))}
          {/* Code block — the highlighted snippet that mirrors what the
              orchestrator writes into the chat view between regular
              messages. whiteSpace:"pre-wrap" preserves the line breaks. */}
          <div style={{ flex:1, marginTop:4, padding:8, background:"#0a0d14", border:"1px solid rgba(120,220,255,0.10)", borderRadius:6, whiteSpace:"pre-wrap", overflow:"auto" }}>{code}</div>
        </div>
        {/* Thought tab — QTextEdit#OrchestratorThoughtView. Receives
            tool_call / tool_result / event / inline reasoning per
            _append_log_line :5429-5434. */}
        <div data-ui="OrchestratorThoughtView" style={{ flex:1, display: activeTab === "thought" ? "block" : "none", margin:"8px 10px 0", padding:10, background:"#0f1218", border:"1px solid rgba(220,180,255,0.10)", borderRadius:8, overflow:"auto", fontFamily:"Consolas, 'JetBrains Mono', monospace", fontSize:14, lineHeight:1.5, color:"#cbd2e0" }}>
          <div style={{ color:"#888", fontSize:11 }}>No thought traffic yet — tool calls, reasoning, and events land here while the team runs.</div>
        </div>
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
              <TeamInfoCard />
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

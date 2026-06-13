// WorldPage — the 2.5D RPG HQ (P0-1, Appendix A render architecture).
//
// Four layers: a real isometric room renderer (shaded pseudo-3D props,
// tiled floor, wall panels, light shafts, dust, vignette — replaced the
// first-pass gradient stripes the user rightly called out; shipped art
// under /world/backgrounds/<key>.webp still wins when present), navmesh
// data, circular agent tokens walking via CSS transitions, and the
// FX/bubble layer. Bound to the EXISTING dispatch stream via worldBus.
// Progression persists via worldState (§0.8).

import React from "react";
import { worldSubscribe, worldEmit, type WorldEvent } from "./worldBus";
import { getProgress, subscribeProgress, addXp, setScene } from "./worldState";

const DEMO_LINES = [
  "Planning the build and dispatching the team…",
  "Reading the files I'll need to change…",
  "Writing the implementation + tests…",
  "Reviewing the diff for correctness…",
];

type PropKind = "desk" | "rack" | "shelf" | "board" | "forge" | "lantern" | "crates" | "podium" | "vault";
type Prop = { kind: PropKind; x: number; y: number; s?: number };

type Scene = {
  key: string;
  title: string;
  emoji: string;
  desc: string;
  /// [wallTop, wallBottom, floor, glow, accent]
  pal: [string, string, string, string, string];
  unlockXp: number;
  props: Prop[];
};

// The 9 scenes from Appendix A.2, each a parameterized room.
const SCENES: Scene[] = [
  { key: "hq_loft", title: "Command Loft", emoji: "🛋", desc: "Home base — glowing desks and mission boards.", pal: ["#0b1020", "#1a2440", "#222d4d", "#5ac8fa", "#f1c44a"], unlockXp: 0,
    props: [{ kind: "board", x: 0.18, y: 0.30 }, { kind: "desk", x: 0.16, y: 0.66 }, { kind: "desk", x: 0.46, y: 0.74, s: 1.1 }, { kind: "desk", x: 0.76, y: 0.64 }, { kind: "lantern", x: 0.05, y: 0.78 }, { kind: "lantern", x: 0.94, y: 0.80 }, { kind: "shelf", x: 0.88, y: 0.42 }] },
  { key: "quest_plaza", title: "Quest Plaza", emoji: "📜", desc: "Quest board, reward chest, lantern-lit paths.", pal: ["#150f26", "#2a1f42", "#332851", "#f1c44a", "#ff9a3a"], unlockXp: 0,
    props: [{ kind: "board", x: 0.42, y: 0.28, s: 1.4 }, { kind: "crates", x: 0.14, y: 0.70 }, { kind: "podium", x: 0.78, y: 0.68 }, { kind: "lantern", x: 0.28, y: 0.74 }, { kind: "lantern", x: 0.62, y: 0.80 }, { kind: "lantern", x: 0.90, y: 0.74 }] },
  { key: "server_core", title: "Server Core", emoji: "🖥", desc: "GPU towers and data streams.", pal: ["#06141a", "#0d2530", "#11303c", "#37e6c8", "#4aa8ff"], unlockXp: 50,
    props: [{ kind: "rack", x: 0.10, y: 0.58 }, { kind: "rack", x: 0.24, y: 0.52 }, { kind: "rack", x: 0.76, y: 0.52 }, { kind: "rack", x: 0.90, y: 0.58 }, { kind: "podium", x: 0.50, y: 0.70, s: 1.2 }, { kind: "lantern", x: 0.40, y: 0.84 }, { kind: "lantern", x: 0.60, y: 0.84 }] },
  { key: "finetune_workshop", title: "Model Forge", emoji: "⚒", desc: "Dataset crates and the glowing forge.", pal: ["#160e08", "#2c1c10", "#3a2517", "#ff9a3a", "#ffd166"], unlockXp: 100,
    props: [{ kind: "forge", x: 0.72, y: 0.56, s: 1.3 }, { kind: "crates", x: 0.12, y: 0.68 }, { kind: "crates", x: 0.26, y: 0.78, s: 0.8 }, { kind: "desk", x: 0.44, y: 0.66 }, { kind: "board", x: 0.16, y: 0.30 }, { kind: "lantern", x: 0.90, y: 0.80 }] },
  { key: "research_library", title: "Archive", emoji: "📚", desc: "Tall shelves and floating documents.", pal: ["#120e22", "#241c3e", "#2d2449", "#b08aff", "#7fdfff"], unlockXp: 175,
    props: [{ kind: "shelf", x: 0.08, y: 0.46 }, { kind: "shelf", x: 0.22, y: 0.50 }, { kind: "shelf", x: 0.78, y: 0.50 }, { kind: "shelf", x: 0.92, y: 0.46 }, { kind: "desk", x: 0.48, y: 0.72, s: 1.1 }, { kind: "board", x: 0.50, y: 0.27 }, { kind: "lantern", x: 0.35, y: 0.84 }] },
  { key: "debug_office", title: "Debug Office", emoji: "🕵", desc: "Noir case boards and red string.", pal: ["#140a0d", "#291418", "#33191f", "#ff6b6b", "#ffd97a"], unlockXp: 250,
    props: [{ kind: "board", x: 0.26, y: 0.28, s: 1.3 }, { kind: "board", x: 0.66, y: 0.30 }, { kind: "desk", x: 0.30, y: 0.70 }, { kind: "desk", x: 0.66, y: 0.74 }, { kind: "lantern", x: 0.08, y: 0.78 }, { kind: "crates", x: 0.88, y: 0.72, s: 0.8 }] },
  { key: "sandbox_bunker", title: "Isolation Bunker", emoji: "🛡", desc: "Reinforced glass and hazard stripes.", pal: ["#0a160f", "#15291c", "#1b3324", "#7ff0c5", "#f1c44a"], unlockXp: 350,
    props: [{ kind: "vault", x: 0.80, y: 0.46, s: 1.2 }, { kind: "rack", x: 0.10, y: 0.56 }, { kind: "desk", x: 0.32, y: 0.70 }, { kind: "desk", x: 0.56, y: 0.76 }, { kind: "lantern", x: 0.92, y: 0.82 }] },
  { key: "bridge_control", title: "Bridge Control", emoji: "📡", desc: "Radio consoles and message tubes.", pal: ["#081120", "#13233c", "#182c49", "#4aa8ff", "#7ff0c5"], unlockXp: 475,
    props: [{ kind: "desk", x: 0.20, y: 0.62 }, { kind: "desk", x: 0.44, y: 0.70 }, { kind: "desk", x: 0.68, y: 0.62 }, { kind: "rack", x: 0.90, y: 0.52 }, { kind: "board", x: 0.20, y: 0.28 }, { kind: "board", x: 0.62, y: 0.28 }] },
  { key: "arena_coliseum", title: "Arena", emoji: "⚔", desc: "Two podiums and the prompt stage.", pal: ["#190b18", "#30152c", "#3c1b37", "#ff7ed1", "#f1c44a"], unlockXp: 600,
    props: [{ kind: "podium", x: 0.28, y: 0.62, s: 1.2 }, { kind: "podium", x: 0.72, y: 0.62, s: 1.2 }, { kind: "podium", x: 0.50, y: 0.78, s: 1.5 }, { kind: "board", x: 0.50, y: 0.26, s: 1.3 }, { kind: "lantern", x: 0.10, y: 0.78 }, { kind: "lantern", x: 0.90, y: 0.78 }] },
];

const STATIONS: Array<[number, number]> = [
  [0.20, 0.66], [0.40, 0.76], [0.60, 0.68], [0.78, 0.74], [0.32, 0.56], [0.68, 0.56], [0.50, 0.84],
];
const WAYPOINTS: Array<[number, number]> = [
  [0.12, 0.80], [0.28, 0.68], [0.45, 0.80], [0.62, 0.62], [0.78, 0.82], [0.88, 0.66], [0.52, 0.66], [0.20, 0.88], [0.70, 0.88],
];

function iconFor(name: string): string {
  const n = name.toLowerCase();
  const pick =
    n.includes("orch") ? "owl_AgenticTeam" :
    n.includes("cod") || n.includes("dev") ? "owl_coding" :
    n.includes("research") || n.includes("architect") || n.includes("read") ? "owl_chat" :
    n.includes("critic") || n.includes("review") ? "owl_training" :
    "owl_startup";
  return `/Page_icons/${pick}.png`;
}

// ---- pseudo-isometric prop renderer (SVG) ---------------------------------
// One light direction (upper-left): top face lightest, front mid, side dark.

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, Math.round(((n >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((n >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((n & 255) * f)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function IsoBox({ x, y, w, h, d, base, children }: {
  x: number; y: number; w: number; h: number; d: number; base: string;
  children?: React.ReactNode;
}) {
  // (x,y) = front-bottom-left in SVG px; depth goes up-right.
  const dx = d * 0.9, dy = d * 0.5;
  return (
    <g>
      <polygon points={`${x},${y - h} ${x + w},${y - h} ${x + w + dx},${y - h - dy} ${x + dx},${y - h - dy}`} fill={shade(base, 1.45)} />
      <rect x={x} y={y - h} width={w} height={h} fill={base} />
      <polygon points={`${x + w},${y} ${x + w},${y - h} ${x + w + dx},${y - h - dy} ${x + w + dx},${y - dy}`} fill={shade(base, 0.62)} />
      <ellipse cx={x + w / 2 + dx / 2} cy={y + 6} rx={w * 0.72} ry={10} fill="rgba(0,0,0,0.38)" />
      {children}
    </g>
  );
}

function SceneProp({ p, pal }: { p: Prop; pal: Scene["pal"] }) {
  const [, , floorC, glow, accent] = pal;
  const s = p.s ?? 1;
  const X = p.x * 1600, Y = 420 + p.y * 480 * 0.95;
  const wood = shade(floorC, 1.35);
  switch (p.kind) {
    case "desk":
      return (
        <g>
          <IsoBox x={X - 55 * s} y={Y} w={110 * s} h={42 * s} d={26 * s} base={wood}>
            <rect x={X - 34 * s} y={Y - 92 * s} width={64 * s} height={40 * s} rx={3} fill="#0a121f" stroke={shade(glow, 0.8)} strokeWidth={1.5} />
            <rect x={X - 28 * s} y={Y - 86 * s} width={52 * s} height={28 * s} fill={glow} opacity={0.5}>
              <animate attributeName="opacity" values="0.35;0.6;0.35" dur="3.2s" repeatCount="indefinite" />
            </rect>
            <rect x={X - 6 * s} y={Y - 52 * s} width={8 * s} height={10 * s} fill="#0a121f" />
          </IsoBox>
        </g>
      );
    case "rack":
      return (
        <IsoBox x={X - 34 * s} y={Y} w={68 * s} h={150 * s} d={22 * s} base={shade(floorC, 0.9)}>
          {[0, 1, 2, 3, 4].map(i => (
            <g key={i}>
              <rect x={X - 26 * s} y={Y - 138 * s + i * 26 * s} width={52 * s} height={16 * s} rx={2} fill="#060b14" />
              <circle cx={X + 14 * s} cy={Y - 130 * s + i * 26 * s} r={2.6} fill={glow}>
                <animate attributeName="opacity" values="1;0.2;1" dur={`${1.1 + i * 0.37}s`} repeatCount="indefinite" />
              </circle>
              <circle cx={X + 4 * s} cy={Y - 130 * s + i * 26 * s} r={2.6} fill={accent} opacity={0.8} />
            </g>
          ))}
        </IsoBox>
      );
    case "shelf":
      return (
        <IsoBox x={X - 40 * s} y={Y} w={80 * s} h={170 * s} d={20 * s} base={wood}>
          {[0, 1, 2, 3].map(i => (
            <g key={i}>
              <rect x={X - 32 * s} y={Y - 152 * s + i * 38 * s} width={64 * s} height={4} fill={shade(wood, 0.7)} />
              {[0, 1, 2, 3].map(j => (
                <rect key={j} x={X - 30 * s + j * 16 * s} y={Y - 148 * s + i * 38 * s} width={10 * s} height={26 * s} rx={1.5}
                  fill={j % 2 ? shade(accent, 0.75) : shade(glow, 0.6)} opacity={0.85} />
              ))}
            </g>
          ))}
        </IsoBox>
      );
    case "board":
      // Wall-mounted mission board with pinned notes.
      return (
        <g>
          <rect x={X - 90 * s} y={120 + (p.y - 0.28) * 600} width={180 * s} height={110 * s} rx={6}
            fill={shade(pal[1], 1.25)} stroke={shade(glow, 0.85)} strokeWidth={2} />
          {[...Array(6)].map((_, i) => (
            <rect key={i} x={X - 76 * s + (i % 3) * 56 * s} y={134 + (p.y - 0.28) * 600 + Math.floor(i / 3) * 46 * s}
              width={42 * s} height={32 * s} rx={2} fill={i % 2 ? "#e8e3cf" : shade(accent, 1.1)} opacity={0.92}
              transform={`rotate(${(i % 3 - 1) * 3} ${X} ${160})`} />
          ))}
          <circle cx={X} cy={120 + (p.y - 0.28) * 600 + 110 * s + 10} r={3} fill={glow} opacity={0.9} />
        </g>
      );
    case "forge":
      return (
        <IsoBox x={X - 60 * s} y={Y} w={120 * s} h={70 * s} d={30 * s} base={shade(floorC, 0.85)}>
          <circle cx={X} cy={Y - 35 * s} r={26 * s} fill={glow} opacity={0.85}>
            <animate attributeName="r" values={`${24 * s};${30 * s};${24 * s}`} dur="2.4s" repeatCount="indefinite" />
          </circle>
          <circle cx={X} cy={Y - 35 * s} r={44 * s} fill={glow} opacity={0.18}>
            <animate attributeName="opacity" values="0.1;0.3;0.1" dur="2.4s" repeatCount="indefinite" />
          </circle>
        </IsoBox>
      );
    case "lantern":
      return (
        <g>
          <rect x={X - 3} y={Y - 120 * s} width={6} height={120 * s} fill={shade(floorC, 0.7)} />
          <circle cx={X} cy={Y - 128 * s} r={11 * s} fill={glow} opacity={0.9}>
            <animate attributeName="opacity" values="0.7;1;0.7" dur="3.6s" repeatCount="indefinite" />
          </circle>
          <circle cx={X} cy={Y - 128 * s} r={30 * s} fill={glow} opacity={0.14} />
          <ellipse cx={X} cy={Y + 4} rx={26 * s} ry={7} fill={glow} opacity={0.10} />
        </g>
      );
    case "crates":
      return (
        <g>
          <IsoBox x={X - 36 * s} y={Y} w={48 * s} h={44 * s} d={20 * s} base={wood} />
          <IsoBox x={X + 6 * s} y={Y + 8} w={40 * s} h={36 * s} d={17 * s} base={shade(wood, 0.88)} />
          <IsoBox x={X - 20 * s} y={Y - 42 * s} w={42 * s} h={38 * s} d={18 * s} base={shade(wood, 1.08)} />
        </g>
      );
    case "podium":
      return (
        <IsoBox x={X - 50 * s} y={Y} w={100 * s} h={26 * s} d={34 * s} base={shade(floorC, 1.18)}>
          <ellipse cx={X + 14 * s} cy={Y - 30 * s} rx={44 * s} ry={13 * s} fill={glow} opacity={0.22}>
            <animate attributeName="opacity" values="0.14;0.3;0.14" dur="3s" repeatCount="indefinite" />
          </ellipse>
        </IsoBox>
      );
    case "vault":
      return (
        <g>
          <rect x={X - 70 * s} y={150} width={140 * s} height={200 * s} rx={8} fill={shade(pal[1], 1.15)} stroke={shade(glow, 0.7)} strokeWidth={2.5} />
          <circle cx={X} cy={150 + 100 * s} r={34 * s} fill="none" stroke={shade(glow, 0.9)} strokeWidth={5} />
          <circle cx={X} cy={150 + 100 * s} r={12 * s} fill={shade(glow, 0.9)} />
          {[...Array(5)].map((_, i) => (
            <rect key={i} x={X - 70 * s + i * 28 * s} y={150 + 200 * s} width={14 * s} height={8} fill={i % 2 ? "#f1c44a" : "#101010"} />
          ))}
        </g>
      );
  }
}

function SceneBackdrop({ scene }: { scene: Scene }) {
  const [wallTop, wallBottom, floorC, glow] = scene.pal;
  // Floor tile lattice (two diagonal line families = diamond tiles).
  const lines: React.ReactNode[] = [];
  for (let i = -8; i < 26; i++) {
    lines.push(<line key={`a${i}`} x1={i * 110} y1={420} x2={i * 110 + 460} y2={900} stroke={shade(floorC, 1.4)} strokeWidth={1.5} opacity={0.5} />);
    lines.push(<line key={`b${i}`} x1={i * 110} y1={420} x2={i * 110 - 460} y2={900} stroke={shade(floorC, 1.4)} strokeWidth={1.5} opacity={0.5} />);
  }
  return (
    <svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
      <defs>
        <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={wallTop} />
          <stop offset="100%" stopColor={wallBottom} />
        </linearGradient>
        <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={shade(floorC, 1.16)} />
          <stop offset="100%" stopColor={shade(floorC, 0.62)} />
        </linearGradient>
        <radialGradient id="halo" cx="50%" cy="44%" r="62%">
          <stop offset="0%" stopColor={glow} stopOpacity="0.16" />
          <stop offset="100%" stopColor={glow} stopOpacity="0" />
        </radialGradient>
        <radialGradient id="vig" cx="50%" cy="52%" r="75%">
          <stop offset="62%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.55" />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width="1600" height="430" fill="url(#wall)" />
      {/* wall panel seams + a wide glowing strip */}
      {[...Array(9)].map((_, i) => (
        <line key={i} x1={i * 200} y1={0} x2={i * 200} y2={420} stroke={shade(wallBottom, 1.35)} strokeWidth={2} opacity={0.5} />
      ))}
      <rect x="0" y="402" width="1600" height="7" fill={glow} opacity={0.34} />
      <rect x="0" y="409" width="1600" height="2.5" fill={glow} opacity={0.8} />
      {/* floor */}
      <rect x="0" y="420" width="1600" height="480" fill="url(#floor)" />
      <g clipPath="url(#floorclip)">{lines}</g>
      <clipPath id="floorclip"><rect x="0" y="420" width="1600" height="480" /></clipPath>
      {/* light shafts */}
      <polygon points="330,0 480,0 700,900 420,900" fill={glow} opacity={0.05} />
      <polygon points="1050,0 1180,0 1420,900 1160,900" fill={glow} opacity={0.04} />
      {/* props, painter's order: wall pieces first then by floor depth */}
      {[...scene.props].sort((a, b) => (a.kind === "board" || a.kind === "vault" ? -1 : a.y) - (b.kind === "board" || b.kind === "vault" ? -1 : b.y))
        .map((p, i) => <SceneProp key={i} p={p} pal={scene.pal} />)}
      <rect x="0" y="0" width="1600" height="900" fill="url(#halo)" />
      <rect x="0" y="0" width="1600" height="900" fill="url(#vig)" />
    </svg>
  );
}

// ---------------------------------------------------------------------------

type SpriteState = {
  name: string;
  x: number; y: number;
  active: boolean;
  bubble: string | null;
  bubbleAt: number;
};

const IDLE_CREW = ["orchestrator", "coder", "researcher", "critic"];
// Fixed home docks along the floor — idle agents REST here (no random
// wander; the only idle motion is a gentle in-place bob). Movement across
// the room happens ONLY on real dispatch events, so the HQ never "moves on
// its own".
const HOMES: Array<[number, number]> = [
  [0.16, 0.80], [0.38, 0.86], [0.62, 0.84], [0.84, 0.80], [0.50, 0.90], [0.28, 0.88], [0.74, 0.90],
];
const homeFor = (i: number): [number, number] => HOMES[i % HOMES.length];

export default function WorldPage() {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => subscribeProgress(force), []);
  const progress = getProgress();
  const scene = SCENES.find(s => s.key === progress.scene) ?? SCENES[0];
  const [artOk, setArtOk] = React.useState<Record<string, boolean>>({});
  // Whose home dock is whose, assigned in arrival order so a returning
  // agent always walks back to the SAME spot (stable, not random).
  const homeIdx = React.useRef<Map<string, number>>(new Map());
  const homeOf = (name: string): [number, number] => {
    let i = homeIdx.current.get(name);
    if (i === undefined) { i = homeIdx.current.size; homeIdx.current.set(name, i); }
    return homeFor(i);
  };

  const [sprites, setSprites] = React.useState<Map<string, SpriteState>>(() => {
    const m = new Map<string, SpriteState>();
    IDLE_CREW.forEach((n, i) => {
      const [x, y] = homeFor(i);
      m.set(n, { name: n, x, y, active: false, bubble: null, bubbleAt: 0 });
    });
    return m;
  });
  IDLE_CREW.forEach((n, i) => { if (!homeIdx.current.has(n)) homeIdx.current.set(n, i); });
  const [reward, setReward] = React.useState<number>(0);
  // Live-run tracking: how many agents are working + when we last heard
  // anything. Drives the status banner so it's obvious the HQ is tied to
  // real agentic runs (and idle when nothing is happening).
  const [activeCount, setActiveCount] = React.useState(0);
  const [lastEventAt, setLastEventAt] = React.useState(0);
  const [running, setRunning] = React.useState(false);

  const patch = (name: string, p: Partial<SpriteState>) =>
    setSprites(prev => {
      const next = new Map(prev);
      const cur = next.get(name) ?? { name, x: 0.5, y: 0.85, active: false, bubble: null, bubbleAt: 0 };
      next.set(name, { ...cur, ...p });
      return next;
    });

  React.useEffect(() => {
    const iv = window.setInterval(() => {
      setSprites(prev => {
        let changed = false;
        const next = new Map(prev);
        const now = Date.now();
        for (const [name, s] of next) {
          if (s.bubble && now - s.bubbleAt > 4500) {
            next.set(name, { ...s, bubble: null });
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => window.clearInterval(iv);
  }, []);

  React.useEffect(() => {
    let stationCursor = 0;
    return worldSubscribe((e: WorldEvent) => {
      setLastEventAt(Date.now());
      if (e.kind === "agent-start") {
        const [x, y] = STATIONS[stationCursor++ % STATIONS.length];
        patch(e.agent, { x, y, active: true });
        setRunning(true);
        setActiveCount(c => c + 1);
      } else if (e.kind === "agent-end") {
        const [x, y] = homeOf(e.agent); // walk back to its OWN dock, not random
        patch(e.agent, { x, y, active: false });
        setActiveCount(c => Math.max(0, c - 1));
      } else if (e.kind === "thought") {
        const text = e.text.length > 90 ? `${e.text.slice(0, 90)}…` : e.text;
        if (text.trim()) patch(e.agent, { bubble: text, bubbleAt: Date.now() });
      } else if (e.kind === "run-finish") {
        addXp(10, "Team run completed");
        setReward(r => r + 1);
        setRunning(false);
        setActiveCount(0);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The run is "live" only while we're actively hearing events. If the
  // stream goes quiet for 12s (e.g. the user navigated away mid-run) we
  // fall back to idle so the banner never lies.
  React.useEffect(() => {
    if (!running) return;
    const iv = window.setInterval(() => {
      if (Date.now() - lastEventAt > 12000) { setRunning(false); setActiveCount(0); }
    }, 2000);
    return () => window.clearInterval(iv);
  }, [running, lastEventAt]);

  // Scripted DEMO so the HQ is immediately legible: emits the SAME worldBus
  // events a real run does (agent-start → thoughts → agent-end → finish),
  // proving exactly what the HQ is tied to without setting up a team.
  const demoTimers = React.useRef<number[]>([]);
  const runDemo = () => {
    demoTimers.current.forEach(clearTimeout);
    demoTimers.current = [];
    const crew = IDLE_CREW;
    const at = (ms: number, fn: () => void) => demoTimers.current.push(window.setTimeout(fn, ms));
    crew.forEach((name, i) => {
      at(i * 600, () => worldEmit({ kind: "agent-start", agent: name }));
      at(i * 600 + 900, () => worldEmit({ kind: "thought", agent: name, text: DEMO_LINES[i % DEMO_LINES.length] }));
      at(i * 600 + 2600, () => worldEmit({ kind: "thought", agent: name, text: "…working on it." }));
      at(4200 + i * 500, () => worldEmit({ kind: "agent-end", agent: name }));
    });
    at(4200 + crew.length * 500 + 400, () => worldEmit({ kind: "run-finish" }));
  };
  React.useEffect(() => () => demoTimers.current.forEach(clearTimeout), []);

  const [, , , glow, accent] = scene.pal;
  const spriteList = [...sprites.values()].sort((a, b) => a.y - b.y);
  const nextUnlock = SCENES.filter(s => s.unlockXp > progress.xp).sort((a, b) => a.unlockXp - b.unlockXp)[0];

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", background: scene.pal[0] }}>
      <style>{`
        @keyframes owllm-world-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
        @keyframes owllm-world-bob-fast { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @keyframes owllm-world-pop { 0% { transform: translate(-50%,-50%) scale(0.4); opacity: 0; } 25% { opacity: 1; } 100% { transform: translate(-50%,-160%) scale(1.3); opacity: 0; } }
        @keyframes owllm-world-dust { 0% { transform: translateY(0); opacity: 0; } 12% { opacity: 0.7; } 88% { opacity: 0.7; } 100% { transform: translateY(-340px); opacity: 0; } }
        @keyframes owllm-world-ringpulse { 0%,100% { box-shadow: 0 0 12px 2px var(--wglow); } 50% { box-shadow: 0 0 26px 7px var(--wglow); } }
      `}</style>

      {/* Layer 1 — shipped art wins; otherwise the isometric room. */}
      {artOk[scene.key] !== false ? (
        <img
          src={`/world/backgrounds/${scene.key}.webp`}
          onError={() => setArtOk(m => ({ ...m, [scene.key]: false }))}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <SceneBackdrop scene={scene} />
      )}

      {/* ambient dust motes */}
      {[...Array(10)].map((_, i) => (
        <div key={i} style={{
          position: "absolute", left: `${7 + i * 9.5}%`, bottom: "12%",
          width: 3, height: 3, borderRadius: "50%", background: glow, opacity: 0,
          animation: `owllm-world-dust ${7 + (i % 5) * 2.3}s linear infinite`,
          animationDelay: `${i * 1.7}s`, pointerEvents: "none",
        }} />
      ))}

      {/* Layer 3 — agent tokens. Circular owl chips with shadow + ring. */}
      {spriteList.map(s => (
        <div key={s.name} style={{
          position: "absolute",
          left: `${s.x * 100}%`, top: `${s.y * 100}%`,
          transform: "translate(-50%, -100%)",
          transition: "left 1.7s ease-in-out, top 1.7s ease-in-out",
          textAlign: "center", width: 150, pointerEvents: "none",
          zIndex: Math.round(s.y * 100),
        }}>
          {s.bubble && (
            <div style={{ position: "relative", marginBottom: 10, display: "inline-block", maxWidth: 150 }}>
              <div style={{
                padding: "6px 10px", borderRadius: 10,
                background: "rgba(8,12,22,0.92)", border: `1px solid ${glow}88`,
                boxShadow: `0 4px 18px rgba(0,0,0,0.5), 0 0 10px ${glow}33`,
                color: "#eef2fc", fontSize: 10.5, lineHeight: 1.45, textAlign: "left",
                maxHeight: 62, overflow: "hidden",
              }}>{s.bubble}</div>
              <div style={{
                position: "absolute", left: "50%", bottom: -5, width: 10, height: 10,
                transform: "translateX(-50%) rotate(45deg)",
                background: "rgba(8,12,22,0.92)", borderRight: `1px solid ${glow}88`, borderBottom: `1px solid ${glow}88`,
              }} />
            </div>
          )}
          <div style={{ position: "relative", display: "inline-block", animation: `${s.active ? "owllm-world-bob-fast 0.8s" : "owllm-world-bob 3.4s"} ease-in-out infinite` }}>
            <div style={{
              position: "absolute", left: "50%", bottom: -7, transform: "translateX(-50%)",
              width: 46, height: 12, borderRadius: "50%", background: "rgba(0,0,0,0.5)", filter: "blur(3px)",
            }} />
            <div style={{
              ["--wglow" as any]: `${glow}aa`,
              width: 58, height: 58, borderRadius: "50%", overflow: "hidden",
              border: `2.5px solid ${s.active ? glow : "rgba(255,255,255,0.35)"}`,
              background: "#0a0f1c",
              boxShadow: s.active ? undefined : "0 5px 14px rgba(0,0,0,0.55)",
              animation: s.active ? "owllm-world-ringpulse 1.2s ease-in-out infinite" : undefined,
            }}>
              <img src={iconFor(s.name)} style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scale(1.18)" }} />
            </div>
            {s.active && (
              <div style={{
                position: "absolute", right: -7, top: -7, width: 20, height: 20, borderRadius: "50%",
                background: glow, color: "#08101c", fontSize: 12, lineHeight: "20px", fontWeight: 900,
                boxShadow: `0 0 10px ${glow}`,
              }}>⚙</div>
            )}
          </div>
          <div style={{
            marginTop: 4, display: "inline-block", padding: "1.5px 9px", borderRadius: 999,
            background: "rgba(8,12,22,0.78)", border: `1px solid ${s.active ? glow : "rgba(255,255,255,0.16)"}`,
            fontSize: 10, fontWeight: 800, color: s.active ? glow : "rgba(238,242,252,0.85)",
          }}>{s.name}</div>
        </div>
      ))}

      {reward > 0 && (
        <div key={reward} style={{
          position: "absolute", left: "50%", top: "46%",
          transform: "translate(-50%,-50%)",
          fontSize: 32, fontWeight: 900, color: "#f1c44a",
          textShadow: "0 0 18px rgba(241,196,74,0.7), 0 2px 8px rgba(0,0,0,0.8)",
          animation: "owllm-world-pop 1.9s ease-out both", pointerEvents: "none", zIndex: 200,
        }}>+10 XP ✨</div>
      )}

      {/* HUD top: title + XP progress to the next unlock. */}
      <div style={{ position: "absolute", top: 12, left: 14, display: "flex", alignItems: "center", gap: 10, zIndex: 210 }}>
        <div style={{
          padding: "5px 14px", borderRadius: 10, background: "rgba(8,12,22,0.82)",
          border: `1px solid ${glow}66`, color: "#fff", fontSize: 13.5, fontWeight: 900, letterSpacing: 0.4,
        }}>{scene.emoji} {scene.title}</div>
        <div style={{
          padding: "5px 12px", borderRadius: 10, background: "rgba(8,12,22,0.82)",
          border: `1px solid ${accent}55`, minWidth: 170,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, fontWeight: 800, color: "#f1c44a" }}>
            <span>⭐ {progress.xp} XP</span>
            {nextUnlock && <span style={{ color: "rgba(238,242,252,0.6)" }}>{nextUnlock.title} at {nextUnlock.unlockXp}</span>}
          </div>
          {nextUnlock && (
            <div style={{ marginTop: 3, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.12)" }}>
              <div style={{
                height: "100%", borderRadius: 2, background: `linear-gradient(90deg, ${accent}, #f1c44a)`,
                width: `${Math.min(100, (progress.xp / nextUnlock.unlockXp) * 100)}%`,
              }} />
            </div>
          )}
        </div>
      </div>

      {/* Live/idle status — makes it OBVIOUS the HQ is tied to real agentic
          runs, and never moves on its own. Top-center. */}
      <div style={{
        position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)",
        display: "flex", alignItems: "center", gap: 8, zIndex: 210,
        padding: "5px 14px", borderRadius: 999,
        background: "rgba(8,12,22,0.86)",
        border: `1px solid ${running ? glow : "rgba(255,255,255,0.18)"}`,
        color: running ? glow : "rgba(238,242,252,0.82)", fontSize: 12, fontWeight: 800, whiteSpace: "nowrap",
      }}>
        {running
          ? <>🟢 Live run — {activeCount} agent{activeCount === 1 ? "" : "s"} working</>
          : <>💤 Idle — run a team on the <b>Agentic Team</b> tab to watch it here</>}
        {!running && (
          <button
            onClick={runDemo}
            title="Play a scripted demo using the SAME event stream a real run emits"
            style={{
              marginLeft: 4, padding: "2px 10px", borderRadius: 999, border: `1px solid ${glow}88`,
              background: `${glow}22`, color: "#fff", fontSize: 11, fontWeight: 800, cursor: "pointer",
            }}
          >▶ Demo</button>
        )}
      </div>

      {/* Scene dock bottom-left. */}
      <div style={{ position: "absolute", left: 14, bottom: 12, display: "flex", gap: 6, flexWrap: "wrap", maxWidth: "55%", zIndex: 210 }}>
        {SCENES.map(sc => {
          const locked = progress.xp < sc.unlockXp;
          const sel = sc.key === scene.key;
          return (
            <button
              key={sc.key}
              onClick={() => !locked && setScene(sc.key)}
              title={locked ? `${sc.desc} — unlocks at ${sc.unlockXp} XP` : sc.desc}
              style={{
                padding: "5px 10px", borderRadius: 9, fontSize: 11, fontWeight: 800,
                border: `1px solid ${sel ? glow : "rgba(255,255,255,0.16)"}`,
                background: sel ? `${glow}2c` : "rgba(8,12,22,0.78)",
                color: locked ? "rgba(200,205,220,0.4)" : sel ? "#fff" : "rgba(238,242,252,0.85)",
                cursor: locked ? "not-allowed" : "pointer",
                boxShadow: sel ? `0 0 12px ${glow}44` : undefined,
              }}
            >{locked ? "🔒" : sc.emoji} {sc.title}</button>
          );
        })}
      </div>

      {/* Quest board bottom-right. */}
      <div style={{
        position: "absolute", right: 12, bottom: 12, width: 236, maxHeight: 190, overflow: "auto",
        background: "rgba(8,12,22,0.84)", border: `1px solid ${glow}55`, borderRadius: 12, padding: 10, zIndex: 210,
        boxShadow: "0 8px 30px rgba(0,0,0,0.45)",
      }}>
        <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: 0.8, color: "#f1c44a", marginBottom: 6 }}>📜 QUEST BOARD</div>
        {progress.quests.length === 0 && (
          <div style={{ fontSize: 11, color: "rgba(238,242,252,0.6)", lineHeight: 1.5 }}>
            Run an agentic team — completed runs land here and grant XP that unlocks new scenes.
          </div>
        )}
        {progress.quests.slice(0, 8).map((q, i) => (
          <div key={i} style={{ fontSize: 10.5, color: "rgba(238,242,252,0.85)", lineHeight: 1.6, display: "flex", justifyContent: "space-between", gap: 6 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.note}</span>
            <span style={{ color: "#f1c44a", fontWeight: 800, flexShrink: 0 }}>+{q.xp}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

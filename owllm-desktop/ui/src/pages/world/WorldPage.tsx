// WorldPage — the 2.5D RPG HQ (P0-1, Appendix A render architecture).
//
// Four layers: static background (scene art when present under
// /world/backgrounds/<key>.webp, otherwise a procedural mood-colored room
// so the HQ works before the final art lands), a navmesh (data only),
// the agent sprite layer (owl icons walking via CSS transitions), and the
// FX/bubble layer (speech bubbles, active glows, reward pops). Binds to
// the EXISTING dispatch event stream via worldBus — never a second stream.
// Progression (XP / scene unlocks / quest board) persists via worldState
// (§0.8 — survives tab unmount).

import React from "react";
import { worldSubscribe, type WorldEvent } from "./worldBus";
import { getProgress, subscribeProgress, addXp, setScene } from "./worldState";

type Scene = {
  key: string;
  title: string;
  desc: string;
  /// [sky, floor, glow] for the procedural fallback room.
  colors: [string, string, string];
  unlockXp: number;
};

// The 9 scenes from Appendix A.2. hq_loft + quest_plaza ship unlocked;
// the rest gate behind XP so progression means something.
const SCENES: Scene[] = [
  { key: "hq_loft", title: "Command Loft", desc: "Home base — glowing desks and mission boards.", colors: ["#16203a", "#232c44", "#5ac8fa"], unlockXp: 0 },
  { key: "quest_plaza", title: "Quest Plaza", desc: "Quest board, reward chest, lantern-lit paths.", colors: ["#221a33", "#322647", "#f1c44a"], unlockXp: 0 },
  { key: "server_core", title: "Server Core", desc: "GPU towers and data streams.", colors: ["#0d1f26", "#15303a", "#37e6c8"], unlockXp: 50 },
  { key: "finetune_workshop", title: "Model Forge", desc: "Dataset crates and the glowing forge.", colors: ["#241a14", "#39281c", "#ff9a3a"], unlockXp: 100 },
  { key: "research_library", title: "Archive", desc: "Tall shelves and floating documents.", colors: ["#1c1a2e", "#2b2745", "#b08aff"], unlockXp: 175 },
  { key: "debug_office", title: "Debug Office", desc: "Noir case boards and red string.", colors: ["#201418", "#33222a", "#ff6b6b"], unlockXp: 250 },
  { key: "sandbox_bunker", title: "Isolation Bunker", desc: "Reinforced glass and hazard stripes.", colors: ["#13211a", "#1f3328", "#7ff0c5"], unlockXp: 350 },
  { key: "bridge_control", title: "Bridge Control", desc: "Radio consoles and message tubes.", colors: ["#101c2c", "#1b2d44", "#4aa8ff"], unlockXp: 475 },
  { key: "arena_coliseum", title: "Arena", desc: "Two podiums and the prompt stage.", colors: ["#251322", "#3a2038", "#ff7ed1"], unlockXp: 600 },
];

// Generic navmesh (normalized 0-1, authored against the open mid/floor
// space every scene reserves — Appendix A.0). Stations are where agents
// work; waypoints are the idle-wander lattice.
const STATIONS: Array<[number, number]> = [
  [0.18, 0.62], [0.38, 0.74], [0.60, 0.66], [0.80, 0.72], [0.30, 0.50], [0.70, 0.50], [0.50, 0.82],
];
const WAYPOINTS: Array<[number, number]> = [
  [0.12, 0.78], [0.28, 0.66], [0.45, 0.78], [0.62, 0.58], [0.78, 0.80], [0.88, 0.62], [0.52, 0.62], [0.20, 0.86], [0.70, 0.86],
];

/// Best-guess owl icon for an agent name; falls back to the studio owl.
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

type SpriteState = {
  name: string;
  x: number; y: number;        // normalized targets (CSS transitions walk)
  active: boolean;
  stationIdx: number | null;
  bubble: string | null;
  bubbleAt: number;
};

const IDLE_CREW = ["orchestrator", "coder", "researcher", "critic"];

export default function WorldPage() {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => subscribeProgress(force), []);
  const progress = getProgress();
  const scene = SCENES.find(s => s.key === progress.scene) ?? SCENES[0];

  // Background art: scene file when shipped, procedural room otherwise.
  const [artOk, setArtOk] = React.useState<Record<string, boolean>>({});

  // Sprites — keyed by agent name. The idle crew always wanders; live
  // dispatch events add/activate whoever actually runs.
  const [sprites, setSprites] = React.useState<Map<string, SpriteState>>(() => {
    const m = new Map<string, SpriteState>();
    IDLE_CREW.forEach((n, i) => {
      const [x, y] = WAYPOINTS[(i * 2) % WAYPOINTS.length];
      m.set(n, { name: n, x, y, active: false, stationIdx: null, bubble: null, bubbleAt: 0 });
    });
    return m;
  });
  const [reward, setReward] = React.useState<number>(0); // increments → pop animation

  const patch = (name: string, p: Partial<SpriteState>) =>
    setSprites(prev => {
      const next = new Map(prev);
      const cur = next.get(name) ?? {
        name, x: 0.5, y: 0.8, active: false, stationIdx: null, bubble: null, bubbleAt: 0,
      };
      next.set(name, { ...cur, ...p });
      return next;
    });

  // Idle wander: every few seconds each non-active sprite strolls to a
  // random waypoint. CSS transitions do the walking.
  React.useEffect(() => {
    const iv = window.setInterval(() => {
      setSprites(prev => {
        const next = new Map(prev);
        for (const [name, s] of next) {
          if (s.active) continue;
          if (Math.random() < 0.45) {
            const [x, y] = WAYPOINTS[Math.floor(Math.random() * WAYPOINTS.length)];
            next.set(name, { ...s, x, y });
          }
        }
        return next;
      });
    }, 2800);
    return () => window.clearInterval(iv);
  }, []);

  // Bubble expiry sweep.
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

  // Bind to the existing dispatch stream (A.4 mapping).
  React.useEffect(() => {
    let stationCursor = 0;
    return worldSubscribe((e: WorldEvent) => {
      if (e.kind === "agent-start") {
        const idx = stationCursor++ % STATIONS.length;
        const [x, y] = STATIONS[idx];
        patch(e.agent, { x, y, active: true, stationIdx: idx });
      } else if (e.kind === "agent-end") {
        const [x, y] = WAYPOINTS[Math.floor(Math.random() * WAYPOINTS.length)];
        patch(e.agent, { x, y, active: false, stationIdx: null });
      } else if (e.kind === "thought") {
        const text = e.text.length > 90 ? `${e.text.slice(0, 90)}…` : e.text;
        if (text.trim()) patch(e.agent, { bubble: text, bubbleAt: Date.now() });
      } else if (e.kind === "run-finish") {
        addXp(10, "Team run completed");
        setReward(r => r + 1);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [sky, floor, glow] = scene.colors;
  const spriteList = [...sprites.values()];

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", background: sky }}>
      <style>{`
        @keyframes owllm-world-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
        @keyframes owllm-world-pop { 0% { transform: translate(-50%,-50%) scale(0.4); opacity: 0; } 25% { opacity: 1; } 100% { transform: translate(-50%,-130%) scale(1.25); opacity: 0; } }
        @keyframes owllm-world-glowpulse { 0%,100% { opacity: 0.55; } 50% { opacity: 1; } }
      `}</style>

      {/* Layer 1 — background: shipped art, else procedural room. */}
      {artOk[scene.key] !== false && (
        <img
          src={`/world/backgrounds/${scene.key}.webp`}
          onError={() => setArtOk(m => ({ ...m, [scene.key]: false }))}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
      {artOk[scene.key] === false && (
        <div style={{ position: "absolute", inset: 0 }}>
          {/* Procedural 2.5D room: sky band, glow horizon, iso floor grid. */}
          <div style={{ position: "absolute", inset: 0, background: `linear-gradient(180deg, ${sky} 0%, ${sky} 42%, ${floor} 46%, ${floor} 100%)` }} />
          <div style={{ position: "absolute", left: 0, right: 0, top: "38%", height: "12%", background: `radial-gradient(ellipse at 50% 100%, ${glow}33, transparent 70%)` }} />
          <div style={{
            position: "absolute", left: 0, right: 0, top: "46%", bottom: 0,
            backgroundImage: `repeating-linear-gradient(75deg, ${glow}14 0 2px, transparent 2px 64px), repeating-linear-gradient(-75deg, ${glow}14 0 2px, transparent 2px 64px)`,
          }} />
          {[0.12, 0.5, 0.88].map((x, i) => (
            <div key={i} style={{
              position: "absolute", left: `${x * 100}%`, top: "20%", width: 90, height: "24%",
              transform: "translateX(-50%)", borderRadius: 10,
              background: `linear-gradient(180deg, ${glow}22, transparent)`,
              border: `1px solid ${glow}44`,
              animation: "owllm-world-glowpulse 4s ease-in-out infinite",
              animationDelay: `${i * 1.2}s`,
            }} />
          ))}
        </div>
      )}

      {/* Layer 3 — agent sprites walking the navmesh. */}
      {spriteList.map(s => (
        <div key={s.name} style={{
          position: "absolute",
          left: `${s.x * 100}%`, top: `${s.y * 100}%`,
          transform: "translate(-50%, -100%)",
          transition: "left 1.6s ease-in-out, top 1.6s ease-in-out",
          textAlign: "center", width: 120, marginLeft: -2, pointerEvents: "none",
        }}>
          {/* Layer 4 — bubble + glow FX ride with the sprite. */}
          {s.bubble && (
            <div style={{
              marginBottom: 6, padding: "5px 9px", borderRadius: 9,
              background: "rgba(10,14,24,0.88)", border: `1px solid ${glow}66`,
              color: "#e8ecf8", fontSize: 10.5, lineHeight: 1.4, textAlign: "left",
              maxHeight: 64, overflow: "hidden",
            }}>{s.bubble}</div>
          )}
          <div style={{
            display: "inline-block",
            filter: s.active ? `drop-shadow(0 0 10px ${glow})` : "drop-shadow(0 4px 6px rgba(0,0,0,0.5))",
            animation: s.active ? "owllm-world-bob 0.9s ease-in-out infinite" : undefined,
          }}>
            <img src={iconFor(s.name)} style={{ width: 52, height: 52, objectFit: "contain" }} />
          </div>
          <div style={{ fontSize: 10, fontWeight: 800, color: s.active ? glow : "rgba(232,236,248,0.75)", textShadow: "0 1px 3px rgba(0,0,0,0.8)" }}>
            {s.name}{s.active ? " ⚙" : ""}
          </div>
        </div>
      ))}

      {/* Reward pop on run finish. */}
      {reward > 0 && (
        <div key={reward} style={{
          position: "absolute", left: "50%", top: "45%",
          transform: "translate(-50%,-50%)",
          fontSize: 30, fontWeight: 900, color: "#f1c44a",
          textShadow: "0 2px 10px rgba(0,0,0,0.7)",
          animation: "owllm-world-pop 1.8s ease-out both", pointerEvents: "none",
        }}>+10 XP ✨</div>
      )}

      {/* HUD: XP + scene picker (locked scenes show their threshold). */}
      <div style={{ position: "absolute", top: 10, left: 12, right: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{
          padding: "4px 12px", borderRadius: 999, background: "rgba(10,14,24,0.8)",
          border: `1px solid ${glow}66`, color: "#f1c44a", fontSize: 12.5, fontWeight: 800,
        }}>⭐ {progress.xp} XP</div>
        {SCENES.map(sc => {
          const locked = progress.xp < sc.unlockXp;
          const sel = sc.key === scene.key;
          return (
            <button
              key={sc.key}
              onClick={() => !locked && setScene(sc.key)}
              title={locked ? `${sc.desc} — unlocks at ${sc.unlockXp} XP` : sc.desc}
              style={{
                padding: "4px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700,
                border: `1px solid ${sel ? glow : "rgba(255,255,255,0.18)"}`,
                background: sel ? `${glow}26` : "rgba(10,14,24,0.7)",
                color: locked ? "rgba(200,205,220,0.45)" : sel ? "#fff" : "rgba(232,236,248,0.85)",
                cursor: locked ? "not-allowed" : "pointer",
              }}
            >{locked ? `🔒 ${sc.title}` : sc.title}</button>
          );
        })}
      </div>

      {/* Quest board (Slice 4): recent completed runs. */}
      <div style={{
        position: "absolute", right: 12, bottom: 12, width: 240, maxHeight: 200, overflow: "auto",
        background: "rgba(10,14,24,0.82)", border: `1px solid ${glow}55`, borderRadius: 10, padding: 10,
      }}>
        <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: 0.8, color: "#f1c44a", marginBottom: 6 }}>📜 QUEST BOARD</div>
        {progress.quests.length === 0 && (
          <div style={{ fontSize: 11, color: "rgba(232,236,248,0.6)", lineHeight: 1.5 }}>
            Run an agentic team — every completed run lands here and grants XP that unlocks new scenes.
          </div>
        )}
        {progress.quests.slice(0, 8).map((q, i) => (
          <div key={i} style={{ fontSize: 10.5, color: "rgba(232,236,248,0.85)", lineHeight: 1.6, display: "flex", justifyContent: "space-between", gap: 6 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.note}</span>
            <span style={{ color: "#f1c44a", fontWeight: 800, flexShrink: 0 }}>+{q.xp}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// 3D knowledge graph of the shared team memory (the RAG brain).
//
// Each memory entry is a node; each distinct tag is a hub node, and an entry
// links to every tag it carries — so entries that share tags pull into visible
// clusters. Entries upserted under the same `key` also link directly. Rotate /
// zoom / drag; click a node to read it.
//
// This module pulls in three.js via react-force-graph-3d, so it is LAZY-loaded
// by TeamMemoryModal (React.lazy) — the WebGL bundle only loads when the user
// opens the graph, and it's bundled (not CDN) so it still works offline.

import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
// three.js ships transitively with react-force-graph-3d (its own docs import it
// the same way); we use it for the always-visible label sprites below. The
// transitive install carries no bundled type declarations and @types/three is
// not a dep, so import it untyped — same loose-third-party stance as the FG cast.
// @ts-ignore: no type declarations for the transitive `three` install
import * as THREE from "three";

// react-force-graph-3d's prop types are loose; cast to keep our tsc strict-clean.
const FG = ForceGraph3D as unknown as (props: any) => JSX.Element;

export type MemEntry = {
  id: number;
  key: string;
  content: string;
  tags: string;
  author: string;
  ts: number;
  kind: string; // 'fact' | 'worklog'
};

type GNode = {
  id: string;
  kind: "entry" | "tag";
  label: string;
  content?: string;
  ekey?: string;
  tags?: string;
  author?: string;
  ekind?: string; // entry nodes: 'fact' | 'worklog'
  color?: string;
  val: number;
  x?: number; y?: number; z?: number;
};

function splitTags(s: string): string[] {
  return (s || "").split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
}

// Stable per-tag palette so each tag hub (and the fact entries around it) keeps
// one recognizable hue across reopens — clusters read as clusters, not confetti.
const TAG_PALETTE = ["#ffcf5a", "#6fe3a5", "#ff9ad9", "#7fd4ff", "#ffb37f", "#c9a6ff", "#9be37f", "#ff8c8c", "#5ad9cf", "#e3d06f"];
function tagColor(tag: string): string {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return TAG_PALETTE[h % TAG_PALETTE.length];
}

const FACT_COLOR = "#4da3ff";
const WORKLOG_COLOR = "#6b7688";

const NODE_REL_SIZE = 4;
const LABEL_WORLD_H = 7; // world-space height of a label sprite

// Build (and cache) a SpriteMaterial carrying the rendered label as a canvas
// texture. Cached by the exact label string so duplicate labels share one
// texture/material — but callers must still wrap each use in a FRESH Sprite
// (an Object3D can only have one parent).
type LabelMat = { mat: THREE.SpriteMaterial; aspect: number };
function makeLabelMaterial(cache: Map<string, LabelMat>, text: string): LabelMat {
  const hit = cache.get(text);
  if (hit) return hit;
  const fontPx = 64;
  const padX = 16;
  const padY = 10;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = `600 ${fontPx}px -apple-system, system-ui, "Segoe UI", sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + padX * 2;
  const h = fontPx + padY * 2;
  canvas.width = w;
  canvas.height = h;
  ctx.font = font; // resizing the canvas resets the context, so re-apply
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // subtle dark backing so text stays legible over bright nodes
  ctx.fillStyle = "rgba(6,8,13,0.55)";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#e8eef8";
  ctx.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true; // ensure the GPU uploads the drawn canvas (blank-sprite guard)
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const entry: LabelMat = { mat, aspect: w / h };
  cache.set(text, entry);
  return entry;
}

export default function TeamMemoryGraph({ entries }: { entries: MemEntry[] }) {
  const fgRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const labelCache = useRef<Map<string, LabelMat>>(new Map());
  const [dim, setDim] = useState({ w: 800, h: 520 });
  const [selected, setSelected] = useState<GNode | null>(null);
  // Worklog rows carry no tag/key, so they float as unconnected confetti around
  // the real knowledge cluster. Default the graph to facts-only (the connected
  // brain); the toggle below reveals the worklog transcript on demand.
  const [showWorklog, setShowWorklog] = useState(false);

  // Always-visible label sprite per node (kept ALONGSIDE the default sphere via
  // nodeThreeObjectExtend). Fresh Sprite per call; material/texture is cached.
  const nodeThreeObject = (n: GNode) => {
    const text = n.kind === "tag" ? `🏷 ${n.label}` : n.label;
    const { mat, aspect } = makeLabelMaterial(labelCache.current, text);
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(LABEL_WORLD_H * aspect, LABEL_WORLD_H, 1);
    const radius = Math.cbrt(Math.max(1, n.val)) * NODE_REL_SIZE;
    sprite.position.set(0, radius + LABEL_WORLD_H * 0.7, 0); // float above the sphere
    sprite.renderOrder = 999; // draw on top of node geometry
    return sprite;
  };

  // Track the container size so the canvas fills it (and reflows on resize).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => setDim({ w: el.clientWidth || 800, h: el.clientHeight || 520 });
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const worklogCount = useMemo(
    () => entries.reduce((n, e) => n + (e.kind === "worklog" ? 1 : 0), 0),
    [entries],
  );
  const visibleEntries = useMemo(
    () => (showWorklog ? entries : entries.filter((e) => e.kind !== "worklog")),
    [entries, showWorklog],
  );

  const data = useMemo(() => {
    const nodes: GNode[] = [];
    const links: { source: string; target: string; kind: string }[] = [];
    const tagDegree = new Map<string, number>();
    const byKey = new Map<string, string>(); // key -> first entry node id

    for (const e of visibleEntries) {
      const nid = `e:${e.id}`;
      const isWorklog = e.kind === "worklog";
      const label = (e.key && e.key.trim()) || e.content.slice(0, 48) + (e.content.length > 48 ? "…" : "");
      const firstTag = splitTags(e.tags).find((t) => t.toLowerCase() !== "worklog");
      nodes.push({
        id: nid, kind: "entry", label,
        content: e.content, ekey: e.key, tags: e.tags, author: e.author, ekind: e.kind,
        // Facts inherit their first tag's cluster colour; untagged facts stay
        // blue; worklog rows recede to gray so the knowledge base pops.
        color: isWorklog ? WORKLOG_COLOR : firstTag ? tagColor(firstTag) : FACT_COLOR,
        val: isWorklog ? 1.6 : 2.5,
      });
      for (const tg of splitTags(e.tags)) {
        if (tg.toLowerCase() === "worklog") continue; // synthetic tag — a hub of ALL worklog rows is noise
        const tid = `t:${tg.toLowerCase()}`;
        tagDegree.set(tid, (tagDegree.get(tid) ?? 0) + 1);
        links.push({ source: nid, target: tid, kind: "tag" });
      }
      // Link entries that share a key (e.g. successive edits of 'build_command').
      const k = (e.key || "").trim().toLowerCase();
      if (k) {
        const prev = byKey.get(k);
        if (prev) links.push({ source: prev, target: nid, kind: "key" });
        else byKey.set(k, nid);
      }
    }
    for (const [tid, deg] of tagDegree) {
      nodes.push({ id: tid, kind: "tag", label: tid.slice(2), color: tagColor(tid.slice(2)), val: 4 + deg * 2.5 });
    }
    return { nodes, links };
  }, [visibleEntries]);

  const focus = (n: GNode) => {
    setSelected(n);
    const fg = fgRef.current;
    if (fg && typeof n.x === "number") {
      const d = 90;
      const r = 1 + d / (Math.hypot(n.x, n.y ?? 0, n.z ?? 0) || 1);
      fg.cameraPosition({ x: (n.x) * r, y: (n.y ?? 0) * r, z: (n.z ?? 0) * r }, n, 1400);
    }
  };

  const empty = data.nodes.length === 0;

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      {empty ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--fg-muted)", fontSize: 13, textAlign: "center", padding: "0 24px" }}>
          {worklogCount > 0 && !showWorklog
            ? "No durable facts to graph yet — toggle “Show worklog” to see recent agent activity."
            : "No memory to graph yet — agents (and you) add notes as the team works."}
        </div>
      ) : (
        <FG
          ref={fgRef}
          graphData={data}
          width={dim.w}
          height={dim.h}
          backgroundColor="rgba(0,0,0,0)"
          showNavInfo={false}
          nodeRelSize={NODE_REL_SIZE}
          nodeVal={(n: GNode) => n.val}
          nodeColor={(n: GNode) => n.color || (n.kind === "tag" ? "#ffcf5a" : FACT_COLOR)}
          nodeOpacity={0.9}
          nodeLabel={(n: GNode) => (n.kind === "tag" ? `🏷 ${n.label}` : (n.content || n.label))}
          nodeThreeObjectExtend={true}
          nodeThreeObject={nodeThreeObject}
          linkColor={(l: any) => (l.kind === "key" ? "#ff9ad9" : "#9db4dc")}
          linkWidth={(l: any) => (l.kind === "key" ? 2.2 : 1.2)}
          linkOpacity={0.9}
          linkDirectionalParticles={0}
          warmupTicks={40}
          cooldownTime={4000}
          onNodeClick={(n: GNode) => focus(n)}
          onBackgroundClick={() => setSelected(null)}
        />
      )}

      {/* Facts-only ↔ show-worklog toggle (only when worklog rows exist). Kept
          OUTSIDE the !empty gate so a worklog-only project can still un-hide. */}
      {worklogCount > 0 && (
        <button
          onClick={() => setShowWorklog((v) => !v)}
          title={showWorklog
            ? "Hide the worklog transcript — show only the durable knowledge (facts)"
            : "Also show the auto-captured worklog transcript (unconnected recent-activity rows)"}
          style={{
            position: "absolute", left: 10, top: 10, height: 28, padding: "0 11px",
            border: "1px solid var(--border-strong)", borderRadius: 7, cursor: "pointer",
            fontSize: 11.5, fontWeight: 600,
            background: showWorklog ? "rgba(var(--accent-rgb),0.18)" : "rgba(6,8,13,0.6)",
            color: showWorklog ? "var(--accent)" : "var(--fg-muted)",
          }}
        >{showWorklog ? "📋 Worklog shown — hide" : `📋 Show worklog (${worklogCount})`}</button>
      )}

      {/* Legend */}
      {!empty && (
        <div style={{ position: "absolute", left: 10, bottom: 10, display: "flex", gap: 12, fontSize: 11, color: "var(--fg-muted)", background: "rgba(6,8,13,0.6)", padding: "5px 9px", borderRadius: 7, pointerEvents: "none" }}>
          <span><span style={{ color: FACT_COLOR }}>●</span> fact (colored by tag)</span>
          {showWorklog && <span><span style={{ color: WORKLOG_COLOR }}>●</span> worklog</span>}
          <span><span style={{ color: "#ffcf5a" }}>●</span> tag hub</span>
          <span><span style={{ color: "#ff9ad9" }}>—</span> same key</span>
        </div>
      )}

      {/* Inspector for the clicked node */}
      {selected && (
        <div style={{
          position: "absolute", right: 10, top: 10, width: 280, maxHeight: "80%", overflowY: "auto",
          background: "var(--bg-panel)", border: "1px solid var(--border-strong)", borderRadius: 10,
          padding: "12px 14px", boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: selected.kind === "tag" ? "#ffcf5a" : selected.ekind === "worklog" ? WORKLOG_COLOR : FACT_COLOR, textTransform: "uppercase", letterSpacing: 0.5 }}>
              {selected.kind === "tag" ? "🏷 Tag" : selected.ekind === "worklog" ? "📋 Worklog" : "🧠 Fact"}
            </span>
            <div style={{ flex: 1 }} />
            <button onClick={() => setSelected(null)} style={{ width: 22, height: 22, padding: 0, border: "none", borderRadius: 5, background: "rgba(255,255,255,0.06)", color: "var(--fg)", cursor: "pointer", fontSize: 12 }}>✕</button>
          </div>
          {selected.kind === "tag" ? (
            <div style={{ fontSize: 13, color: "var(--fg)" }}>{selected.label}</div>
          ) : (
            <>
              {selected.ekey && <div style={{ display: "inline-block", fontSize: 10, fontWeight: 700, color: "var(--accent)", background: "rgba(var(--accent-rgb),0.12)", borderRadius: 5, padding: "1px 6px", marginBottom: 6 }}>{selected.ekey}</div>}
              <div style={{ fontSize: 12.5, color: "var(--fg)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{selected.content}</div>
              {selected.tags && <div style={{ fontSize: 10, color: "var(--fg-muted)", marginTop: 8 }}>🏷 {selected.tags}</div>}
              {selected.author && <div style={{ fontSize: 10, color: "var(--fg-muted)", marginTop: 2 }}>✍ {selected.author}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

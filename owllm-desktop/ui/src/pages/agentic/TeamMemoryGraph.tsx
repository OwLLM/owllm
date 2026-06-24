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

// react-force-graph-3d's prop types are loose; cast to keep our tsc strict-clean.
const FG = ForceGraph3D as unknown as (props: any) => JSX.Element;

export type MemEntry = {
  id: number;
  key: string;
  content: string;
  tags: string;
  author: string;
  ts: number;
};

type GNode = {
  id: string;
  kind: "entry" | "tag";
  label: string;
  content?: string;
  ekey?: string;
  tags?: string;
  author?: string;
  val: number;
  x?: number; y?: number; z?: number;
};

function splitTags(s: string): string[] {
  return (s || "").split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
}

export default function TeamMemoryGraph({ entries }: { entries: MemEntry[] }) {
  const fgRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dim, setDim] = useState({ w: 800, h: 520 });
  const [selected, setSelected] = useState<GNode | null>(null);

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

  const data = useMemo(() => {
    const nodes: GNode[] = [];
    const links: { source: string; target: string; kind: string }[] = [];
    const tagDegree = new Map<string, number>();
    const byKey = new Map<string, string>(); // key -> first entry node id

    for (const e of entries) {
      const nid = `e:${e.id}`;
      const label = (e.key && e.key.trim()) || e.content.slice(0, 48) + (e.content.length > 48 ? "…" : "");
      nodes.push({
        id: nid, kind: "entry", label,
        content: e.content, ekey: e.key, tags: e.tags, author: e.author, val: 2.5,
      });
      for (const tg of splitTags(e.tags)) {
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
      nodes.push({ id: tid, kind: "tag", label: tid.slice(2), val: 4 + deg * 2.5 });
    }
    return { nodes, links };
  }, [entries]);

  const focus = (n: GNode) => {
    setSelected(n);
    const fg = fgRef.current;
    if (fg && typeof n.x === "number") {
      const d = 90;
      const r = 1 + d / (Math.hypot(n.x, n.y ?? 0, n.z ?? 0) || 1);
      fg.cameraPosition({ x: (n.x) * r, y: (n.y ?? 0) * r, z: (n.z ?? 0) * r }, n, 1400);
    }
  };

  const empty = entries.length === 0;

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      {empty ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--fg-muted)", fontSize: 13 }}>
          No memory to graph yet — agents (and you) add notes as the team works.
        </div>
      ) : (
        <FG
          ref={fgRef}
          graphData={data}
          width={dim.w}
          height={dim.h}
          backgroundColor="rgba(0,0,0,0)"
          showNavInfo={false}
          nodeRelSize={4}
          nodeVal={(n: GNode) => n.val}
          nodeColor={(n: GNode) => (n.kind === "tag" ? "#ffcf5a" : "#4da3ff")}
          nodeOpacity={0.9}
          nodeLabel={(n: GNode) => (n.kind === "tag" ? `🏷 ${n.label}` : (n.content || n.label))}
          linkColor={(l: any) => (l.kind === "key" ? "rgba(255,154,217,0.5)" : "rgba(120,150,200,0.32)")}
          linkWidth={(l: any) => (l.kind === "key" ? 1.2 : 0.5)}
          linkDirectionalParticles={0}
          warmupTicks={40}
          cooldownTime={4000}
          onNodeClick={(n: GNode) => focus(n)}
          onBackgroundClick={() => setSelected(null)}
        />
      )}

      {/* Legend */}
      {!empty && (
        <div style={{ position: "absolute", left: 10, bottom: 10, display: "flex", gap: 12, fontSize: 11, color: "var(--fg-muted)", background: "rgba(6,8,13,0.6)", padding: "5px 9px", borderRadius: 7, pointerEvents: "none" }}>
          <span><span style={{ color: "#4da3ff" }}>●</span> memory</span>
          <span><span style={{ color: "#ffcf5a" }}>●</span> tag</span>
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
            <span style={{ fontSize: 11, fontWeight: 700, color: selected.kind === "tag" ? "#ffcf5a" : "#4da3ff", textTransform: "uppercase", letterSpacing: 0.5 }}>
              {selected.kind === "tag" ? "🏷 Tag" : "🧠 Memory"}
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

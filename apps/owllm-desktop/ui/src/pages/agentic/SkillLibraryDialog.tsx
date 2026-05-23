// SkillLibraryDialog — modal port of LLM/desktop_app/widgets/skill_library_dialog.py.
//
// Lets the user pick a curated source (Anthropic + obra/superpowers
// + custom git URL), git-clones it via the Tauri side, walks for
// SKILL.md files, and lets them install one or many into
// LLM/data/skills/ with Anthropic→OWLLM tool-name aliasing applied.
//
// The Rust side (skill_library.rs) owns the filesystem + git logic.
// This component is purely presentational + dispatching.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type SkillSource = {
  key: string;
  label: string;
  git_url: string;
  description: string;
  skills_subpath: string;
};

type DiscoveredSkill = {
  source_key: string;
  relative_dir: string;
  name: string;
  description: string;
  skill_md_path: string;
  installed: boolean;
};

type Filter = "all" | "available" | "installed";

type Props = {
  open: boolean;
  onClose: () => void;
  /// Fired after a successful install/uninstall so the parent (Studio)
  /// can refresh its agent list to surface the new SKILL.md packs.
  onChange?: () => void;
};

export default function SkillLibraryDialog({ open, onClose, onChange }: Props) {
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [pickerIdx, setPickerIdx] = useState<number>(0);
  const [customUrl, setCustomUrl] = useState<string>("");
  const [customKey, setCustomKey] = useState<string>("");

  const [skills, setSkills] = useState<DiscoveredSkill[]>([]);
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());  // relative_dir set
  const [preview, setPreview] = useState<DiscoveredSkill | null>(null);
  const [previewText, setPreviewText] = useState<string>("");
  const [query, setQuery] = useState<string>("");
  const [filter, setFilter] = useState<Filter>("all");

  const aborted = useRef(false);

  // Load curated source list when the dialog opens.
  useEffect(() => {
    if (!open) return;
    aborted.current = false;
    setStatus("");
    setSkills([]);
    setSelected(new Set());
    setPreview(null);
    setPreviewText("");
    (async () => {
      try {
        const list = await invoke<SkillSource[]>("list_skill_sources");
        if (aborted.current) return;
        setSources(list);
      } catch (e) {
        setStatus(`Failed to list sources: ${e}`);
      }
    })();
    return () => { aborted.current = true; };
  }, [open]);

  const isCustom = pickerIdx === sources.length;
  const currentSource: SkillSource | null = useMemo(() => {
    if (sources.length === 0) return null;
    if (!isCustom) return sources[pickerIdx] ?? null;
    if (!customUrl.trim() || !customKey.trim()) return null;
    return {
      key: customKey.trim(),
      label: `Custom: ${customUrl.trim()}`,
      git_url: customUrl.trim(),
      description: "",
      skills_subpath: "",
    };
  }, [sources, pickerIdx, isCustom, customUrl, customKey]);

  const onPreview = async (skill: DiscoveredSkill) => {
    setPreview(skill);
    setPreviewText("Loading…");
    try {
      const txt = await invoke<string>("read_skill_md", { path: skill.skill_md_path });
      setPreviewText(txt);
    } catch (e) {
      setPreviewText(`Failed to read: ${e}`);
    }
  };

  const onFetch = async (force: boolean) => {
    if (!currentSource) {
      setStatus("Pick a source or paste a custom git URL first.");
      return;
    }
    setBusy(true);
    setStatus(`Fetching ${currentSource.label}…`);
    try {
      await invoke("fetch_skill_source", {
        key: currentSource.key,
        gitUrl: currentSource.git_url,
        force,
      });
      const found = await invoke<DiscoveredSkill[]>("discover_skills", { key: currentSource.key });
      setSkills(found);
      setSelected(new Set());
      setStatus(found.length === 0 ? "No SKILL.md files found in this source." : `Found ${found.length} skills.`);
    } catch (e: any) {
      setStatus(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter(s => {
      if (filter === "installed" && !s.installed) return false;
      if (filter === "available" && s.installed) return false;
      if (q) {
        const blob = `${s.name} ${s.description} ${s.relative_dir}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [skills, query, filter]);

  const toggleSelect = (rel: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel); else next.add(rel);
      return next;
    });
  };
  const setAllVisible = (on: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      for (const s of filteredSkills) {
        if (on) next.add(s.relative_dir); else next.delete(s.relative_dir);
      }
      return next;
    });
  };

  const installSelected = async () => {
    if (!currentSource || selected.size === 0) return;
    setBusy(true);
    let okCount = 0;
    const errs: string[] = [];
    for (const rel of selected) {
      const skill = skills.find(s => s.relative_dir === rel);
      if (!skill) continue;
      setStatus(`Installing ${skill.name}…`);
      try {
        await invoke("install_skill", { sourceKey: currentSource.key, relativeDir: rel });
        okCount++;
      } catch (e: any) {
        errs.push(`${skill.name}: ${e?.message ?? e}`);
      }
    }
    // Re-discover to refresh installed flags.
    try {
      const found = await invoke<DiscoveredSkill[]>("discover_skills", { key: currentSource.key });
      setSkills(found);
    } catch { /* keep the old list */ }
    setSelected(new Set());
    setStatus(errs.length === 0
      ? `Installed ${okCount} skill${okCount === 1 ? "" : "s"}.`
      : `Installed ${okCount}, ${errs.length} failed: ${errs.join("; ")}`);
    setBusy(false);
    onChange?.();
  };

  const uninstall = async (skill: DiscoveredSkill) => {
    const folder = `${skill.source_key}__${skill.relative_dir.split("/").pop() ?? ""}`;
    if (!confirm(`Remove installed skill '${skill.name}'?\nThis deletes LLM/data/skills/${folder}/.`)) return;
    setBusy(true);
    setStatus(`Removing ${skill.name}…`);
    try {
      await invoke("uninstall_skill", { folderName: folder });
      const found = await invoke<DiscoveredSkill[]>("discover_skills", { key: currentSource!.key });
      setSkills(found);
      setStatus(`Removed ${skill.name}.`);
    } catch (e: any) {
      setStatus(`Uninstall failed: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
      onChange?.();
    }
  };

  if (!open) return null;

  // Backdrop closes on click; the dialog stops propagation so clicks
  // inside don't bubble out.
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(6,8,13,0.72)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "min(1100px, 92vw)", height: "min(720px, 88vh)",
          background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: 14, padding: 18,
          display: "flex", flexDirection: "column", gap: 10,
          boxShadow: "0 24px 60px rgba(0,0,0,0.7)",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: "var(--fg-strong)", flex: 1 }}>📚 Skill Library</div>
          <button
            onClick={onClose}
            title="Close"
            style={{ width: 32, height: 32, border: "none", background: "var(--bg-surface)", color: "var(--fg)", borderRadius: 8, fontSize: 16, cursor: "pointer" }}
          >✕</button>
        </div>
        <div style={{ color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.5 }}>
          Install community SKILL.md packs from curated git sources. Anthropic-style tool names (<code>Read</code>, <code>Bash</code>, …) are rewritten to OWLLM equivalents (<code>read_file</code>, <code>shell</code>, …) on install.
        </div>

        {/* Source picker row */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "var(--fg-muted)", letterSpacing: 0.6, textTransform: "uppercase" }}>Source</span>
          <select
            value={pickerIdx}
            onChange={e => setPickerIdx(parseInt(e.target.value, 10))}
            style={{
              flex: 1, height: 32, padding: "0 12px",
              borderRadius: 8, border: "1px solid var(--border)",
              background: "var(--bg-input)", color: "var(--fg-strong)", fontSize: 13,
            }}
          >
            {sources.map((s, i) => (
              <option key={s.key} value={i}>{s.label}</option>
            ))}
            <option value={sources.length}>➕ Custom git URL…</option>
          </select>
          <button
            disabled={busy || !currentSource}
            onClick={() => onFetch(false)}
            title="Clone or fast-forward the source"
            style={{
              height: 32, padding: "0 14px", border: "none", borderRadius: 8,
              background: busy || !currentSource ? "rgba(var(--accent-rgb),0.25)" : "var(--accent)",
              color: busy || !currentSource ? "#9aa0a6" : "#fff", fontSize: 12, fontWeight: 600,
              cursor: busy || !currentSource ? "not-allowed" : "pointer",
            }}
          >Fetch / refresh</button>
          <button
            disabled={busy || !currentSource}
            onClick={() => onFetch(true)}
            title="Wipe the local clone and re-clone from scratch"
            style={{
              height: 32, padding: "0 12px", border: "none", borderRadius: 8,
              background: "var(--bg-surface)", color: "var(--fg)", fontSize: 11,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >Force re-clone</button>
        </div>

        {/* Custom URL inputs (only when "Custom" picked) */}
        {isCustom && (
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={customKey}
              onChange={e => setCustomKey(e.target.value)}
              placeholder="local folder key (e.g. myteam)"
              style={{ width: 220, height: 32, padding: "0 10px", borderRadius: 8, background: "var(--bg-input)", color: "var(--fg-strong)", fontSize: 13, border: "1px solid var(--border)" }}
            />
            <input
              value={customUrl}
              onChange={e => setCustomUrl(e.target.value)}
              placeholder="https://github.com/owner/repo.git"
              style={{ flex: 1, height: 32, padding: "0 10px", borderRadius: 8, background: "var(--bg-input)", color: "var(--fg-strong)", fontSize: 13, border: "1px solid var(--border)" }}
            />
          </div>
        )}

        {/* Source description */}
        {currentSource?.description && (
          <div style={{ color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.4 }}>{currentSource.description}</div>
        )}

        {/* Status line */}
        {status && (
          <div style={{
            color: status.toLowerCase().includes("fail") || status.toLowerCase().includes("error")
              ? "#ff8c8c" : "#ffd97a",
            fontSize: 12,
          }}>{status}</div>
        )}

        {/* Filter row */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by name, description, or path…"
            style={{ flex: 1, height: 32, padding: "0 10px", borderRadius: 8, background: "var(--bg-input)", color: "var(--fg-strong)", fontSize: 13, border: "1px solid var(--border)" }}
          />
          {(["all", "available", "installed"] as Filter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                height: 32, padding: "0 12px", borderRadius: 8,
                border: filter === f ? "1px solid rgba(var(--accent-rgb),0.55)" : "1px solid var(--border)",
                background: filter === f ? "rgba(var(--accent-rgb),0.10)" : "transparent",
                color: filter === f ? "var(--accent)" : "#9aa0a6",
                fontSize: 12, fontWeight: 600, cursor: "pointer", textTransform: "capitalize",
              }}
            >{f}</button>
          ))}
        </div>

        {/* Splitter: list left, preview right */}
        <div style={{ flex: 1, display: "flex", gap: 10, minHeight: 0 }}>
          <div style={{
            flex: 1, minWidth: 0, overflow: "auto",
            display: "flex", flexDirection: "column", gap: 6,
            background: "var(--bg-elevated)", border: "1px solid var(--border)",
            borderRadius: 8, padding: 8,
          }}>
            {filteredSkills.length === 0 ? (
              <div style={{ color: "var(--fg-subtle)", fontSize: 12, padding: 12, textAlign: "center" }}>
                {skills.length === 0
                  ? "Click Fetch / refresh to clone this source and discover skills."
                  : "No skills match the current filter."}
              </div>
            ) : filteredSkills.map(s => (
              <SkillRow
                key={s.relative_dir}
                skill={s}
                selected={selected.has(s.relative_dir)}
                onToggle={() => toggleSelect(s.relative_dir)}
                onPreview={() => onPreview(s)}
                isPreviewing={preview?.relative_dir === s.relative_dir}
                onUninstall={() => uninstall(s)}
              />
            ))}
          </div>
          <div style={{
            flex: 1, minWidth: 0,
            background: "var(--bg-elevated)", border: "1px solid var(--border)",
            borderRadius: 8, padding: 12,
            display: "flex", flexDirection: "column", gap: 6,
          }}>
            <div style={{ color: "var(--fg-strong)", fontSize: 14, fontWeight: 600 }}>
              {preview ? preview.name : "Click a skill to preview its SKILL.md"}
            </div>
            {preview && (
              <div style={{ color: "var(--fg-subtle)", fontSize: 11, fontFamily: "Consolas, monospace", wordBreak: "break-all" }}>
                {preview.relative_dir}
              </div>
            )}
            <pre style={{
              flex: 1, margin: 0, overflow: "auto",
              background: "var(--bg-elevated)", color: "var(--fg)",
              borderRadius: 6, padding: 10,
              fontFamily: "Consolas, monospace", fontSize: 12,
              whiteSpace: "pre-wrap", lineHeight: 1.5,
            }}>{previewText || (preview ? "" : "(no skill selected)")}</pre>
          </div>
        </div>

        {/* Action row */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            disabled={busy || filteredSkills.length === 0}
            onClick={() => setAllVisible(true)}
            style={{ height: 32, padding: "0 12px", border: "none", borderRadius: 8, background: "var(--bg-surface)", color: "var(--fg)", fontSize: 12, cursor: "pointer" }}
          >Select all visible</button>
          <button
            disabled={busy || selected.size === 0}
            onClick={() => setAllVisible(false)}
            style={{ height: 32, padding: "0 12px", border: "none", borderRadius: 8, background: "var(--bg-surface)", color: "var(--fg)", fontSize: 12, cursor: "pointer" }}
          >Select none</button>
          <div style={{ flex: 1 }} />
          <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>{selected.size} selected</div>
          <button
            disabled={busy || selected.size === 0}
            onClick={installSelected}
            style={{
              height: 36, padding: "0 18px", border: "none", borderRadius: 8,
              background: busy || selected.size === 0 ? "rgba(36,170,90,0.30)" : "#24aa5a",
              color: busy || selected.size === 0 ? "#9aa0a6" : "#fff",
              fontSize: 13, fontWeight: 700,
              cursor: busy || selected.size === 0 ? "not-allowed" : "pointer",
            }}
          >Install selected</button>
        </div>
      </div>
    </div>
  );
}

function SkillRow({
  skill, selected, onToggle, onPreview, isPreviewing, onUninstall,
}: {
  skill: DiscoveredSkill;
  selected: boolean;
  onToggle: () => void;
  onPreview: () => void;
  isPreviewing: boolean;
  onUninstall: () => void;
}) {
  return (
    <div
      onClick={onPreview}
      style={{
        background: isPreviewing ? "rgba(var(--accent-rgb),0.10)" : "var(--bg-elevated)",
        border: isPreviewing ? "1px solid rgba(var(--accent-rgb),0.45)" : "1px solid var(--border)",
        borderRadius: 8, padding: "10px 12px",
        cursor: "pointer",
        display: "flex", flexDirection: "column", gap: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          onClick={e => e.stopPropagation()}
          style={{ width: 14, height: 14, accentColor: "var(--accent)", flexShrink: 0 }}
        />
        <div style={{ flex: 1, minWidth: 0, color: "var(--fg-strong)", fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{skill.name}</div>
        {skill.installed && (
          <>
            <span style={{ color: "#7eebac", background: "rgba(126,235,172,0.12)", borderRadius: 6, padding: "2px 8px", fontSize: 10, fontWeight: 600, letterSpacing: 0.5 }}>INSTALLED</span>
            <button
              onClick={e => { e.stopPropagation(); onUninstall(); }}
              title="Remove this installed skill"
              style={{ width: 24, height: 24, padding: 0, border: "none", background: "rgba(255,140,140,0.10)", color: "#ff8c8c", borderRadius: 5, fontSize: 12, cursor: "pointer" }}
            >🗑</button>
          </>
        )}
      </div>
      {skill.description && (
        <div style={{ color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.4, paddingLeft: 22, maxHeight: 38, overflow: "hidden" }}>{skill.description}</div>
      )}
      <div style={{ color: "var(--fg-dim)", fontSize: 11, fontStyle: "italic", paddingLeft: 22, fontFamily: "Consolas, monospace" }}>{skill.relative_dir}</div>
    </div>
  );
}

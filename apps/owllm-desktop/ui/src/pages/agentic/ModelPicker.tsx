// ModelPicker — sectioned popover that replaces the plain <select>
// used to pick agent / team models. Sections + visual style match
// the legacy PySide6 dropdown the user prefers:
//
//   LOCAL       (blue)   — every .gguf in LLM/models/
//   ANTHROPIC   (orange) — Claude models in two flavours: (subscription)
//                          backed by the Claude Code CLI; (API) backed
//                          by ANTHROPIC_API_KEY. The latter dims when
//                          no key is saved.
//   OPENAI      (green)  — same pattern for GPT models.
//   OTHER       (cyan)   — Auto-routing pseudo-models. Resolved in
//                          the dispatch loop at call time.
//
// Selection encodes the route as a prefix on the id string so the
// dispatch can route precisely:
//
//   "<gguf-name>"             — local
//   "claude-opus-4-7"         — Anthropic, sub first then API fallback
//   "sub/claude-opus-4-7"     — Anthropic subscription only (CLI)
//   "api/claude-opus-4-7"     — Anthropic API key only
//   "openai/<id>" same shape
//   "auto/cheapest" etc       — Auto routing
import { useEffect, useRef, useState } from "react";

export type ModelInfo = {
  model_id: string;
  port: number | null;
  base_model: string | null;
  size_mib: number | null;
  provider: string;
};

export type AccountsStatusLite = {
  anthropic_api_key: boolean;
  openai_api_key: boolean;
  claude_cli: boolean;
  codex_cli: boolean;
};

type Section = "local" | "anthropic" | "openai" | "other";
type Variant = "local" | "sub" | "api" | "auto";

type Entry = {
  id: string;
  label: string;
  hint?: string;
  section: Section;
  variant: Variant;
  available: boolean;
};

const SECTION_META: Record<Section, { label: string; color: string }> = {
  local:     { label: "LOCAL",     color: "#7fdfff" },
  anthropic: { label: "ANTHROPIC", color: "#ff9a3a" },
  openai:    { label: "OPENAI",    color: "#10a37f" },
  other:     { label: "OTHER",     color: "#c08aff" },
};

// Hardcoded cloud catalogue — keep small + curated rather than
// trying to fetch a live list. Matches the legacy app's set.
const ANTHROPIC_MODELS = [
  { id: "claude-opus-4-7",         display: "Claude Opus 4.7" },
  { id: "claude-sonnet-4-6",       display: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", display: "Claude Haiku 4.5" },
];
const OPENAI_MODELS = [
  { id: "gpt-5",      display: "GPT-5" },
  { id: "gpt-5-mini", display: "GPT-5 Codex" },
  { id: "gpt-4.1",    display: "o3" },           // legacy display names
  { id: "gpt-4o",     display: "GPT-4o" },
  { id: "gpt-4o-mini",display: "GPT-4o mini" },
];
const AUTO_OPTIONS = [
  { id: "auto/cheapest",       display: "Auto · Cheapest" },
  { id: "auto/cheapest-local", display: "Auto · Cheapest Local" },
  { id: "auto/premium",        display: "Auto · Premium" },
  { id: "auto/balanced",       display: "Auto · Balanced" },
];

export function buildEntries(models: ModelInfo[], status: AccountsStatusLite | null): Entry[] {
  const out: Entry[] = [];

  // LOCAL
  for (const m of models) {
    if (m.provider !== "local") continue;
    out.push({
      id: m.model_id,
      label: m.model_id,
      section: "local",
      variant: "local",
      available: true,
      hint: m.size_mib != null ? `${(m.size_mib / 1024).toFixed(1)} GiB` : undefined,
    });
  }

  const claudeSub = !!status?.claude_cli;
  const claudeApi = !!status?.anthropic_api_key;
  for (const m of ANTHROPIC_MODELS) {
    out.push({
      id: `sub/${m.id}`,
      label: `${m.display} (subscription)`,
      section: "anthropic",
      variant: "sub",
      available: claudeSub,
      hint: claudeSub ? undefined : "(claude /login)",
    });
  }
  for (const m of ANTHROPIC_MODELS) {
    out.push({
      id: `api/${m.id}`,
      label: `${m.display} (API)`,
      section: "anthropic",
      variant: "api",
      available: claudeApi,
      hint: claudeApi ? undefined : "(set ANTHROPIC_API_KEY)",
    });
  }

  const codexSub = !!status?.codex_cli;
  const openaiApi = !!status?.openai_api_key;
  for (const m of OPENAI_MODELS.slice(0, 3)) {
    out.push({
      id: `sub/${m.id}`,
      label: `${m.display} (subscription)`,
      section: "openai",
      variant: "sub",
      available: codexSub,
      hint: codexSub ? undefined : "(codex login)",
    });
  }
  for (const m of OPENAI_MODELS) {
    out.push({
      id: `api/${m.id}`,
      label: `${m.display} (API)`,
      section: "openai",
      variant: "api",
      available: openaiApi,
      hint: openaiApi ? undefined : "(set OPENAI_API_KEY)",
    });
  }

  for (const a of AUTO_OPTIONS) {
    out.push({
      id: a.id,
      label: `⚡ ${a.display}`,
      section: "other",
      variant: "auto",
      available: true,
    });
  }

  return out;
}

/// Pretty up a stored id for the trigger button.
function displayForId(id: string, entries: Entry[]): string {
  const e = entries.find(x => x.id === id);
  if (e) return e.label;
  // Unknown id (stale config). Show the raw id.
  return id || "(none)";
}

export default function ModelPicker({
  value, onChange, models, status, placeholder, disabled, fallbackLabel,
}: {
  value: string;
  onChange: (id: string) => void;
  models: ModelInfo[];
  status: AccountsStatusLite | null;
  placeholder?: string;
  disabled?: boolean;
  /// What the trigger button shows when `value` is empty.
  fallbackLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open]);

  const entries = buildEntries(models, status);
  const sections: Section[] = ["local", "anthropic", "openai", "other"];

  const triggerLabel = value
    ? displayForId(value, entries)
    : (fallbackLabel || placeholder || "(pick a model)");

  return (
    <div ref={ref} style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(v => !v)}
        title={triggerLabel}
        style={{
          width: "100%", height: 30, padding: "0 10px",
          background: "var(--bg-input)", color: "var(--fg-strong)",
          border: "1px solid var(--border)", borderRadius: 8,
          fontSize: 12, textAlign: "left",
          cursor: disabled ? "not-allowed" : "pointer",
          display: "flex", alignItems: "center", gap: 6,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}
      >
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {triggerLabel}
        </span>
        <span style={{ color: "var(--fg-muted)", fontSize: 10 }}>▾</span>
      </button>
      {open && !disabled && (
        <div
          style={{
            position: "absolute", top: "100%", left: 0, marginTop: 4,
            width: "min(560px, 92vw)", maxHeight: "min(70vh, 640px)",
            background: "var(--bg-panel)",
            border: "1px solid var(--border-strong)",
            borderRadius: 10,
            boxShadow: "0 18px 60px rgba(0,0,0,0.55)",
            zIndex: 1000,
            overflow: "auto",
            padding: "10px 0",
          }}
        >
          {sections.map(sec => {
            const meta = SECTION_META[sec];
            const items = entries.filter(e => e.section === sec);
            if (items.length === 0) return null;
            return (
              <div key={sec} style={{ display: "flex", flexDirection: "column", padding: "4px 0" }}>
                <div style={{
                  padding: "8px 14px 4px",
                  fontSize: 11, fontWeight: 800, letterSpacing: 1.4,
                  color: meta.color,
                }}>
                  {meta.label}
                </div>
                {items.map(e => {
                  const isActive = e.id === value;
                  const muted = !e.available;
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => { onChange(e.id); setOpen(false); }}
                      disabled={muted}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "6px 14px",
                        background: isActive ? "var(--accent-soft)" : "transparent",
                        color: muted ? "var(--fg-subtle)" : "var(--fg)",
                        border: "none",
                        textAlign: "left",
                        fontSize: 12,
                        cursor: muted ? "not-allowed" : "pointer",
                        opacity: muted ? 0.55 : 1,
                      }}
                      onMouseEnter={ev => { if (!muted) (ev.currentTarget as HTMLElement).style.background = isActive ? "var(--accent-soft)" : "var(--bg-surface)"; }}
                      onMouseLeave={ev => { if (!muted) (ev.currentTarget as HTMLElement).style.background = isActive ? "var(--accent-soft)" : "transparent"; }}
                    >
                      <span style={{
                        width: 6, height: 6, borderRadius: 3,
                        background: meta.color, flexShrink: 0,
                        opacity: muted ? 0.4 : 1,
                      }} />
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {e.label}
                      </span>
                      {e.variant === "sub" && (
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                          background: "var(--bg-surface)", color: "var(--fg-muted)",
                          letterSpacing: 0.4, textTransform: "lowercase",
                        }}>sub</span>
                      )}
                      {e.variant === "api" && (
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                          background: "var(--bg-surface)", color: "var(--fg-muted)",
                          letterSpacing: 0.4, textTransform: "uppercase",
                        }}>API</span>
                      )}
                      {e.hint && (
                        <span style={{ fontSize: 10, color: "var(--fg-subtle)", whiteSpace: "nowrap" }}>
                          {e.hint}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

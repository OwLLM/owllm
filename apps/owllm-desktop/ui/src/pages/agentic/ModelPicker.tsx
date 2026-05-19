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
//
// `effort` here = extended-thinking budget tier. Translation in
// dispatch.ts streamAnthropic: low → no thinking (cheapest, fastest);
// medium/high/extra_high → thinking.budget_tokens of 4k/8k/16k. Same
// id-suffix encoding as the OpenAI side (`<id>:<level>`) so the
// dispatch parser stays uniform across providers. Only Opus 4.7 and
// Sonnet 4.6 expose the tier rows — Haiku 4.5 hasn't been validated
// with extended thinking by the user yet, so it stays single-row.
type AnthropicModel = {
  id: string;
  display: string;
  effort?: readonly string[];
};
const ANTHROPIC_MODELS: AnthropicModel[] = [
  { id: "claude-opus-4-7",   display: "Claude Opus 4.7",
    effort: ["low", "medium", "high", "extra_high"] },
  { id: "claude-sonnet-4-6", display: "Claude Sonnet 4.6",
    effort: ["low", "medium", "high", "extra_high"] },
  { id: "claude-haiku-4-5-20251001", display: "Claude Haiku 4.5" },
];
// Per-model flags replace the legacy slice(0, 3) trick. `sub` = show under
// "(subscription)" via Codex CLI; `api` = show under "(API)" via
// OPENAI_API_KEY. `effort` = expose a reasoning-effort selector as one
// row per level (matches the VS Code Copilot Chat dropdown). Encoded into
// the id as `<id>:<level>` so dispatch can parse it back without a
// separate UI control.
type OpenAIModel = {
  id: string;
  display: string;
  sub?: boolean;
  api?: boolean;
  effort?: readonly string[];
};
const OPENAI_MODELS: OpenAIModel[] = [
  { id: "gpt-5",         display: "GPT-5",          sub: true, api: true },
  { id: "gpt-5-mini",    display: "GPT-5 Codex",    sub: true, api: true },
  { id: "gpt-5.5-codex", display: "GPT-5.5 Codex",  sub: true,
    effort: ["low", "medium", "high", "extra_high"] },
  { id: "gpt-5.5",       display: "GPT-5.5",        api: true,
    effort: ["low", "medium", "high", "extra_high"] },
  { id: "gpt-4o",        display: "GPT-4o",         api: true },
  { id: "gpt-4o-mini",   display: "GPT-4o mini",    api: true },
];
function displayEffort(level: string): string {
  return level === "extra_high" ? "extra high" : level;
}
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
  const pushAnthropic = (m: AnthropicModel, variant: "sub" | "api", available: boolean, hint?: string) => {
    const tag = variant === "sub" ? "subscription" : "API";
    const levels: (string | null)[] = m.effort ? [...m.effort] : [null];
    for (const lvl of levels) {
      const id = lvl === null ? `${variant}/${m.id}` : `${variant}/${m.id}:${lvl}`;
      const label = lvl === null
        ? `${m.display} (${tag})`
        : `${m.display} · ${displayEffort(lvl)} (${tag})`;
      out.push({ id, label, section: "anthropic", variant, available, hint });
    }
  };
  for (const m of ANTHROPIC_MODELS) {
    pushAnthropic(m, "sub", claudeSub, claudeSub ? undefined : "(claude /login)");
  }
  for (const m of ANTHROPIC_MODELS) {
    pushAnthropic(m, "api", claudeApi, claudeApi ? undefined : "(set ANTHROPIC_API_KEY)");
  }

  const codexSub = !!status?.codex_cli;
  const openaiApi = !!status?.openai_api_key;
  const pushOpenAI = (m: OpenAIModel, variant: "sub" | "api", available: boolean, hint?: string) => {
    const tag = variant === "sub" ? "subscription" : "API";
    const levels: (string | null)[] = m.effort ? [...m.effort] : [null];
    for (const lvl of levels) {
      const id = lvl === null ? `${variant}/${m.id}` : `${variant}/${m.id}:${lvl}`;
      const label = lvl === null
        ? `${m.display} (${tag})`
        : `${m.display} · ${displayEffort(lvl)} (${tag})`;
      out.push({ id, label, section: "openai", variant, available, hint });
    }
  };
  for (const m of OPENAI_MODELS) {
    if (m.sub) pushOpenAI(m, "sub", codexSub, codexSub ? undefined : "(codex login)");
    if (m.api) pushOpenAI(m, "api", openaiApi, openaiApi ? undefined : "(set OPENAI_API_KEY)");
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
  /// Trigger bounding rect captured at open time so the popover can
  /// render with position:fixed and ESCAPE any parent overflow:hidden
  /// (TeamInfoCard clips otherwise — that's the bug the user hit).
  const [rect, setRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRef  = useRef<HTMLButtonElement | null>(null);
  const popRef  = useRef<HTMLDivElement | null>(null);

  // Close on outside click — must check BOTH the wrapper (trigger) and
  // the popover (rendered as a sibling via position:fixed, so it's not
  // a child of the wrapper any more).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Re-measure if the user scrolls or resizes the window while the
  // popover is open. Cheaper than re-rendering every frame.
  useEffect(() => {
    if (!open) return;
    const remeasure = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setRect(r);
    };
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, true);
    return () => {
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, true);
    };
  }, [open]);

  const entries = buildEntries(models, status);
  const sections: Section[] = ["local", "anthropic", "openai", "other"];

  const triggerLabel = value
    ? displayForId(value, entries)
    : (fallbackLabel || placeholder || "(pick a model)");

  const togglePopover = () => {
    if (!open) {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setRect(r);
    }
    setOpen(v => !v);
  };

  // Compute popover geometry. Width = trigger width (so it lines up
  // visually and the user sees the full row width without scrolling).
  // Clamp to a sensible minimum so a tight trigger still shows enough.
  // Vertical: open downward by default; flip upward if the popover
  // wouldn't fit below the trigger.
  let popStyle: React.CSSProperties = { display: "none" };
  if (open && !disabled && rect) {
    const desiredWidth = Math.max(rect.width, 320);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - desiredWidth - 8));
    const maxBelow = window.innerHeight - rect.bottom - 16;
    const maxAbove = rect.top - 16;
    const openUpward = maxBelow < 280 && maxAbove > maxBelow;
    const maxHeight = openUpward ? maxAbove : maxBelow;
    popStyle = {
      position: "fixed",
      left,
      width: desiredWidth,
      maxHeight: Math.max(220, Math.min(640, maxHeight)),
      [openUpward ? "bottom" : "top"]: openUpward
        ? (window.innerHeight - rect.top + 4)
        : (rect.bottom + 4),
      background: "var(--bg-panel)",
      border: "1px solid var(--border-strong)",
      borderRadius: 10,
      boxShadow: "0 18px 60px rgba(0,0,0,0.55)",
      zIndex: 10000,
      overflow: "auto",
      padding: "10px 0",
    };
  }

  return (
    <div ref={wrapRef} style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={togglePopover}
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
      {open && !disabled && rect && (
        <div ref={popRef} style={popStyle}>
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

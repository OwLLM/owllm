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
import { useEffect, useReducer, useRef, useState } from "react";
import { getCloudCatalogue, subscribeCloudCatalogue, type CloudModelDef } from "./cloudCatalogue";

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
  moonshot_api_key: boolean;
  deepseek_api_key: boolean;
  xai_api_key: boolean;
  groq_api_key: boolean;
  perplexity_api_key: boolean;
  mistral_api_key: boolean;
  together_api_key: boolean;
  gemini_api_key: boolean;
  claude_cli: boolean;
  codex_cli: boolean;
  kimi_cli: boolean;
  gemini_cli: boolean;
  grok_cli: boolean;
};

type Section =
  | "local" | "tuned"
  | "anthropic" | "openai" | "kimi" | "gemini"
  | "deepseek" | "xai" | "groq" | "perplexity" | "mistral" | "together"
  | "other";
type Variant = "local" | "tuned" | "sub" | "api" | "auto";

export type ModelPickerEntry = {
  id: string;
  label: string;
  hint?: string;
  section: Section;
  variant: Variant;
  available: boolean;
};

const SECTION_META: Record<Section, { label: string; color: string }> = {
  local:      { label: "LOCAL",         color: "#7fdfff" },
  tuned:      { label: "TUNED (LOCAL)", color: "#ffd166" },
  anthropic:  { label: "ANTHROPIC",     color: "#ff9a3a" },
  openai:     { label: "OPENAI",        color: "#10a37f" },
  kimi:       { label: "KIMI",          color: "#d36bff" },
  gemini:     { label: "GEMINI",        color: "#4285f4" },
  deepseek:   { label: "DEEPSEEK",      color: "#2563eb" },
  xai:        { label: "xAI · GROK",    color: "#9aa0a6" },
  groq:       { label: "GROQ",          color: "#ff5d11" },
  perplexity: { label: "PERPLEXITY",    color: "#20b2aa" },
  mistral:    { label: "MISTRAL",       color: "#ff7a00" },
  together:   { label: "TOGETHER AI",   color: "#7fc8ff" },
  other:      { label: "OTHER",         color: "#c08aff" },
};

// Cloud / subscription / API catalogue is DATA-DRIVEN — see
// cloudCatalogue.ts. Bundled defaults ship in the .exe; a localStorage
// override (`owllm:cloud-models`) or a remote registry can add/replace
// models (e.g. Claude Opus 4.8 the day it ships) with no rebuild.
//
// `effort` = extended-thinking budget tier. Translation in dispatch.ts
// streamAnthropic: low → no thinking; medium/high/extra_high →
// thinking.budget_tokens 4k/8k/16k. Encoded into the id as `<id>:<level>`
// so the dispatch parser stays uniform across providers.
type AnthropicModel = CloudModelDef;
type OpenAIModel = CloudModelDef;
type KimiModel = CloudModelDef;
type CloudModel = CloudModelDef;

function displayEffort(level: string): string {
  return level === "extra_high" ? "extra high" : level;
}
const AUTO_OPTIONS = [
  { id: "auto/cheapest",       display: "Auto · Cheapest" },
  { id: "auto/cheapest-local", display: "Auto · Cheapest Local" },
  { id: "auto/premium",        display: "Auto · Premium" },
  { id: "auto/balanced",       display: "Auto · Balanced" },
];

export function buildEntries(models: ModelInfo[], status: AccountsStatusLite | null): ModelPickerEntry[] {
  const out: ModelPickerEntry[] = [];
  // Data-driven catalogue: bundled defaults + localStorage / remote
  // overrides (cloudCatalogue.ts). Resolved per render so a freshly
  // added model (e.g. Opus 4.8) shows without an app restart.
  const cat = getCloudCatalogue();

  // LOCAL — base GGUFs + transformers dirs under LLM/models/. Entries
  // with port=null are transformers-format directories that
  // llama-server can't serve as-is; we show them dimmed with a hint
  // telling the user to convert to GGUF first (rather than letting
  // them pick a model that silently no-ops on Server start).
  for (const m of models) {
    if (m.provider !== "local") continue;
    const parts: string[] = [];
    if (m.size_mib != null) parts.push(`${(m.size_mib / 1024).toFixed(1)} GiB`);
    if (m.port != null) parts.push(`Port: ${m.port}`);
    const isUnservable = m.port == null;
    out.push({
      id: m.model_id,
      label: m.model_id,
      section: "local",
      variant: "local",
      available: !isUnservable,
      hint: isUnservable
        ? (parts.length > 0 ? `${parts.join(" · ")} · transformers dir — export GGUF first` : "transformers dir — export GGUF first")
        : (parts.length > 0 ? parts.join(" · ") : undefined),
    });
  }

  // TUNED (LOCAL) — abliterated / fine-tuned weights under
  // LLM/fine_tuned/. Same dispatch path as local; separate section so
  // the user doesn't confuse a 14B abliterated dir with a downloaded
  // base. Rust models.rs tags these with provider="tuned".
  for (const m of models) {
    if (m.provider !== "tuned") continue;
    const parts: string[] = [];
    if (m.size_mib != null) parts.push(`${(m.size_mib / 1024).toFixed(1)} GiB`);
    if (m.port != null) parts.push(`Port: ${m.port}`);
    const isUnservable = m.port == null;
    out.push({
      id: m.model_id,
      label: m.model_id,
      section: "tuned",
      variant: "tuned",
      available: !isUnservable,
      hint: isUnservable
        ? (parts.length > 0 ? `${parts.join(" · ")} · transformers dir — export GGUF first` : "transformers dir — export GGUF first")
        : (parts.length > 0 ? parts.join(" · ") : undefined),
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
  for (const m of cat.anthropic) {
    pushAnthropic(m, "sub", claudeSub, claudeSub ? undefined : "(claude /login)");
  }
  for (const m of cat.anthropic) {
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
  for (const m of cat.openai) {
    if (m.sub) pushOpenAI(m, "sub", codexSub, codexSub ? undefined : "(codex login)");
    if (m.api) pushOpenAI(m, "api", openaiApi, openaiApi ? undefined : "(set OPENAI_API_KEY)");
  }

  // KIMI — subscription via Kimi Code CLI, API via MOONSHOT_API_KEY.
  // ID encoding: "sub/<id>" / "api/<id>" so the dispatch's
  // providerFor (in AgentsPage) can branch off the bare id like it
  // does for Anthropic / OpenAI.
  const kimiSub = !!status?.kimi_cli;
  const kimiApi = !!status?.moonshot_api_key;
  const pushKimi = (m: KimiModel, variant: "sub" | "api", available: boolean, hint?: string) => {
    const tag = variant === "sub" ? "subscription" : "API";
    out.push({
      id: `${variant}/${m.id}`,
      label: `${m.display} (${tag})`,
      section: "kimi",
      variant,
      available,
      hint,
    });
  };
  for (const m of cat.kimi) {
    if (m.sub) pushKimi(m, "sub", kimiSub, kimiSub ? undefined : "(kimi /login)");
    if (m.api) pushKimi(m, "api", kimiApi, kimiApi ? undefined : "(set MOONSHOT_API_KEY)");
  }

  // Generic OpenAI-compatible provider rows. Same encoding as
  // Anthropic / OpenAI / Kimi: "api/<id>" so providerFor can map back
  // to the right base URL + key in dispatch.
  const pushCloud = (
    section: Section,
    m: CloudModel,
    variant: "sub" | "api",
    available: boolean,
    hint?: string,
  ) => {
    const tag = variant === "sub" ? "subscription" : "API";
    out.push({
      id: `${variant}/${m.id}`,
      label: `${m.display} (${tag})`,
      section,
      variant,
      available,
      hint,
    });
  };
  // Gemini: subscription via gemini-cli + API via GEMINI_API_KEY.
  const geminiSub = !!status?.gemini_cli;
  const geminiApi = !!status?.gemini_api_key;
  for (const m of cat.gemini) {
    if (m.sub) pushCloud("gemini", m, "sub", geminiSub, geminiSub ? undefined : "(gemini auth login)");
    if (m.api) pushCloud("gemini", m, "api", geminiApi, geminiApi ? undefined : "(set GEMINI_API_KEY)");
  }
  // xAI: subscription via the Grok Build CLI (SuperGrok / X Premium+) +
  // API via XAI_API_KEY — same two-row shape as kimi/gemini.
  const grokSub = !!status?.grok_cli;
  const xaiApi = !!status?.xai_api_key;
  for (const m of cat.xai) {
    if (m.sub) pushCloud("xai", m, "sub", grokSub, grokSub ? undefined : "(grok sign-in)");
    if (m.api) pushCloud("xai", m, "api", xaiApi, xaiApi ? undefined : "(set XAI_API_KEY)");
  }
  // API-only providers.
  type ApiOnly = { section: Section; models: CloudModel[]; available: boolean; envHint: string };
  const apiOnly: ApiOnly[] = [
    { section: "deepseek",   models: cat.deepseek,   available: !!status?.deepseek_api_key,   envHint: "DEEPSEEK_API_KEY" },
    { section: "groq",       models: cat.groq,       available: !!status?.groq_api_key,       envHint: "GROQ_API_KEY" },
    { section: "perplexity", models: cat.perplexity, available: !!status?.perplexity_api_key, envHint: "PERPLEXITY_API_KEY" },
    { section: "mistral",    models: cat.mistral,    available: !!status?.mistral_api_key,    envHint: "MISTRAL_API_KEY" },
    { section: "together",   models: cat.together,   available: !!status?.together_api_key,   envHint: "TOGETHER_API_KEY" },
  ];
  for (const grp of apiOnly) {
    for (const m of grp.models) {
      if (m.api) pushCloud(grp.section, m, "api", grp.available, grp.available ? undefined : `(set ${grp.envHint})`);
    }
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
function displayForId(id: string, entries: ModelPickerEntry[]): string {
  const e = entries.find(x => x.id === id);
  if (e) return e.label;
  // Unknown id (stale config). Show the raw id.
  return id || "(none)";
}

export default function ModelPicker({
  value, onChange, models, status, placeholder, disabled, fallbackLabel,
  localOnly,
}: {
  value: string;
  onChange: (id: string) => void;
  models: ModelInfo[];
  status: AccountsStatusLite | null;
  placeholder?: string;
  disabled?: boolean;
  /// What the trigger button shows when `value` is empty.
  fallbackLabel?: string;
  /// Server / Chat surfaces back to a local llama-server only — they
  /// cannot meaningfully target Anthropic / OpenAI / auto-routing.
  /// Setting this to true hides everything except the LOCAL section.
  localOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Sections start COLLAPSED (lab name + count only) so the popover stays
  // short — the full flat list had grown unusably long. Clicking a header
  // toggles it; the section holding the current selection opens by itself.
  const [expanded, setExpanded] = useState<Partial<Record<Section, boolean>>>({});
  // Re-render when the cloud catalogue changes (the async remote refresh
  // landing, or a localStorage override edit) so newly-added models appear
  // without an app restart.
  const [, forceCat] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeCloudCatalogue(() => forceCat()), []);
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

  const entries = buildEntries(models, status)
    .filter((e) => !localOnly || e.section === "local" || e.section === "tuned");
  const sections: Section[] = localOnly
    ? ["local", "tuned"]
    : [
        "local", "tuned",
        "anthropic", "openai", "kimi", "gemini",
        "deepseek", "xai", "groq", "perplexity", "mistral", "together",
        "other",
      ];

  const triggerLabel = value
    ? displayForId(value, entries)
    : (fallbackLabel || placeholder || "(pick a model)");

  const togglePopover = () => {
    if (!open) {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setRect(r);
      // Fresh open: collapse everything except the section holding the
      // current selection, so the user lands on context, not a wall.
      const current = entries.find(e => e.id === value);
      setExpanded(current ? { [current.section]: true } : {});
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
            // A lone section (e.g. localOnly with just LOCAL) always shows
            // its items — collapsing it would only add a pointless click.
            const soleSection = sections.filter(s => entries.some(e => e.section === s)).length === 1;
            const isOpen = soleSection || !!expanded[sec];
            return (
              <div key={sec} style={{ display: "flex", flexDirection: "column", padding: "4px 0" }}>
                <button
                  type="button"
                  onClick={() => { if (!soleSection) setExpanded(prev => ({ ...prev, [sec]: !prev[sec] })); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "8px 14px 4px",
                    background: "transparent", border: "none",
                    fontSize: 11, fontWeight: 800, letterSpacing: 1.4,
                    color: meta.color, textAlign: "left",
                    cursor: soleSection ? "default" : "pointer",
                  }}
                >
                  {!soleSection && (
                    <span style={{ fontSize: 9, color: "var(--fg-muted)", width: 10, flexShrink: 0 }}>
                      {isOpen ? "▾" : "▸"}
                    </span>
                  )}
                  <span style={{ flex: 1 }}>{meta.label}</span>
                  <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0, color: "var(--fg-muted)" }}>
                    {items.length}
                  </span>
                </button>
                {isOpen && items.map(e => {
                  const isActive = e.id === value;
                  const muted = !e.available;
                  return (
                    <button
                      key={e.id}
                      type="button"
                      title={e.hint ? `${e.label} — ${e.hint}` : e.label}
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

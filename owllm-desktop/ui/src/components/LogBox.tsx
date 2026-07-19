// LogBox — the ONE shared log/output box for the whole app. Don't hand-roll a
// scrollable <div> of monospace output anywhere; use this.
//
// What it gives you, consistently everywhere:
//   • Scrollable, sticky to the bottom as new lines stream in (useStickyScroll)
//     — and it never yanks you down if you scrolled up to read.
//   • Ctrl+A / Cmd+A selects ONLY this box's text, not the whole app. (A plain
//     <div> isn't a form field, so the browser's Ctrl+A falls through to the
//     document and selects everything — that's the "the entire app is selected"
//     bug. We make the box focusable and scope the select-all to it.)
//   • Click to expand → a popup with the full log, a Copy button, Esc to close,
//     and the same scoped Ctrl+A — for anyone who wants to read what's going on.
//
// Pass either `text` (a single string) or `lines` (a string[]).

import React, { useState, useEffect } from "react";
import { useStickyScroll } from "../hooks/useStickyScroll";

export type LogBoxProps = {
  /** Full log content as one string. Use this OR `lines`. */
  text?: string;
  /** Full log content as lines (joined with "\n"). Use this OR `text`. */
  lines?: string[];
  /** Title shown on the expand popup. */
  title?: string;
  /** Inline box height (number = px). Default 160. */
  height?: number | string;
  /** Shown when there's no content yet. */
  placeholder?: string;
  /** Merged onto the inline box (or the wrapper when `header` is set). */
  style?: React.CSSProperties;
  /** Disable click-to-expand (the box is then plain-selectable text). */
  noExpand?: boolean;
  /** Optional clickable title row above the box — clicking it (or the box)
   *  opens the full-log popup. Use this when the user wants "the name of the
   *  log clickable". */
  header?: React.ReactNode;
  /** Fill the parent's height (flex:1 + scroll) instead of a fixed height —
   *  for logs that should grow to fill a column and scroll internally. */
  fill?: boolean;
};

const boxBase: React.CSSProperties = {
  overflowY: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "Consolas, 'Courier New', monospace",
  fontSize: 11.5,
  lineHeight: 1.5,
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "8px 10px",
  color: "var(--fg)",
  userSelect: "text",
  WebkitUserSelect: "text",
};

/** Select only `el`'s text content (used for scoped Ctrl+A). */
function selectNodeContents(el: HTMLElement | null) {
  if (!el) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch { /* selection API hiccup — ignore */ }
}

/** onKeyDown handler that scopes Ctrl+A / Cmd+A to the ref'd element. */
function scopedSelectAll(ref: React.RefObject<HTMLElement | null>) {
  return (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      selectNodeContents(ref.current);
    }
  };
}

export function LogBox({
  text, lines, title = "Log", height = 160,
  placeholder = "(no output yet)", style, noExpand, header, fill,
}: LogBoxProps) {
  const content = (lines ? lines.join("\n") : (text ?? "")).replace(/\s+$/, "");
  const [open, setOpen] = useState(false);
  const sticky = useStickyScroll<HTMLDivElement>(content.length);

  const tryExpand = () => {
    if (noExpand) return;
    // Don't hijack a text-selection drag — only a clean click expands.
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;
    setOpen(true);
  };

  const box = (
    <div
      ref={sticky.ref}
      onScroll={sticky.onScroll}
      tabIndex={0}
      onKeyDown={scopedSelectAll(sticky.ref)}
      onClick={tryExpand}
      title={noExpand ? undefined : "Click to expand · Ctrl+A selects this box"}
      style={{
        ...boxBase,
        ...(fill ? { flex: 1, minHeight: 0 } : { height }),
        cursor: noExpand ? "text" : "pointer",
        ...(header == null ? style : {}),
      }}
    >
      {content || <span style={{ color: "var(--fg-subtle)", fontStyle: "italic" }}>{placeholder}</span>}
    </div>
  );

  const modal = open ? <LogModal title={title} content={content} onClose={() => setOpen(false)} /> : null;

  if (header == null) {
    return <>{box}{modal}</>;
  }

  // Header variant: a clickable title row (the "name") above the box; clicking
  // either the name or the box opens the full-log popup.
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minHeight: 0, ...(fill ? { flex: 1 } : {}), ...style }}>
        <div
          onClick={() => { if (!noExpand) setOpen(true); }}
          title={noExpand ? undefined : "Click to open the full log"}
          style={{ display: "flex", alignItems: "center", gap: 8, cursor: noExpand ? "default" : "pointer" }}
        >
          <span style={{ fontSize: 13, fontWeight: 800, color: "var(--fg-strong)", flex: 1 }}>{header}</span>
          {!noExpand && <span style={{ fontSize: 11, color: "var(--accent-ink)", fontWeight: 700 }}>⤢ open</span>}
        </div>
        {box}
      </div>
      {modal}
    </>
  );
}

function LogModal({ title, content, onClose }: { title: string; content: string; onClose: () => void }) {
  const sticky = useStickyScroll<HTMLDivElement>(content.length, "open");
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard blocked — ignore */ }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(4,6,12,0.62)", backdropFilter: "blur(3px)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 28,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: "min(900px, 94vw)", height: "min(80vh, 720px)",
        display: "flex", flexDirection: "column",
        background: "var(--bg-panel)", border: "1px solid var(--border-strong)",
        borderRadius: 12, boxShadow: "0 24px 80px rgba(0,0,0,0.55)", overflow: "hidden",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg-strong)", flex: 1 }}>{title}</div>
          <button onClick={copy} className="ghost-btn" style={{ height: 28, padding: "0 12px", fontSize: 12 }}>{copied ? "✓ Copied" : "⧉ Copy"}</button>
          <button onClick={onClose} className="ghost-btn" style={{ height: 28, width: 30, padding: 0, fontSize: 14 }}>✕</button>
        </div>
        <div
          ref={sticky.ref}
          onScroll={sticky.onScroll}
          tabIndex={0}
          onKeyDown={scopedSelectAll(sticky.ref)}
          style={{ ...boxBase, flex: 1, border: "none", borderRadius: 0, height: "auto", fontSize: 12.5 }}
        >
          {content || <span style={{ color: "var(--fg-subtle)", fontStyle: "italic" }}>(empty)</span>}
        </div>
      </div>
    </div>
  );
}

export default LogBox;

// ChatBubble — the ONE shared chat-message renderer, used by both the
// fine-tuning ChatPage and the Agentic chats so every chat surface looks
// identical: avatar + sender label + generating/done indicator +
// timestamp, an optional collapsible Thinking block, and the body
// (markdown when finished, plain pre-wrap while streaming so per-token
// re-renders don't kill mouse selection).
//
// Extracted verbatim from the ChatPage template (don't fork it — reuse).

import { memo, useEffect, useState, type CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { convertFileSrc } from "@tauri-apps/api/core";
import MarkdownLink from "./MarkdownLink";
import { safeMarkdownUrlTransform } from "./documentLinks";
import { readAppLanguage } from "../localization";

// Resolve any image reference (markdown `![](…)` src OR an attachment) into a
// URL the Tauri webview can actually load. A raw local path ("C:\…", "/…",
// "file://…") renders as a BROKEN IMAGE ICON — Tauri only serves local files
// through the asset protocol (convertFileSrc). data:/blob:/http(s):/asset: are
// already loadable and pass straight through. Relative/bare names can't be
// resolved at the view layer (no base dir), so they're returned unchanged.
export function resolveImageSrc(raw?: string): string {
  const s = (raw || "").trim();
  if (!s) return s;
  if (/^(data:|blob:|https?:|asset:|tauri:)/i.test(s)) return s;
  let path = s;
  if (/^file:\/\//i.test(s)) {
    try { path = decodeURIComponent(s.replace(/^file:\/\//i, "")); } catch { path = s.replace(/^file:\/\//i, ""); }
    if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1); // "/C:/x" → "C:/x"
  }
  const isAbs = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
  if (!isAbs) return s;
  try { return convertFileSrc(path); } catch { return s; }
}

// Shared image renderer: bounded thumbnail that opens a full-screen lightbox on
// click (Esc / click to close), and a visible fallback chip when the source
// can't load — so a missing screenshot says so instead of showing a mystery
// broken icon. Used both as the markdown `img` component and for uploaded
// attachment thumbnails, so images work identically in EVERY chat surface.
export function SmartImage({ src, alt, thumb }: { src?: string; alt?: string; thumb?: boolean }) {
  const [zoom, setZoom] = useState(false);
  const [failed, setFailed] = useState(false);
  const resolved = resolveImageSrc(src);
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setZoom(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);
  if (failed || !resolved) {
    return (
      <span title={src || undefined} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 8px", margin: "4px 0", border: "1px dashed var(--border-strong)", borderRadius: 6, color: "var(--fg-muted)", fontSize: 11 }}>
        🖼 image unavailable{alt ? ` — ${alt}` : ""}
      </span>
    );
  }
  return (
    <>
      <img
        src={resolved}
        alt={alt || ""}
        title={alt || undefined}
        onClick={() => setZoom(true)}
        onError={() => setFailed(true)}
        style={{ maxWidth: thumb ? 168 : "100%", maxHeight: thumb ? 168 : 360, width: thumb ? undefined : "auto", borderRadius: 6, border: "1px solid var(--border)", cursor: "zoom-in", objectFit: thumb ? "cover" : "contain", display: thumb ? "inline-block" : "block", margin: thumb ? 0 : "6px 0", verticalAlign: "top" }}
      />
      {zoom && (
        <div onClick={() => setZoom(false)} style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.86)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out" }}>
          <img src={resolved} alt={alt || ""} style={{ maxWidth: "94vw", maxHeight: "94vh", objectFit: "contain", boxShadow: "0 8px 40px rgba(0,0,0,0.6)", borderRadius: 8 }} />
        </div>
      )}
    </>
  );
}

// Full timestamp next to each turn: "2026/Jun/01 14:32".
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const language = readAppLanguage();
  if (language !== "en") {
    return d.toLocaleString(language, {
      year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  }
  const yyyy = d.getFullYear();
  const mon = MONTHS_SHORT[d.getMonth()];
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}/${mon}/${dd} ${hh}:${mm}`;
}

// Markdown renderer for completed replies so cloud (Claude / GPT) answers
// render headings, tables, bold, lists, and code blocks like a real chat
// client instead of a wall of plain text. Used only for FINISHED
// messages — the streaming one stays plain pre-wrap to preserve selection.
export function ChatMarkdown({ text, workspace }: { text: string; workspace?: string }) {
  return (
    <div className="md-body" data-no-localize dir="auto" style={{ fontSize: "var(--chat-font-size, 13px)", lineHeight: 1.55, color: "var(--fg)" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeMarkdownUrlTransform}
        components={{
          code({ className, children, ...props }: any) {
            const isBlock = /language-/.test(className || "") || (typeof children === "string" && children.includes("\n"));
            if (!isBlock) {
              return <code style={{ background: "rgba(127,140,160,0.18)", padding: "0.12em 0.38em", borderRadius: 3, fontFamily: "Consolas, monospace", fontSize: "0.92em" }} {...props}>{children}</code>;
            }
            return (
              <pre style={{ margin: "8px 0", padding: 10, background: "rgba(20,28,40,0.6)", border: "1px solid var(--border)", borderRadius: 6, overflowX: "auto", fontFamily: "Consolas, monospace", fontSize: 12, lineHeight: 1.45 }}>
                <code className={className} {...props}>{children}</code>
              </pre>
            );
          },
          h1: (p) => <h2 style={{ fontSize: 17, fontWeight: 700, margin: "12px 0 5px", color: "var(--fg-strong)" }} {...(p as any)} />,
          h2: (p) => <h3 style={{ fontSize: 15, fontWeight: 700, margin: "10px 0 4px", color: "var(--fg-strong)" }} {...(p as any)} />,
          h3: (p) => <h4 style={{ fontSize: 14, fontWeight: 700, margin: "8px 0 3px", color: "var(--fg-strong)" }} {...(p as any)} />,
          p: (p) => <p style={{ margin: "5px 0" }} {...(p as any)} />,
          ul: (p) => <ul style={{ margin: "5px 0", paddingLeft: 20 }} {...(p as any)} />,
          ol: (p) => <ol style={{ margin: "5px 0", paddingLeft: 20 }} {...(p as any)} />,
          li: (p) => <li style={{ margin: "2px 0" }} {...(p as any)} />,
          a: (props) => <MarkdownLink {...props} workspace={workspace} />,
          img: (p: any) => <SmartImage src={p.src} alt={p.alt} />,
          blockquote: (p) => <blockquote style={{ borderLeft: "3px solid var(--accent)", margin: "6px 0", padding: "2px 0 2px 10px", color: "var(--fg-muted)" }} {...(p as any)} />,
          table: (p) => <div style={{ overflowX: "auto", margin: "8px 0" }}><table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: "100%" }} {...(p as any)} /></div>,
          th: (p) => <th style={{ border: "1px solid var(--border)", padding: "4px 8px", background: "var(--bg-surface)", textAlign: "left", fontWeight: 600 }} {...(p as any)} />,
          td: (p) => <td style={{ border: "1px solid var(--border)", padding: "4px 8px" }} {...(p as any)} />,
        }}
      >{text}</ReactMarkdown>
    </div>
  );
}

// ---- Shared thinking + tool-event renderers ---------------------------
// These are the SAME visuals the fine-tuning ChatPage uses, lifted here so
// the agentic Clear Chat renders thinking + tool calls identically (the
// "make it exactly like the fine-tuning chat" ask). Don't fork these.

/// Collapsible reasoning block ("💭 Thinking (N chars)"). Used both inside
/// ChatBubble (attached to a turn) and standalone in the agentic stream.
export function ThinkingBlock({ text }: { text: string }) {
  if (!text || !text.trim()) return null;
  return (
    <details style={{
      marginLeft: 28,
      background: "rgba(192,138,255,0.06)",
      border: "1px solid rgba(192,138,255,0.25)",
      borderRadius: 6,
      overflow: "hidden",
      flexShrink: 0,
    }}>
      <summary style={{ cursor: "pointer", userSelect: "none", fontWeight: 700, color: "#c08aff", padding: "5px 8px", fontSize: 11 }}>
        💭 Thinking ({text.length.toLocaleString()} chars)
      </summary>
      <pre style={{ whiteSpace: "pre-wrap", margin: 0, padding: "6px 8px", fontFamily: "Consolas, monospace", fontSize: 10.5, lineHeight: 1.5, color: "var(--fg-muted)" }}>
        {text}
      </pre>
    </details>
  );
}

export type ToolStatus = "running" | "ok" | "error" | undefined;

export function toolStatusColor(status?: ToolStatus) {
  if (status === "ok") return "#7ff0c5";
  if (status === "error") return "#ff8c8c";
  if (status === "running") return "#ffd97a";
  return "var(--fg-muted)";
}

export function toolStatusLabel(status?: ToolStatus) {
  if (status === "ok") return "Done";
  if (status === "error") return "Failed";
  if (status === "running") return "Running";
  return "Info";
}

/// Expandable tool / terminal / notice card — the exact ChatPage event row.
/// `kind` drives the framing: "terminal" gets the dark console look.
export const ToolEventCard = memo(function ToolEventCard({
  title, content, status, kind = "tool",
}: {
  title: string;
  content: string;
  status?: ToolStatus;
  kind?: "tool" | "terminal" | "notice";
}) {
  const isTerminal = kind === "terminal";
  const c = toolStatusColor(status);
  return (
    <details open={status === "running" || status === "error"} style={{
      border: `1px solid ${kind === "notice" ? "var(--border-strong)" : `${c}66`}`,
      background: isTerminal ? "rgba(8,12,18,0.86)" : "rgba(127,140,160,0.08)",
      borderRadius: 6,
      overflow: "hidden",
      flexShrink: 0,
    }}>
      <summary style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "7px 10px", cursor: "pointer", userSelect: "none",
        color: c, fontSize: 12, fontWeight: 700,
      }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: c, display: "inline-block", boxShadow: `0 0 8px ${c}` }} />
        <span style={{ flex: 1, color: "var(--fg)" }}>{title || (isTerminal ? "Terminal" : "Tool call")}</span>
        <span style={{ color: c, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.7 }}>{toolStatusLabel(status)}</span>
      </summary>
      <pre style={{
        margin: 0, padding: "8px 10px", maxHeight: 240, overflow: "auto",
        whiteSpace: "pre-wrap", color: isTerminal ? "#d7ffe8" : "var(--fg)",
        background: isTerminal ? "#05070a" : "transparent",
        fontFamily: "Consolas, 'JetBrains Mono', monospace", fontSize: 11.5, lineHeight: 1.45,
        userSelect: "text", WebkitUserSelect: "text",
      }}>{content}</pre>
    </details>
  );
});

/// Compact ONE-LINE tool row: two columns (input | output), collapsed by
/// default and expandable on click (user spec — "one line only divided in
/// input/output … always shrinked but clickable"). The summary shows the tool
/// name + a one-line input preview on the left and the status + a one-line
/// output preview on the right; expanding reveals the full input and output.
export const ToolCallLine = memo(function ToolCallLine({
  title, input, output, status, kind = "tool",
}: {
  title: string;
  input?: string;
  output?: string;
  status?: ToolStatus;
  kind?: "tool" | "terminal";
}) {
  const c = toolStatusColor(status);
  const isTerminal = kind === "terminal";
  // Collapse whitespace so the preview is a single tidy line.
  const oneLine = (s?: string) => (s || "").replace(/\s+/g, " ").trim();
  const inPrev = oneLine(input);
  const outPrev = oneLine(output);
  const cell: CSSProperties = {
    display: "flex", alignItems: "center", gap: 6, minWidth: 0,
  };
  const preview: CSSProperties = {
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    fontFamily: "Consolas, 'JetBrains Mono', monospace", fontSize: 11,
  };
  const sectionLabel: CSSProperties = {
    padding: "5px 10px 0", fontSize: 9.5, fontWeight: 800, letterSpacing: 0.8,
    textTransform: "uppercase", color: "var(--fg-subtle)",
  };
  const body: CSSProperties = {
    margin: 0, padding: "4px 10px 8px", maxHeight: 240, overflow: "auto",
    whiteSpace: "pre-wrap", fontFamily: "Consolas, 'JetBrains Mono', monospace",
    fontSize: 11, lineHeight: 1.45, userSelect: "text", WebkitUserSelect: "text",
  };
  return (
    <details style={{
      border: `1px solid ${c}55`,
      background: "rgba(127,140,160,0.06)",
      borderRadius: 6, overflow: "hidden", flexShrink: 0,
    }}>
      <summary style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10,
        alignItems: "center", padding: "5px 10px",
        cursor: "pointer", userSelect: "none", listStyle: "none", fontSize: 12,
      }}>
        {/* col 1 — tool + input */}
        <span style={cell}>
          <span style={{ width: 7, height: 7, borderRadius: 4, background: c, flexShrink: 0, boxShadow: `0 0 6px ${c}` }} />
          <span style={{ fontWeight: 700, color: "var(--fg)", flexShrink: 0 }}>{title || "tool"}</span>
          <span style={{ ...preview, color: "var(--fg-subtle)" }}>{inPrev}</span>
        </span>
        {/* col 2 — status + output */}
        <span style={cell}>
          <span style={{ color: c, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.6, flexShrink: 0 }}>{toolStatusLabel(status)}</span>
          <span style={{ ...preview, color: "var(--fg-muted)" }}>{outPrev || "…"}</span>
        </span>
      </summary>
      <div style={{ borderTop: `1px solid ${c}33` }}>
        {input != null && input !== "" && (
          <div>
            <div style={sectionLabel}>input</div>
            <pre style={{ ...body, color: "var(--fg)" }}>{input}</pre>
          </div>
        )}
        {output != null && output !== "" && (
          <div style={{ borderTop: (input != null && input !== "") ? `1px solid ${c}22` : "none" }}>
            <div style={sectionLabel}>output</div>
            <pre style={{ ...body, color: isTerminal ? "#d7ffe8" : "var(--fg)", background: isTerminal ? "#05070a" : "transparent" }}>{output}</pre>
          </div>
        )}
      </div>
    </details>
  );
});

export type ChatBubbleProps = {
  /// One-or-two char chip in the avatar box ("U", "A", an emoji…).
  avatar: string;
  /// Display name shown next to the avatar ("You", "Model A", agent name).
  sender: string;
  /// Accent colour for the avatar + name.
  accent: string;
  /// The user's own turn renders literally (no markdown, no done/cursor).
  isUser: boolean;
  /// True for the live, still-generating reply: shows the pulsing
  /// "generating…" chip + blinking cursor and stays plain pre-wrap.
  isStreaming: boolean;
  content: string;
  /// Optional reasoning, shown in a collapsible "Thinking" block.
  thinking?: string;
  /// Epoch ms, rendered as the full date/time on the right.
  ts?: number;
  /// Optional attached images (user uploads or agent results), shown as
  /// clickable thumbnails under the body. Store this array ON the message so
  /// its identity is stable and memo keeps skipping unchanged bubbles.
  images?: { src: string; alt?: string }[];
  /// Workspace used to resolve relative document links emitted by an agent.
  workspace?: string;
};

// memo: a chat surface re-renders on EVERY keystroke in its composer (the draft
// state lives in the parent). Without memo, all 300+ bubbles re-render AND
// re-parse their markdown each keystroke → multi-second input lag, brutal over
// remote desktop. All props are primitives, so memo's shallow compare lets an
// unchanged bubble skip entirely; only the streaming/edited one re-renders.
export const ChatBubble = memo(function ChatBubble({ avatar, sender, accent, isUser, isStreaming, content, thinking, ts, images, workspace }: ChatBubbleProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{
          width: 20, height: 20, borderRadius: 4,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: isUser ? "rgba(122,162,255,0.16)" : "rgba(var(--accent-rgb),0.13)",
          border: `1px solid ${isUser ? "rgba(122,162,255,0.35)" : "rgba(var(--accent-rgb),0.28)"}`,
          color: accent, fontSize: 11, fontWeight: 800, flexShrink: 0,
        }}>{avatar}</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: accent }}>{sender}</div>
        {!isUser && (
          isStreaming
            ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, color: "#ffd97a" }}>
                <span className="owl-pulse-dot" style={{ width: 7, height: 7, borderRadius: 4, background: "#ffd97a", display: "inline-block" }} />
                generating…
              </span>
            : <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, color: "#7ff0c5" }}>
                <span style={{ width: 7, height: 7, borderRadius: 4, background: "#7ff0c5", display: "inline-block" }} />
                done
              </span>
        )}
        <div style={{ flex: 1 }} />
        {ts ? <span style={{ fontSize: 10, color: "var(--fg-subtle)", fontVariantNumeric: "tabular-nums" }}>{fmtTime(ts)}</span> : null}
      </div>
      {thinking && thinking.trim() && <ThinkingBlock text={thinking} />}
      <div style={{
        marginLeft: 28,
        color: "var(--fg)",
        userSelect: "text",
        WebkitUserSelect: "text",
        cursor: "text",
      }} data-no-localize dir="auto">
        {!isUser && !isStreaming && content
          ? <ChatMarkdown text={content} workspace={workspace} />
          : <span style={{ whiteSpace: "pre-wrap", lineHeight: 1.55, fontSize: "var(--chat-font-size, 13px)" }}>
              {content}{isStreaming ? <span className="owl-cursor">▍</span> : null}
            </span>}
      </div>
      {images && images.length > 0 && (
        <div style={{ marginLeft: 28, display: "flex", flexWrap: "wrap", gap: 8, marginTop: content ? 6 : 0 }}>
          {images.map((im, i) => <SmartImage key={i} src={im.src} alt={im.alt} thumb />)}
        </div>
      )}
    </div>
  );
});

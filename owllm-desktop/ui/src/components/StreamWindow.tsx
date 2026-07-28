// StreamWindow — bounded rendering for the long-lived chat/log streams.
//
// WHY THIS EXISTS (the WebView2 "Out of Memory" crash, 2026-07-29):
// OwLLM's agentic pages are NOT ordinary web pages. A normal page loads, renders,
// and its memory flatlines; the browser can also discard/freeze a background tab
// and reclaim everything. Our run views do the opposite — every streamed token,
// tool event and thought is appended to a list that is rendered in full, and the
// window stays open for the whole run. So the DOM (and the retained React tree)
// grows MONOTONICALLY with run length until the renderer process exceeds its own
// per-process allocation ceiling and Chromium kills it — the "This page is having
// a problem · Error code: Out of Memory" screen, even with GBs of system RAM free.
//
// Fix: render only a WINDOW of the tail (what the user can actually scroll to)
// and keep the rest addressable behind an explicit "show earlier" control. The
// data is untouched — nothing is deleted, nothing stops being persisted — only
// how much is materialised into DOM at once is bounded. Memory becomes flat
// instead of linear in run length, which is exactly what a browser achieves for
// 100 tabs by discarding and resetting documents.
//
// Deliberately NOT a measuring virtual-scroller: our entries have wildly variable
// heights (markdown, collapsible tool cards, images) and the app standard is
// bottom-sticky autoscroll (useStickyScroll). A tail window keeps that behaviour
// exactly — new entries still land at the bottom — with none of the scroll
// anchoring bugs a windowed scroller introduces.

import React, { useCallback, useEffect, useState } from "react";

/** Entries kept in the DOM by default. Generous enough that ordinary sessions
 *  never see the banner, small enough that a marathon run can't exhaust the
 *  renderer. */
export const STREAM_WINDOW = 200;
/** How many additional entries each "show earlier" click reveals. */
export const STREAM_WINDOW_STEP = 300;

export type StreamWindowState = {
  /** First index of the visible slice — render `list.slice(start)`. */
  start: number;
  /** How many entries are hidden above the window (0 when everything shows). */
  hidden: number;
  /** Reveal STREAM_WINDOW_STEP more entries. */
  showEarlier: () => void;
  /** Reveal the entire stream (user explicitly asked for all of it). */
  showAll: () => void;
};

/**
 * Bound how much of a stream is rendered.
 *
 * @param total    current entry count
 * @param resetKey identity of the stream (project/chat id). When it changes the
 *                 window snaps back to the tail, so switching projects never
 *                 inherits a huge window from the previous one.
 */
export function useStreamWindow(total: number, resetKey?: string | number): StreamWindowState {
  const [shown, setShown] = useState(STREAM_WINDOW);

  // New stream (project/chat switch) → back to a bounded tail.
  useEffect(() => { setShown(STREAM_WINDOW); }, [resetKey]);

  // Stream shrank (cleared chat / new run) → don't keep an inflated window.
  useEffect(() => {
    setShown(s => (total < s && total >= 0 ? Math.max(STREAM_WINDOW, total) : s));
  }, [total]);

  const showEarlier = useCallback(() => setShown(s => s + STREAM_WINDOW_STEP), []);
  const showAll = useCallback(() => setShown(Number.MAX_SAFE_INTEGER), []);

  const start = Math.max(0, total - shown);
  return { start, hidden: start, showEarlier, showAll };
}

/**
 * The "N earlier entries are hidden" banner. Render it directly above the mapped
 * slice. Renders nothing when the whole stream is visible, so quiet sessions see
 * no extra chrome at all.
 */
export function EarlierBanner({ state, noun = "entries" }: { state: StreamWindowState; noun?: string }) {
  if (state.hidden <= 0) return null;
  const btn: React.CSSProperties = {
    background: "transparent",
    border: "1px solid var(--border-strong)",
    borderRadius: 6,
    color: "var(--accent-ink)",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 700,
    padding: "2px 8px",
  };
  return (
    <div
      data-ui="StreamWindow:earlier"
      style={{
        alignItems: "center",
        color: "var(--fg-muted)",
        display: "flex",
        flexWrap: "wrap",
        fontSize: 11,
        gap: 8,
        justifyContent: "center",
        padding: "4px 0 8px",
      }}
    >
      <span>
        {state.hidden.toLocaleString()} earlier {noun} hidden to keep this view fast
      </span>
      <button style={btn} onClick={state.showEarlier}>
        ▲ Show {Math.min(STREAM_WINDOW_STEP, state.hidden).toLocaleString()} more
      </button>
      <button style={btn} onClick={state.showAll}>
        Show all
      </button>
    </div>
  );
}

export default useStreamWindow;

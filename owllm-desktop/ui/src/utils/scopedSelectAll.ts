// scopedSelectAll.ts — make Ctrl/Cmd+A select only the chat/log region the
// user is reading, never the whole app window.
//
// The browser default for Ctrl+A is "select the entire document", so pressing
// it while reading a chat grabs the toolbar, the sidebar, every other panel —
// then a copy pulls the whole app's text. LogBox already scopes its own box
// via an onKeyDown handler, but the chat surfaces (agentic team chat, fine-
// tuning chat) had no such guard. This installs ONE global capture-phase
// handler: when Ctrl+A fires, we find the region the user is interacting with
// (the live selection anchor, set by any click/drag inside it; falling back
// to the focused element) and, if it sits inside an element marked
// `data-selectall-scope`, we scope the selection to that element instead.
// Text inputs/textareas/contenteditable keep their native select-all.

/** Select only the contents of `el` (not the whole document). */
export function selectNodeContents(el: HTMLElement | null): void {
  if (!el) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch {
    /* selection API hiccup — ignore */
  }
}

/**
 * Install the global Ctrl/Cmd+A scoping handler. Mark any scroll container
 * that should capture select-all with `data-selectall-scope`. Returns an
 * unsubscribe function (call it from a useEffect cleanup).
 */
export function installScopedSelectAll(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key !== "a" && e.key !== "A") return;
    const ae = document.activeElement as HTMLElement | null;
    const tag = ae?.tagName;
    // Let real text fields keep their native select-all.
    if (tag === "INPUT" || tag === "TEXTAREA" || ae?.isContentEditable) return;
    // Resolve where the user is: the selection anchor (set by any click or
    // drag inside a region) wins; otherwise the focused element.
    const sel = window.getSelection();
    const anchorNode = sel?.anchorNode ?? null;
    const anchorEl =
      anchorNode == null
        ? null
        : anchorNode.nodeType === Node.ELEMENT_NODE
        ? (anchorNode as HTMLElement)
        : anchorNode.parentElement;
    const start = anchorEl ?? ae;
    const scope = start?.closest?.("[data-selectall-scope]") as HTMLElement | null;
    if (!scope) return; // not inside a scoped region — leave the default alone
    e.preventDefault();
    selectNodeContents(scope);
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}

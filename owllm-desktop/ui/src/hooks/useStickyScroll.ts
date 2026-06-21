import { useCallback, useEffect, useRef } from "react";

/**
 * Sticky auto-scroll for a scroll container (chat, log, transcript, output box).
 *
 * The ONE consistent rule across the whole app:
 *   - On mount AND whenever `openKey` changes (you open/switch the view, tab,
 *     chat, project…) it jumps to the BOTTOM, so you always land on the latest
 *     message.
 *   - When `contentKey` changes (a new message/line streams in) it follows the
 *     bottom ONLY IF you were already near the bottom. If you scrolled UP to read,
 *     it leaves your position alone — it never yanks you back down.
 *   - The moment you scroll back to the bottom, following resumes.
 *
 * Attach BOTH returned values to your `overflow:auto` element:
 *
 *   const sticky = useStickyScroll(messages.length, chatId);
 *   <div ref={sticky.ref} onScroll={sticky.onScroll} style={{ overflow: "auto" }}>
 *
 * `contentKey` should be something that changes on new content (e.g. count, or a
 * running streamed-length tick). `openKey` should change when the view is
 * (re)opened or switched (e.g. the active tab id / chat id); omit it to only
 * scroll-to-bottom on first mount.
 */
export function useStickyScroll<T extends HTMLElement = HTMLDivElement>(
  contentKey: unknown,
  openKey?: unknown,
) {
  const ref = useRef<T | null>(null);
  // Start pinned so the very first paint lands at the bottom.
  const pinned = useRef(true);

  const toBottom = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Track whether the user is "following" (near the bottom) vs has scrolled up.
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinned.current = distanceFromBottom <= 48; // within ~48px of the bottom = following
  }, []);

  // Open / switch the view → always land at the bottom (after content paints).
  useEffect(() => {
    pinned.current = true;
    const id = requestAnimationFrame(toBottom);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  // New content → follow the bottom only if the user hasn't scrolled up to read.
  useEffect(() => {
    if (!pinned.current) return;
    const id = requestAnimationFrame(toBottom);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentKey]);

  return { ref, onScroll, toBottom };
}

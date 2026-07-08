import { useEffect, useRef } from "react";

/// Auto-resize a textarea to fit its content. Call on every value change
/// and attach the returned ref to the textarea. The optional minRows /
/// maxRows are expressed in line-height units and default to 2 and 12.
export function useAutoResize<T extends HTMLTextAreaElement>(
  value: string,
  opts: { minRows?: number; maxRows?: number } = {}
) {
  const ref = useRef<T>(null);
  const { minRows = 2, maxRows = 12 } = opts;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 18;
    const minH = minRows * lineHeight;
    const maxH = maxRows * lineHeight;
    el.style.height = "auto";
    el.style.height = `${Math.max(minH, Math.min(maxH, el.scrollHeight))}px`;
  }, [value, minRows, maxRows]);

  return ref;
}

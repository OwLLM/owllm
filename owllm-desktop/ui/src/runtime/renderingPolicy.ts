// WebKitGTK on Linux can run OwLLM with software compositing (in particular
// NVIDIA arm64, where Rust disables the unstable accelerated renderers).
// Continuously rotating large conic gradients and 30-fps React pulse loops
// then repaint most of the window on the CPU. Keep the activity aura visible,
// but static, on Linux WebKit; Chromium-based development/test browsers and
// the accelerated Windows/macOS webviews retain the motion.

export function isLinuxWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /\bLinux\b/i.test(ua)
    && /AppleWebKit/i.test(ua)
    && !/(?:Chrome|Chromium|Edg)\//i.test(ua);
}

export function continuousUiAnimation(animation: string): string | undefined {
  if (isLinuxWebKit()) return undefined;
  if (typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return undefined;
  }
  return animation;
}

export function continuousUiMotionEnabled(): boolean {
  return continuousUiAnimation("enabled") !== undefined;
}

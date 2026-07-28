// Keep continuous UI motion available on every supported platform. Platform
// renderer defects belong in the native renderer configuration; silently
// deleting the Linux activity glow hides the symptom without fixing its cause.
// The user's explicit reduced-motion preference remains authoritative.

export function isLinuxWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /\bLinux\b/i.test(ua)
    && /AppleWebKit/i.test(ua)
    && !/(?:Chrome|Chromium|Edg)\//i.test(ua);
}

export function continuousUiAnimation(animation: string): string | undefined {
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

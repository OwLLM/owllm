// Honest isolation badge — ONE truth for every surface that runs tools.
//
// The Rust shell router keys isolation off the SAME predicate used here
// (is the cwd a \\wsl.localhost\... UNC path → run inside the distro), so
// this badge cannot drift from what actually happens at execution time:
// it derives from the path, not from a setting or a cached probe.
//
// Three states:
//   isolated       → cwd is inside the sandbox; tools cannot touch the host.
//   host-fallback  → the user ASKED for isolation but this cwd runs on the
//                    host (sandbox unavailable/failed). LOUD red — the user
//                    must know they are no longer isolated (P1-1).
//   host           → isolation off; tools run on the host with the write-
//                    jail + dangerous-command guard only. Amber.

import { isWslPath } from "./wslIsolation";

export type IsolationBadge = {
  /** Tools for this cwd execute inside the sandbox. */
  isolated: boolean;
  /** Isolation was requested but this cwd runs on the host. */
  hostFallback: boolean;
  text: string;
  title: string;
  color: string;
  bg: string;
  border: string;
};

export function isolationBadge(cwd: string | null | undefined, isolationRequested: boolean): IsolationBadge {
  if (isWslPath(cwd)) {
    return {
      isolated: true,
      hostFallback: false,
      text: "🛡 Isolated",
      title: "Isolated: tools run inside Linux (WSL) and cannot touch your Windows files.",
      color: "#7ff0c5",
      bg: "rgba(127,240,197,0.15)",
      border: "#7ff0c555",
    };
  }
  if (isolationRequested) {
    return {
      isolated: false,
      hostFallback: true,
      text: "⚠ HOST — NOT isolated",
      title:
        "Isolation is enabled but this location runs on the HOST (the sandbox is unavailable or this folder is outside it). " +
        "Tools can reach your files — only the write-jail and dangerous-command guard apply. " +
        "Fix WSL on the Home page or convert the project into the sandbox.",
      color: "#ff8c8c",
      bg: "rgba(255,107,107,0.16)",
      border: "#ff8c8c88",
    };
  }
  return {
    isolated: false,
    hostFallback: false,
    text: "⚠ Not isolated",
    title: "Not isolated: tools run on the host (write-jail + dangerous-command guard still apply).",
    color: "#ffd97a",
    bg: "rgba(255,217,122,0.15)",
    border: "#ffd97a55",
  };
}

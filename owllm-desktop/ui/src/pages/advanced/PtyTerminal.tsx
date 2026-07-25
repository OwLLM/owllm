// PtyTerminal — xterm.js mounted into a div, talking to the Rust
// pty_spawn / pty_write / pty_resize / pty_kill commands. Replaces
// the pop-out CMD window we used for subscription-CLI login.
//
// Each spawn creates a fresh terminal instance + a new pty session.
// We DON'T reuse instances across providers because:
//   * the alternate-screen buffer + cursor state from one CLI would
//     bleed into the next
//   * fit dimensions are recomputed on every mount anyway
//
// Lifecycle:
//   * mount → new Terminal(...), open into ref, fit, spawn PTY, hook
//     onData → pty_write, ResizeObserver → pty_resize
//   * unmount → pty_kill (rust drops the master, child exits), then
//     term.dispose()
//
// Bytes are passed as Uint8Array both ways. xterm.write accepts
// Uint8Array since v4; xterm.onData gives us strings (we encode them
// with TextEncoder before forwarding).

import { useEffect, useRef } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

type PtyEvent =
  | { kind: "data"; data: number[] }
  | { kind: "exit"; code: number | null };

export type PtyTerminalProps = {
  /// Absolute path or PATH-resolvable name of the CLI to spawn.
  cli: string;
  /// argv after the cli.
  args: string[];
  /// Working directory for the child. Defaults to USERPROFILE.
  cwd?: string;
  /// Called once the PTY session has been spawned (so the parent can
  /// surface the session id, or store it for a manual kill).
  onSpawned?: (sessionId: string) => void;
  /// Called when the child exits. Parent can swap the terminal out
  /// for a "process exited" placeholder, or auto-close.
  onExit?: (code: number | null) => void;
  /// Text to type into the REPL once it has booted — e.g. "/login\r" for
  /// the Claude / Kimi login REPLs, so Connect logs you in without you
  /// typing it. Sent ONCE, after the child first produces output and the
  /// banner settles (a real readiness signal, not a blind timer). Leave
  /// unset for one-shot login subcommands (codex login, gemini auth login).
  autoSend?: string;
  /// Open the first http(s) URL the child prints in the Agent Browser.
  /// ONLY for login/device-auth terminals (AccountsPage Connect flows).
  /// Leave unset for general-purpose terminals — any command that prints a
  /// URL (git, npm, curl…) would otherwise hijack the browser.
  autoOpenAuthUrls?: boolean;
  onOutputText?: (text: string) => void;
  onAuthTabOpened?: (tabId: number) => void;
};

export default function PtyTerminal({
  cli, args, cwd, onSpawned, onExit, autoSend, autoOpenAuthUrls,
  onOutputText, onAuthTabOpened,
}: PtyTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const autoSendRef = useRef(autoSend);
  autoSendRef.current = autoSend;
  const onOutputTextRef = useRef(onOutputText);
  onOutputTextRef.current = onOutputText;
  const onAuthTabOpenedRef = useRef(onAuthTabOpened);
  onAuthTabOpenedRef.current = onAuthTabOpened;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "ui-monospace, Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: true,
      theme: {
        background: "#0c0f14",
        foreground: "#cfd4e1",
        cursor: "#7fb8ff",
        selectionBackground: "rgba(127,184,255,0.30)",
        black:   "#1a1d24",
        red:     "#ff8c8c",
        green:   "#4caf50",
        yellow:  "#f5d76e",
        blue:    "#7fb8ff",
        magenta: "#d36bff",
        cyan:    "#20b2aa",
        white:   "#cfd4e1",
        brightBlack:   "#5a6376",
        brightRed:     "#ffb0b0",
        brightGreen:   "#7fdb95",
        brightYellow:  "#ffe28a",
        brightBlue:    "#a8d0ff",
        brightMagenta: "#e899ff",
        brightCyan:    "#5fd0c8",
        brightWhite:   "#fafafa",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const dim = fit.proposeDimensions() ?? { cols: 100, rows: 28 };

    // Auto-send (e.g. "/login") once the REPL has actually booted. We key
    // off a REAL signal — the child produced output then went quiet for a
    // beat (banner finished printing, prompt is waiting) — rather than a
    // blind fixed delay. Fires exactly once per session.
    let autoSent = false;
    let autoSendTimer: number | undefined;
    let authUrlOpened = false;
    const decoder = new TextDecoder();
    let outputText = "";
    const openAuthUrlFrom = (decoded: string) => {
      if (!autoOpenAuthUrls || authUrlOpened) return;
      outputText = (outputText + decoded).slice(-16_384);
      // Device-login URLs are sometimes wrapped in OSC-8 hyperlinks. Strip
      // terminal control sequences before matching, while preserving chunks so
      // a URL split across two PTY reads is still found.
      const plain = outputText
        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      const matches = plain.match(/https?:\/\/[^\s"'<>\\]+/g) ?? [];
      for (const raw of matches) {
        const url = raw.replace(/[),.;\]}]+$/, "");
        authUrlOpened = true;
        invoke<string>("browser_open_tab", { url, activate: true })
          .then((opened) => {
            try {
              const parsed = JSON.parse(opened) as { tab_id?: number };
              if (typeof parsed.tab_id === "number") onAuthTabOpenedRef.current?.(parsed.tab_id);
            } catch { /* older browser response; completion falls back to active tab */ }
          })
          .catch((error) => {
            term.write(`\r\n\x1b[31m[OwLLM browser error] ${String(error)}\x1b[0m\r\n`);
          });
        // A login command can later print help/fallback links. Keep the browser
        // on the first authorization page instead of navigating it away.
        return;
      }
    };
    const armAutoSend = () => {
      const payload = autoSendRef.current;
      if (autoSent || !payload || !sessionRef.current) return;
      if (autoSendTimer) window.clearTimeout(autoSendTimer);
      autoSendTimer = window.setTimeout(() => {
        if (autoSent || !sessionRef.current) return;
        autoSent = true;
        invoke("pty_write", {
          sessionId: sessionRef.current,
          data: Array.from(new TextEncoder().encode(payload)),
        }).catch(() => {});
      }, 600);
    };

    const channel = new Channel<PtyEvent>();
    channel.onmessage = (evt) => {
      if (evt.kind === "data") {
        // The Rust side ships bytes as a JSON number array. Reassemble
        // into a Uint8Array for xterm so binary-safe ANSI sequences
        // survive (xterm decodes UTF-8 internally).
        const bytes = new Uint8Array(evt.data);
        term.write(bytes);
        const decoded = decoder.decode(bytes, { stream: true });
        const plain = decoded
          .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
        onOutputTextRef.current?.(plain);
        openAuthUrlFrom(decoded);
        armAutoSend();
      } else if (evt.kind === "exit") {
        // Soft visual hint at exit; the parent decides whether to
        // unmount or leave the terminal up for the user to read.
        term.write(`\r\n\x1b[90m[process exited${evt.code != null ? ` with code ${evt.code}` : ""}]\x1b[0m\r\n`);
        onExitRef.current?.(evt.code);
      }
    };

    invoke<string>("pty_spawn", {
      cli,
      args,
      cwd,
      cols: dim.cols,
      rows: dim.rows,
      onEvent: channel,
    })
      .then((sid) => {
        sessionRef.current = sid;
        onSpawned?.(sid);
        // Wire keystrokes after we have a session id so we don't
        // ship inputs to a non-existent PTY.
        term.onData((data) => {
          if (!sessionRef.current) return;
          const bytes = new TextEncoder().encode(data);
          invoke("pty_write", {
            sessionId: sessionRef.current,
            data: Array.from(bytes),
          }).catch(() => {});
        });
        term.onResize(({ cols, rows }) => {
          if (!sessionRef.current) return;
          invoke("pty_resize", { sessionId: sessionRef.current, cols, rows }).catch(() => {});
        });
      })
      .catch((e) => {
        term.write(`\x1b[31m[spawn error] ${String(e)}\x1b[0m\r\n`);
      });

    // Keep xterm sized to its container. ResizeObserver triggers fit
    // which in turn triggers onResize → pty_resize. Throttle via rAF
    // so a fast drag doesn't fire dozens of resize IPCs per frame.
    let rafId = 0;
    const ro = new ResizeObserver(() => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        try { fit.fit(); } catch { /* host detached */ }
      });
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      if (autoSendTimer) window.clearTimeout(autoSendTimer);
      const sid = sessionRef.current;
      sessionRef.current = null;
      if (sid) invoke("pty_kill", { sessionId: sid }).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // We intentionally re-spawn when cli/args change — each Connect
    // click should get a fresh terminal session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cli, JSON.stringify(args), cwd]);

  return (
    <div
      ref={hostRef}
      style={{
        width: "100%", height: "100%",
        background: "#0c0f14",
        padding: 6,
        boxSizing: "border-box",
      }}
    />
  );
}

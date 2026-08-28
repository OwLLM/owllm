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

import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { firstCompleteAuthUrl, firstDeviceCode } from "./authUrlCapture";
import { authStateFromUrl, isStaleAuthCode } from "./authCodeGuard";
import { unwrapTerminalLines, type TerminalRow } from "./unwrapTerminalLines";

/// Rows of terminal scrollback searched for a login URL. A login banner plus a
/// wrapped authorization URL is far short of this, and it bounds the scan.
const MAX_SCANNED_ROWS = 400;

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
  /// Whether the terminal is currently visible. The rail keeps the terminal
  /// mounted while the log tab is selected, so xterm needs an explicit
  /// visibility signal to recalculate dimensions and restore focus.
  visible?: boolean;
  /// Text to type into the REPL once it has booted — e.g. "/login\r" for
  /// the Claude / Kimi login REPLs, so Connect logs you in without you
  /// typing it. Sent ONCE, after the child first produces output and the
  /// banner settles (a real readiness signal, not a blind timer). Leave
  /// unset for one-shot login subcommands (codex login, gemini auth login).
  autoSend?: string;
  /// Open the first http(s) URL the child prints in a private Agent Browser
  /// tab. Provider OAuth must not inherit Gmail/Claude cookies or saved-login
  /// autofill from the user's ordinary persistent browser tabs.
  /// ONLY for login/device-auth terminals (AccountsPage Connect flows).
  /// Leave unset for general-purpose terminals — any command that prints a
  /// URL (git, npm, curl…) would otherwise hijack the browser.
  autoOpenAuthUrls?: boolean;
  /// Subscription backend owning this login PTY. Used only to route a
  /// provider callback code back to the terminal that requested it.
  authProvider?: string;
  onOutputText?: (text: string) => void;
  onAuthTabOpened?: (tabId: number) => void;
};

export default function PtyTerminal({
  cli, args, cwd, onSpawned, onExit, autoSend, autoOpenAuthUrls,
  authProvider, onOutputText, onAuthTabOpened, visible = true,
}: PtyTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const pendingInputRef = useRef<string[]>([]);
  const inputErrorRef = useRef(false);
  const lastAuthCodeRef = useRef("");
  /// `state` parameter of THIS session's authorize URL. Callback codes carry
  /// the same value after `#`; a mismatch means the code belongs to an earlier
  /// sign-in attempt (a stale tab) and would make the CLI exit on the spot.
  const authStateRef = useRef("");
  const [toolbarError, setToolbarError] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  /// One-time code a device-auth CLI (codex, grok, kimi) is waiting for the
  /// user to type into the sign-in page. Shown as a copy button because an
  /// xterm selection does not reach the clipboard.
  const [deviceCode, setDeviceCode] = useState("");
  const [codeCopied, setCodeCopied] = useState(false);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const autoSendRef = useRef(autoSend);
  autoSendRef.current = autoSend;
  const onOutputTextRef = useRef(onOutputText);
  onOutputTextRef.current = onOutputText;
  const onAuthTabOpenedRef = useRef(onAuthTabOpened);
  onAuthTabOpenedRef.current = onAuthTabOpened;

  const ptyWrite = (data: string) => {
    const sid = sessionRef.current;
    if (!sid) {
      pendingInputRef.current.push(data);
      return;
    }
    invoke("pty_write", {
      sessionId: sid,
      data: Array.from(new TextEncoder().encode(data)),
    }).catch((error) => {
      // Never swallow this: a rejected write means the PTY session is gone, and
      // silence makes the terminal look alive while it ignores every keystroke.
      if (inputErrorRef.current) return;
      inputErrorRef.current = true;
      termRef.current?.write(
        `\r\n\x1b[31m[input error] ${String(error)} — click Connect to start a fresh terminal.\x1b[0m\r\n`,
      );
    });
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    // Capture before xterm's hidden textarea. WKWebView can otherwise route
    // Command-V to the WebView edit menu without xterm emitting onData.
    event.preventDefault();
    event.stopPropagation();
    setToolbarError("");
    ptyWrite(text);
  };

  /// Device-auth codes only ever exist in the terminal, and an xterm selection
  /// does not reach the clipboard. Without this the user has to re-type the
  /// code into the sign-in page by hand.
  const copyDeviceCode = async () => {
    try {
      await navigator.clipboard.writeText(deviceCode);
      setToolbarError("");
      setCodeCopied(true);
      window.setTimeout(() => setCodeCopied(false), 2000);
    } catch (error) {
      setCodeCopied(false);
      setToolbarError(`Couldn't copy the code: ${String((error as { message?: string })?.message ?? error)} Select it in the terminal and copy manually.`);
    }
  };

  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) throw new Error("The clipboard has no text.");
      setToolbarError("");
      ptyWrite(text);
      termRef.current?.focus();
    } catch (error) {
      setToolbarError(`Couldn't read the clipboard: ${String((error as { message?: string })?.message ?? error)} Press ⌘V inside the terminal instead.`);
    }
  };

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
    host.tabIndex = 0;
    termRef.current = term;
    fitRef.current = fit;
    pendingInputRef.current = [];
    inputErrorRef.current = false;
    // A fresh Connect must never offer the previous session's expired code.
    setDeviceCode("");
    setCodeCopied(false);

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
    // Read the login URL back from the terminal's own buffer, where the wrap is
    // recorded per row, rather than re-deriving it from the byte stream. Falls
    // back to the raw bytes if the buffer cannot be read.
    const bufferedText = (): string => {
      const buffer = termRef.current?.buffer.active;
      if (!buffer) return outputText;
      const rows: TerminalRow[] = [];
      for (let i = Math.max(0, buffer.length - MAX_SCANNED_ROWS); i < buffer.length; i += 1) {
        const line = buffer.getLine(i);
        if (line) rows.push({ text: line.translateToString(true), isWrapped: line.isWrapped });
      }
      return rows.length ? unwrapTerminalLines(rows) : outputText;
    };
    const openAuthUrl = (url: string) => {
      invoke<string>("browser_open_auth_tab", { url })
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
    };
    const noteAuthUrlFrom = (decoded: string) => {
      if (!autoOpenAuthUrls) return;
      outputText = (outputText + decoded).slice(-16_384);
      const buffered = bufferedText();
      // Scanned independently of the URL: codex prints its one-time code AFTER
      // the link, so a scan that gave up when no URL was pending never saw it.
      const code = firstDeviceCode(buffered);
      if (code) {
        setDeviceCode((current) => (current === code ? current : code));
      }
      const url = firstCompleteAuthUrl(buffered);
      if (!url) return;
      // Keep the URL reachable from the header even once it has scrolled away,
      // and whether or not opening it succeeded. Automatic opening is a
      // convenience; without a manual way in, a single miss leaves sign-in with
      // no route at all.
      setAuthUrl(url);
      authStateRef.current = authStateFromUrl(url);
      if (authUrlOpened) return;
      authUrlOpened = true;
      openAuthUrl(url);
    };
    const armAutoSend = () => {
      const payload = autoSendRef.current;
      if (autoSent || !payload || !sessionRef.current) return;
      if (autoSendTimer) window.clearTimeout(autoSendTimer);
      autoSendTimer = window.setTimeout(() => {
        if (autoSent || !sessionRef.current) return;
        autoSent = true;
        ptyWrite(payload);
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
        noteAuthUrlFrom(decoded);
        armAutoSend();
      } else if (evt.kind === "exit") {
        // Soft visual hint at exit; the parent decides whether to
        // unmount or leave the terminal up for the user to read.
        term.write(`\r\n\x1b[90m[process exited${evt.code != null ? ` with code ${evt.code}` : ""}]\x1b[0m\r\n`);
        onExitRef.current?.(evt.code);
      }
    };

    // Register before spawning so an early click or paste is queued instead
    // of being lost during the PTY handshake.
    term.onData((data) => ptyWrite(data));

    // Claude's current browser flow ends on platform.claude.com with a code
    // that its CLI is waiting to read from this PTY. The native browser emits
    // that code only to the main app; route it to the matching live terminal
    // and submit it exactly once without putting the secret in logs or state.
    const authUnlisten = listen<{ code?: string }>("owllm:claude-auth-code", (event) => {
      if (authProvider !== "claude_cli") return;
      const code = event.payload?.code?.trim();
      if (!code || code === lastAuthCodeRef.current) return;
      // The CLI exits permanently on the FIRST rejected code, so a code minted
      // by a stale sign-in tab must never be typed.
      if (isStaleAuthCode(code, authStateRef.current)) {
        term.write(
          "\r\n\x1b[33m[sign-in] Ignored a code from an earlier sign-in attempt — finish the flow in the newest sign-in tab.\x1b[0m\r\n",
        );
        return;
      }
      lastAuthCodeRef.current = code;
      ptyWrite(`${code}\r`);
      term.focus();
    });

    let disposed = false;
    invoke<string>("pty_spawn", {
      cli,
      args,
      cwd,
      cols: dim.cols,
      rows: dim.rows,
      onEvent: channel,
    })
      .then((sid) => {
        if (disposed) {
          // A provider switch or a second Connect can win this race. Adopting
          // the late session here would leak a child process and point the next
          // terminal's input at the wrong PTY.
          invoke("pty_kill", { sessionId: sid }).catch(() => {});
          return;
        }
        sessionRef.current = sid;
        onSpawned?.(sid);
        const queued = pendingInputRef.current.splice(0);
        queued.forEach((data) => ptyWrite(data));
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
      disposed = true;
      ro.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      if (autoSendTimer) window.clearTimeout(autoSendTimer);
      authUnlisten.then((unlisten) => unlisten()).catch(() => {});
      const sid = sessionRef.current;
      sessionRef.current = null;
      if (sid) invoke("pty_kill", { sessionId: sid }).catch(() => {});
      pendingInputRef.current = [];
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // We intentionally re-spawn when cli/args change — each Connect
    // click should get a fresh terminal session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cli, JSON.stringify(args), cwd, authProvider]);

  useEffect(() => {
    if (!visible) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    requestAnimationFrame(() => {
      try {
        fit.fit();
        term.focus();
      } catch { /* terminal is being unmounted */ }
    });
  }, [visible]);

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#0c0f14" }}>
      <div style={{ minHeight: 30, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, padding: "3px 8px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        {toolbarError && <span role="alert" style={{ flex: 1, color: "#ffb0b0", fontSize: 10 }}>{toolbarError}</span>}
        {deviceCode && (
          <button
            type="button"
            onClick={() => { void copyDeviceCode(); }}
            title="Copy the one-time code, then paste it into the sign-in page"
            style={{ border: "1px solid rgba(255,226,138,0.45)", borderRadius: 5, background: "rgba(255,226,138,0.12)", color: "#ffe28a", fontSize: 11, padding: "3px 9px", cursor: "pointer", fontFamily: "ui-monospace, Menlo, Consolas, monospace" }}
          >{codeCopied ? "✓ Copied" : `⧉ Copy code ${deviceCode}`}</button>
        )}
        {authUrl && (
          <button
            type="button"
            onClick={() => { void invoke("browser_open_auth_tab", { url: authUrl }); }}
            title={authUrl}
            style={{ border: "1px solid rgba(127,219,149,0.45)", borderRadius: 5, background: "rgba(127,219,149,0.12)", color: "#cfd4e1", fontSize: 11, padding: "3px 9px", cursor: "pointer" }}
          >⧉ Open sign-in page</button>
        )}
        <button
          type="button"
          onClick={() => { void pasteClipboard(); }}
          title="Paste clipboard into terminal"
          style={{ border: "1px solid rgba(127,184,255,0.35)", borderRadius: 5, background: "rgba(127,184,255,0.10)", color: "#cfd4e1", fontSize: 11, padding: "3px 9px", cursor: "pointer" }}
        >Paste</button>
      </div>
      <div
        ref={hostRef}
        onClick={() => termRef.current?.focus()}
        onPasteCapture={handlePaste}
        style={{
          width: "100%", flex: 1, minHeight: 0,
          background: "#0c0f14",
          padding: 6,
          boxSizing: "border-box",
          outline: "none",
        }}
        aria-label="Interactive provider terminal"
      />
    </div>
  );
}

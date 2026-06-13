// The Watcher — OWLLM's in-app support assistant (P0-8).
//
// Summoned from the unlabeled owl in the HybridFrame top-center. This is
// the Slice-1/2 surface: an animated drawer with app-aware actions —
// "What page am I on?", "Check my setup" (the support_snapshot command,
// composed from the app's real probes) and a "Report a bug" entry point
// (the full reporter ships in a later slice). Everything here is local;
// nothing leaves the device.

import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { getActivity, clearActivity, activityLines } from "./activityStats";
import { redactForReport } from "./redact";
// Model discovery + dispatch: the SAME machinery the rest of the app uses
// (shared ModelPicker catalogue + the shared dispatch paths) — never a
// parallel model list (P0-8 Slice 5).
import ModelPicker, { buildEntries, type AccountsStatusLite } from "../pages/agentic/ModelPicker";
import {
  streamLocalChat,
  streamChatCompletion,
  providerFor,
  type ModelInfo,
  type HistoryItem,
} from "../pages/agentic/dispatch";

type ReadinessRow = { ok: boolean; warn: boolean; detail: string };
type SupportSnapshot = {
  appVersion: string;
  os: string;
  arch: string;
  cpu: string;
  gpus: string[];
  ramTotalGb: number;
  readiness: { wsl: ReadinessRow; gpu: ReadinessRow; env: ReadinessRow; runtime: ReadinessRow };
  server: { running: boolean; model_id: string | null; port: number | null; message: string };
  wslStage: string;
  wslDetail: string;
  modules: string[];
};

type Entry = { from: "watcher" | "you"; text: string; imageDataUrl?: string };

type WindowCapture = { pngBase64: string; width: number; height: number; notCaptured: string };

type ServerStatusT = { running: boolean; model_id: string | null; port: number | null; message: string };

/// How the Watcher will answer an AI question.
type ModelChoice =
  | { kind: "local"; modelId: string; port: number; label: string }
  | { kind: "cloud"; modelId: string; provider: string; label: string; preconsented?: boolean }
  | { kind: "local-cold"; label: string }   // local models exist, server not running
  | { kind: "none" };

const WATCHER_PERSONA =
  "You are The Watcher, OWLLM's in-app support assistant. You are given a JSON snapshot of the app's " +
  "real state (readiness, hardware, server, WSL, modules). Help the user in plain language: likely cause, " +
  "immediate fix steps, whether it looks like a product bug, and minimal repro steps when relevant. " +
  "Be concise and concrete. If the snapshot already shows the answer (a ❌ row, a crashed server message), " +
  "lead with it. Never invent state that isn't in the snapshot.";

/// Human blurbs for the page the user is looking at — keyed by activeKey.
const PAGE_BLURBS: Record<string, string> = {
  home: "the Home page — system status, readiness checks, and quick setup actions live here.",
  agents: "the Agentic Team page — orchestrator + specialist agents that fan out on your goal. Pick a project location, type a goal, hit Run.",
  code: "the Code page — a single coding agent working in a project folder (isolated in WSL when the badge is green).",
  chat: "the fine-tuning Chat playground — talk to local or cloud models, with tools, in up to three columns.",
  train: "the Train page — fine-tune models on your data (needs the environment installed: Environment button).",
  models: "the Models page — your downloaded and fine-tuned models.",
  server: "the Server page — start/stop the local llama.cpp model server.",
  bridges: "the Bridges page — connect Telegram / WhatsApp / Discord / Slack / email to your agents.",
};

function rowIcon(r: ReadinessRow): string {
  return r.ok ? "✅" : r.warn ? "⚠️" : "❌";
}

export default function WatcherDrawer({
  open,
  onClose,
  mode,
  activeKey,
}: {
  open: boolean;
  onClose: () => void;
  mode: string;
  activeKey: string;
}) {
  const [entries, setEntries] = React.useState<Entry[]>([
    {
      from: "watcher",
      text: "I'm The Watcher — I can see how this app is doing and help you when something misbehaves. Everything I look at stays on this device.",
    },
  ]);
  const [busy, setBusy] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  // AI chat (Slice 5): free-text questions answered by an auto-chosen model.
  const [draft, setDraft] = React.useState("");
  const [models, setModels] = React.useState<ModelInfo[]>([]);
  const [accounts, setAccounts] = React.useState<AccountsStatusLite | null>(null);
  const [server, setServer] = React.useState<ServerStatusT | null>(null);
  // Cloud use needs one explicit confirmation (the question + snapshot
  // leave the device). Holds the pending question while we wait.
  const pendingCloud = React.useRef<string | null>(null);
  const historyRef = React.useRef<HistoryItem[]>([]);
  const abortRef = React.useRef<AbortController | null>(null);
  // ALL hooks live up here, before the `if (!open) return null` early
  // return — a hook below it changes the hook count between renders and
  // crashes React with error #310 (caught by the release smoke test).
  const lastCapture = React.useRef<WindowCapture | null>(null);
  const reportPreview = React.useRef<{ json: string; png: string | null } | null>(null);
  const [reportArmed, setReportArmed] = React.useState(false);
  // User-chosen model via the SHARED ModelPicker (same catalogue as every
  // other surface — local models, tuned, subscriptions, API keys, Auto).
  // Empty = the Watcher's default policy (running local first). Persisted.
  const [pickedModel, setPickedModel] = React.useState<string>(() => {
    try { return localStorage.getItem("owllm:watcher:model") ?? ""; } catch { return ""; }
  });
  const pickModel = (id: string) => {
    setPickedModel(id);
    try { localStorage.setItem("owllm:watcher:model", id); } catch { /* ignore */ }
  };
  // While capturing, the Watcher steps OUT of the shot (stays mounted,
  // visibility hidden) so the screenshot shows the app/bug BEHIND it.
  const [selfHidden, setSelfHidden] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    invoke<ModelInfo[]>("list_models").then((m) => setModels(Array.isArray(m) ? m : [])).catch(() => {});
    invoke<AccountsStatusLite>("accounts_status").then(setAccounts).catch(() => {});
    invoke<ServerStatusT>("server_status").then(setServer).catch(() => {});
    return () => { abortRef.current?.abort(); };
  }, [open]);

  /// Resolve which model answers. An EXPLICIT user pick (shared ModelPicker)
  /// wins; otherwise the default policy: a running local model first (private
  /// + free), else the first available cloud entry (subscription before API
  /// key), else say what's missing. Never silently cloud.
  const chooseModel = (): ModelChoice => {
    const entries = buildEntries(models, accounts);
    // 1) Explicit user choice from the picker.
    if (pickedModel) {
      const prov = providerFor(pickedModel, models);
      const label = entries.find((e) => e.id === pickedModel)?.label ?? pickedModel;
      if (prov === "local" || prov === "tuned") {
        if (server?.running && server.model_id) {
          return { kind: "local", modelId: server.model_id, port: server.port ?? 0, label: `${server.model_id} (local)` };
        }
        return { kind: "local-cold", label };
      }
      // cloud / subscription / API / auto — explicitly chosen ⇒ pre-consented.
      return { kind: "cloud", modelId: pickedModel, provider: prov, label, preconsented: true };
    }
    // 2) Default policy.
    if (server?.running && server.model_id) {
      return {
        kind: "local",
        modelId: server.model_id,
        port: server.port ?? 0,
        label: `${server.model_id} (local — private, free)`,
      };
    }
    const cloud =
      entries.find((e) => e.available && e.variant === "sub") ??
      entries.find((e) => e.available && e.variant === "api");
    if (cloud) {
      return {
        kind: "cloud",
        modelId: cloud.id,
        provider: providerFor(cloud.id, models),
        label: cloud.label,
      };
    }
    const localExists = entries.some((e) => e.available && (e.section === "local" || e.section === "tuned"));
    if (localExists) return { kind: "local-cold", label: "a local model (server not running)" };
    return { kind: "none" };
  };

  React.useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [entries]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const say = (text: string, from: Entry["from"] = "watcher", imageDataUrl?: string) =>
    setEntries((es) => [...es, { from, text, imageDataUrl }]);

  const whatPage = () => {
    say("What page am I on?", "you");
    const blurb = PAGE_BLURBS[activeKey] ?? `the "${activeKey}" page (mode: ${mode}).`;
    say(`You're on ${blurb}`);
  };

  const checkSetup = async () => {
    say("Check my setup", "you");
    setBusy(true);
    try {
      const s = await invoke<SupportSnapshot>("support_snapshot");
      const lines = [
        `OWLLM ${s.appVersion} · ${s.os}/${s.arch}`,
        `CPU: ${s.cpu || "?"} · RAM ${Math.round(s.ramTotalGb)} GB`,
        `GPU: ${s.gpus.length ? s.gpus.join(", ") : "none detected"}`,
        ``,
        `${rowIcon(s.readiness.wsl)} WSL / Linux sandbox — ${s.readiness.wsl.detail}`,
        `${rowIcon(s.readiness.gpu)} GPU & CUDA — ${s.readiness.gpu.detail}`,
        `${rowIcon(s.readiness.env)} Fine-tuning env — ${s.readiness.env.detail}`,
        `${rowIcon(s.readiness.runtime)} Local LLM runtime — ${s.readiness.runtime.detail}`,
        ``,
        s.server.running
          ? `🟢 Model server: running (${s.server.model_id ?? "?"} on :${s.server.port ?? "?"})`
          : `⚪ Model server: not running${s.server.message ? ` — ${s.server.message}` : ""}`,
        `📦 Modules: ${s.modules.length ? s.modules.join(", ") : "none installed"}`,
      ];
      say(lines.join("\n"));
      const bad = [s.readiness.wsl, s.readiness.env, s.readiness.runtime].filter((r) => !r.ok && !r.warn);
      if (bad.length > 0) {
        say("Something above is ❌ — the Home page has a Set-up button for each red row.");
      }
    } catch (e) {
      say(`I couldn't read the app state: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  // User-approved capture of the APP WINDOW ONLY (in-app modals included —
  // they live in the same WebView surface). The preview is shown before
  // anything could ever join a report; nothing is sent anywhere. The last
  // capture is kept so "Report a bug" can offer to attach it.
  // (lastCapture/reportPreview/reportArmed hooks are declared ABOVE the
  // early return with the other hooks — see the hooks block.)
  const captureApp = async () => {
    say("Capture current app", "you");
    setBusy(true);
    // Step the Watcher OUT of the shot first — otherwise the capture is
    // just this drawer covering the app, and the bug behind is invisible.
    // We stay mounted (visibility:hidden) and wait for the webview to
    // repaint without us, then capture, then come back.
    setSelfHidden(true);
    try {
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      await new Promise((r) => setTimeout(r, 180));
      const c = await invoke<WindowCapture>("support_capture_window");
      lastCapture.current = c;
      setSelfHidden(false);
      say(
        `Here's the capture (${c.width}×${c.height}) — the app as it was, with the Watcher stepped out of the way so the actual screen shows through. Not included: ${c.notCaptured}. ` +
        "It stays on this device unless you attach it to a report later.",
        "watcher",
        `data:image/png;base64,${c.pngBase64}`,
      );
    } catch (e) {
      setSelfHidden(false);
      say(`I couldn't capture the window: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  // Local-only activity stats (Slice 4): product events only — counts of
  // pages visited, installs, server starts, tool failures. View + clear.
  const showActivity = () => {
    say("Show my activity stats", "you");
    const s = getActivity();
    const since = new Date(s.since).toLocaleString();
    say(
      `Local activity since ${since} (product events only — no prompts, files, or keys; never sent anywhere):\n` +
      activityLines(s).join("\n") +
      "\n\nSay the word (the Clear button below) and I'll forget all of it.",
    );
  };

  const wipeActivity = () => {
    clearActivity();
    say("Clear activity stats", "you");
    say("Done — activity counters wiped. A fresh window starts now.");
  };

  /// Free-text AI support: snapshot as grounding, auto-chosen model,
  /// explicit consent before any cloud use, streamed reply.
  const ask = async (raw?: string) => {
    const text = (raw ?? draft).trim();
    if (!text || busy) return;
    setDraft("");
    say(text, "you");
    const choice = chooseModel();
    if (choice.kind === "none") {
      say(
        "You don't have a usable model yet — no local model is downloaded and no cloud account/key is connected. " +
        "The quickest fix: a tiny support model like Gemma 3 1B (Q4, under 1 GB) runs on almost anything. " +
        "Open the Models page (📦 button below) to download one, or connect an account on the Accounts page.",
      );
      return;
    }
    if (choice.kind === "local-cold") {
      say(
        "You have local models, but the model server isn't running — start one on the Server page and ask me again. " +
        "(I only use what's already running; I won't load gigabytes into your GPU unannounced.)",
      );
      return;
    }
    // Cloud egress needs one confirmation — UNLESS the user explicitly
    // picked this cloud model in the dropdown (that pick IS the consent).
    if (choice.kind === "cloud" && !choice.preconsented && pendingCloud.current !== text) {
      pendingCloud.current = text;
      say(
        `No local model is running, so I'd use ${choice.label} — a CLOUD model: your question and the app snapshot ` +
        "would leave this device. Press Send again (or Enter) to confirm, or pick a model below / start a local one.",
      );
      setDraft(text);
      return;
    }
    pendingCloud.current = null;
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    say(`(answering with ${choice.label})`);
    let acc = "";
    // Stream into a dedicated live tail entry, replaced in place per delta.
    const onDelta = (d: string) => {
      acc += d;
      setEntries((es) => {
        const copy = [...es];
        const tail = copy[copy.length - 1] as (Entry & { _live?: boolean }) | undefined;
        if (tail?._live) {
          copy[copy.length - 1] = { ...tail, text: acc };
        } else {
          copy.push({ from: "watcher", text: acc, _live: true } as Entry);
        }
        return copy;
      });
    };
    try {
      const snapshot = await invoke<SupportSnapshot>("support_snapshot").catch(() => null);
      const system = `${WATCHER_PERSONA}\n\nCurrent page: ${activeKey} (mode ${mode})\n\nAPP SNAPSHOT:\n${JSON.stringify(snapshot)}`;
      let reply: string;
      if (choice.kind === "local") {
        reply = await streamLocalChat({
          port: choice.port,
          modelId: choice.modelId,
          systemPrompt: system,
          userContent: text,
          temperature: 0.3,
          signal: ctrl.signal,
          onDelta,
          history: historyRef.current,
          allowedTools: [], // support chat reads the snapshot; no tools
        });
      } else {
        reply = await streamChatCompletion(
          0, choice.modelId, choice.provider, system, text, 0.3, ctrl.signal,
          onDelta, undefined, historyRef.current, false,
        );
      }
      historyRef.current = [
        ...historyRef.current,
        { role: "user" as const, content: text },
        { role: "assistant" as const, content: reply },
      ].slice(-12);
      // Finalize the streamed tail.
      setEntries((es) => es.map((e) => {
        const { _live, ...rest } = e as Entry & { _live?: boolean };
        void _live;
        return rest as Entry;
      }));
    } catch (e: any) {
      if (e?.name !== "AbortError") say(`That didn't work: ${String(e?.message ?? e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Bug report (Slice 6): describe → assemble → REDACT → preview → explicit
  // save. Default path is PRIVATE: a local export bundle — nothing is
  // transmitted anywhere; the user shares the folder however they choose.
  const reportBug = async () => {
    if (reportArmed && reportPreview.current) {
      // Second click = explicit consent to SAVE the previewed bundle.
      setBusy(true);
      try {
        const dir = await invoke<string>("support_export_report", {
          reportJson: reportPreview.current.json,
          pngBase64: reportPreview.current.png,
        });
        say(`Saved the report bundle to:\n${dir}\n\nNothing was transmitted — share that folder with the OWLLM team however you prefer (or delete it).`);
      } catch (e) {
        say(`Saving the report failed: ${e}`);
      } finally {
        reportPreview.current = null;
        setReportArmed(false);
        setBusy(false);
      }
      return;
    }
    const description = draft.trim();
    if (!description) {
      say("Report a bug", "you");
      say("Type what went wrong in the box below (what you did, what you expected, what happened), then press “Report a bug” again. I'll assemble a redacted bundle and show you EXACTLY what it contains before anything is saved.");
      return;
    }
    say(`Report a bug: ${description}`, "you");
    setBusy(true);
    setDraft("");
    try {
      const snapshot = await invoke<SupportSnapshot>("support_snapshot").catch(() => null);
      const lastAi = [...entries].reverse().find((e) => e.from === "watcher" && !e.imageDataUrl)?.text ?? null;
      const bundle = {
        kind: "owllm-bug-report",
        createdAt: new Date().toISOString(),
        appVersion: snapshot?.appVersion ?? "?",
        page: { activeKey, mode },
        description,
        assistantSummary: lastAi,
        snapshot,
        activity: getActivity(),
        screenshotAttached: lastCapture.current != null,
      };
      // Redact BEFORE preview — secrets must not even reach the preview.
      const json = redactForReport(JSON.stringify(bundle, null, 2));
      reportPreview.current = { json, png: lastCapture.current?.pngBase64 ?? null };
      setReportArmed(true);
      const shown = json.length > 5000 ? `${json.slice(0, 5000)}\n… (${json.length - 5000} more chars — the full text is what gets saved)` : json;
      say(
        "Here is EXACTLY what the report bundle contains (already redacted — keys, tokens and home paths are scrubbed):\n\n" +
        shown +
        (lastCapture.current ? "\n\n+ the app capture you took (preview above)." : "\n\nNo screenshot attached — use “Capture current app” first if you want one.") +
        "\n\nPress “Report a bug” again to SAVE this as a local bundle (nothing is sent anywhere), or just keep chatting to discard it.",
        "watcher",
        lastCapture.current ? `data:image/png;base64,${lastCapture.current.pngBase64}` : undefined,
      );
    } catch (e) {
      say(`I couldn't assemble the report: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const actionBtn: React.CSSProperties = {
    padding: "7px 12px", borderRadius: 8, border: "1px solid var(--border-strong)",
    background: "var(--bg-elevated)", color: "var(--fg-strong)", fontSize: 12.5,
    fontWeight: 700, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1,
  };

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 9600, background: "rgba(0,0,0,0.45)",
        // During a capture we vanish (but stay mounted) so the screenshot
        // shows the app/bug behind us, not this drawer.
        visibility: selfHidden ? "hidden" : "visible",
        // Flex-center the drawer WITHOUT a transform — a transformed
        // ancestor would make the ModelPicker's position:fixed popover
        // anchor to the drawer (and get clipped by its overflow:hidden)
        // instead of the screen. That was the hidden/misaligned dropdown.
        display: "flex", justifyContent: "center", alignItems: "flex-start",
      }}
    >
      <style>{`
        @keyframes owllm-watcher-in { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
      <div style={{
        marginTop: 64,
        width: "min(560px, 92%)", maxHeight: "min(620px, 82%)",
        background: "var(--bg-panel)", border: "2px solid rgba(var(--accent-rgb),0.78)",
        borderRadius: 14, boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
        display: "flex", flexDirection: "column", overflow: "hidden",
        animation: "owllm-watcher-in 200ms ease-out",
      }}>
        <div style={{
          height: 50, background: "var(--bg-header)", color: "var(--bg-header-fg)",
          display: "flex", alignItems: "center", gap: 10, padding: "0 16px",
          borderBottom: "1px solid rgba(var(--accent-rgb),0.30)",
        }}>
          <span style={{ fontSize: 20 }}>🦉</span>
          <div style={{ fontWeight: 800, fontSize: 16, letterSpacing: 0.4 }}>The Watcher</div>
          <div style={{ fontSize: 11, color: "var(--fg-muted)", marginLeft: 4 }}>local support assistant</div>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{ width: 32, height: 24, border: "none", background: "rgba(244,67,54,0.18)", color: "#ff8080", fontSize: 13, cursor: "pointer", borderRadius: 5 }}
          >✕</button>
        </div>

        <div ref={listRef} style={{ flex: 1, overflow: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {entries.map((e, i) => (
            <div key={i} style={{
              alignSelf: e.from === "you" ? "flex-end" : "flex-start",
              maxWidth: "88%", padding: "8px 12px", borderRadius: 10,
              whiteSpace: "pre-wrap", fontSize: 12.5, lineHeight: 1.55,
              background: e.from === "you" ? "rgba(var(--accent-rgb),0.16)" : "var(--bg-card)",
              border: `1px solid ${e.from === "you" ? "rgba(var(--accent-rgb),0.4)" : "var(--border)"}`,
              color: "var(--fg)",
            }}>
              {e.text}
              {e.imageDataUrl && (
                <img
                  src={e.imageDataUrl}
                  alt="app capture preview"
                  style={{ display: "block", marginTop: 8, maxWidth: "100%", borderRadius: 8, border: "1px solid var(--border-strong)" }}
                />
              )}
            </div>
          ))}
        </div>

        {/* Model selector — the SAME shared ModelPicker every other surface
            uses (local models, tuned, subscriptions, API keys, Auto). The
            user's pick is honored verbatim; "Auto" falls back to the default
            policy (running local first). */}
        <div style={{ display: "flex", gap: 8, padding: "8px 14px 0", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--fg-muted)", fontWeight: 700, whiteSpace: "nowrap" }}>Model</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <ModelPicker
              value={pickedModel}
              onChange={pickModel}
              models={models}
              status={accounts}
              placeholder="Auto (running local first)"
              fallbackLabel="⚡ Auto (running local first)"
            />
          </div>
          {pickedModel && (
            <button
              onClick={() => pickModel("")}
              title="Back to automatic model choice"
              style={{ ...actionBtn, padding: "5px 9px", fontSize: 11 }}
            >Auto</button>
          )}
        </div>

        {/* Free-text AI support (Slice 5). Uses the model chosen above (or
            the default policy); cloud egress is confirmed once unless you
            explicitly picked a cloud model. */}
        <div style={{ display: "flex", gap: 8, padding: "8px 14px 0", alignItems: "center" }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !busy) ask(); }}
            placeholder="Ask me anything about the app — what broke, what a page does, what to try…"
            disabled={busy}
            style={{
              flex: 1, height: 34, borderRadius: 8, padding: "0 12px", fontSize: 12.5,
              background: "var(--bg-input)", color: "var(--fg-strong)", border: "1px solid var(--border)",
            }}
          />
          <button style={actionBtn} disabled={busy || !draft.trim()} onClick={() => ask()}>
            {busy ? "⏳" : "Send"}
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, padding: "10px 14px", borderTop: "1px solid transparent", flexWrap: "wrap" }}>
          <button style={actionBtn} disabled={busy} onClick={whatPage}>📍 What page am I on?</button>
          <button style={actionBtn} disabled={busy} onClick={checkSetup}>{busy ? "⏳ Checking…" : "🩺 Check my setup"}</button>
          <button style={actionBtn} disabled={busy} onClick={captureApp} title="Captures THIS app window only (in-app popups included). Never other windows or monitors. Shown to you first; nothing is sent.">📸 Capture current app</button>
          <button style={actionBtn} disabled={busy} onClick={showActivity} title="Local-only product-event counters (pages, installs, tool failures). View here, clear any time. Never sent.">📊 Activity</button>
          <button
            style={actionBtn}
            disabled={busy}
            onClick={() => {
              onClose();
              window.dispatchEvent(new CustomEvent("owllm:navigate", { detail: { key: "models" } }));
            }}
            title="No model? A tiny Gemma-class support model (under 1 GB) runs on almost anything — download it on the Models page."
          >📦 Get a model</button>
          <button style={actionBtn} disabled={busy} onClick={wipeActivity} title="Wipe the local activity counters">🧹 Clear</button>
          <button
            style={reportArmed ? { ...actionBtn, background: "linear-gradient(180deg, #ffb74d, #f59e0b)", color: "#241a05", fontWeight: 800 } : actionBtn}
            disabled={busy}
            onClick={reportBug}
            title="Assembles a redacted bundle (description + diagnostics + activity + optional capture), shows you exactly what's in it, and only saves locally on a second click. Nothing is ever auto-sent."
          >{reportArmed ? "💾 Save report bundle" : "🐞 Report a bug"}</button>
        </div>
      </div>
    </div>
  );
}

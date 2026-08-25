/// Background-work continuity — UI side of cli_orphans.rs.
///
/// A Code-page turn that ends while a background process it started is still
/// running used to leave that work orphaned: nobody was left to receive the
/// result, so "I'll commit when the matrix finishes" silently never happened.
/// The Rust watcher adopts those processes and emits:
///
///   cli-orphans-detected  — background work survived the turn; being watched
///   cli-orphans-finished  — the last watched process of a scope exited
///
/// This module is the always-alive listener (module singleton — it survives
/// page unmounts the same way chatRuntime does). CodePage subscribes per
/// workspace scope; a finished event arriving while the page is unmounted is
/// held here and delivered the moment the page subscribes again. On webview
/// (re)load the backend snapshot re-seeds anything the dead listener missed.
///
/// Wire shape is camelCase (serde rename_all) — pinned by the release gate
/// together with the Rust struct, because a serde casing the UI doesn't read
/// is exactly how the WSL host-fallback stayed dead code for two releases.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type OrphanProc = {
  pid: number;
  name: string;
  cmdline: string;
  ranSecs: number;
};

export type OrphanGroup = {
  scope: string;
  orphans: OrphanProc[];
  stillRunning: boolean;
};

export type OrphanEvent =
  | { kind: "detected"; group: OrphanGroup }
  | { kind: "finished"; group: OrphanGroup };

type Subscriber = (ev: OrphanEvent) => void;

const subscribers = new Map<string, Subscriber>();
/// Finished groups that arrived while no page was subscribed to their scope.
const pendingFinished = new Map<string, OrphanGroup>();

let started = false;

function deliver(ev: OrphanEvent) {
  const cb = subscribers.get(ev.group.scope);
  if (cb) {
    cb(ev);
    if (ev.kind === "finished") {
      // Consumed — the backend buffer must not replay it on the next reload.
      void invoke("cli_orphans_ack", { scope: ev.group.scope }).catch(() => {});
    }
    return;
  }
  if (ev.kind === "finished") pendingFinished.set(ev.group.scope, ev.group);
}

/// Idempotent module init: event listeners + a backend snapshot so a webview
/// reload doesn't lose groups that fired while no listener existed.
export function initOrphanContinuation(): void {
  if (started) return;
  started = true;
  void listen<OrphanGroup>("cli-orphans-detected", (e) => {
    deliver({ kind: "detected", group: e.payload });
  });
  void listen<OrphanGroup>("cli-orphans-finished", (e) => {
    deliver({ kind: "finished", group: e.payload });
  });
  void invoke<{ live: OrphanGroup[]; finished: OrphanGroup[] }>("cli_orphans_snapshot")
    .then((snap) => {
      for (const g of snap?.finished ?? []) deliver({ kind: "finished", group: g });
      for (const g of snap?.live ?? []) deliver({ kind: "detected", group: g });
    })
    .catch(() => { /* backend without the watcher (older build) — nothing to seed */ });
}

/// Subscribe a page to one scope. A finished group that arrived while nobody
/// was listening is delivered immediately. Returns the unsubscribe.
export function subscribeOrphanContinuation(scope: string, cb: Subscriber): () => void {
  initOrphanContinuation();
  subscribers.set(scope, cb);
  const held = pendingFinished.get(scope);
  if (held) {
    pendingFinished.delete(scope);
    cb({ kind: "finished", group: held });
    void invoke("cli_orphans_ack", { scope }).catch(() => {});
  }
  return () => {
    if (subscribers.get(scope) === cb) subscribers.delete(scope);
  };
}

function fmtDuration(secs: number): string {
  if (secs >= 3600) return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
  if (secs >= 60) return `${Math.floor(secs / 60)}m${secs % 60}s`;
  return `${secs}s`;
}

function orphanLines(group: OrphanGroup): string {
  return group.orphans
    .map((o) => `- ${o.name} (pid ${o.pid}, ran ${fmtDuration(o.ranSecs)}): ${o.cmdline}`)
    .join("\n");
}

/// The transcript notice shown when background work outlives a turn.
export function orphanDetectedNotice(group: OrphanGroup): string {
  return `⏳ Background work from the last turn is still running — I'll continue automatically when it finishes:\n${orphanLines(group)}`;
}

/// The synthetic user turn that resumes the session once the work ends.
/// It demands verification from the process's own output — the watcher cannot
/// know exit codes (an adopted orphan is not our child process), so "it
/// finished" must never be read as "it succeeded".
export function orphanContinuationPrompt(group: OrphanGroup): string {
  if (group.stillRunning) {
    return (
      "[Automatic continuation] Background process(es) started in a previous turn are STILL running after the 2-hour watch ceiling:\n" +
      `${orphanLines(group)}\n` +
      "Check whether they are wedged or genuinely long-running, report their real state, and finish the remaining work you promised."
    );
  }
  return (
    "[Automatic continuation] The background process(es) started in a previous turn have finished:\n" +
    `${orphanLines(group)}\n` +
    "Their exit codes are unknown to the watcher — read their actual output/logs now, verify the real result (never assume success), and complete the remaining work you promised. If everything was already delivered, reply with a short confirmation."
  );
}

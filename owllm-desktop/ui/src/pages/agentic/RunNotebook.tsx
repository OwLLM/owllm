// RunNotebook — the user's live scratchpad WHILE agents work.
//
// Three jobs in one surface:
//   1. Working notes — one freeform place the user writes in during a run
//      (ideas, refactors, feature thoughts). Autosaved per project.
//   2. Plan — a small Kanban board distilled from the notes and edited freely.
//   3. Next steps — an ordered to-do list. Each step can be fed to the
//      team: mid-run it becomes a steer; when idle it dispatches as a new
//      goal. With AUTO-FEED on, a cleanly finished run pushes the next
//      pending step automatically.
//
// The digest agent is intentionally not a second chat box. It reads the
// working notes + current plan + existing steps, then proposes plan/step
// changes for one-click apply/add. The raw digest transcript is retained as
// a collapsible log for debugging only.
//
// The component renders inline in the Code page's right column and as a
// modal from the Agents page. Both modes share the same vertical,
// content-sized cards: every text area and step card grows with its content
// so long notes and long steps are always readable without popups.
//
// State is one localStorage blob per project (owllm:agents:notebook:<pid>).
// AgentsPage reads the same blob at run-end for auto-feed via the exported
// helpers, and both sides broadcast NOTEBOOK_EVENT so the open surface and
// the page never go stale against each other.
//
// Cross-device: vaultSync mirrors the blob to the user's other PCs. Two rules
// make that safe, and both live in this file's data model:
//   • `updatedAt` — stamped on every save. Ordering used to come from the vault
//     blob's single syncedAt, which covered EVERY localStorage key, so an
//     unrelated setting change on a stale PC republished its stale notebook as
//     "newer" and completed steps came back as pending.
//   • `deletedSteps` — tombstones. Steps merge as a UNION by id (peer progress
//     is never clobbered), and a union without tombstones resurrects everything
//     the user deleted.
// The run-lease (autoFeed* fields) is deliberately device-local and stripped
// before sync; `runningOn` is the advisory that replaces it across PCs.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAutoResize } from "../../hooks/useAutoResize";
import LogBox from "../../components/LogBox";
import { type ModelInfo, streamChatCompletion, providerFor } from "./dispatch";
import ModelPicker, { type AccountsStatusLite } from "./ModelPicker";
import { formatDuration, formatClock, useTick } from "./RunTimer";
import { translateUiText } from "../../localization";
import ActionIcon from "../../components/ActionIcon";

export type NotebookStep = {
  id: string;
  text: string;
  /// pending = not fed · sent = live/successful run · failed = run ended
  /// unsuccessfully and stays actionable · done = user explicitly checked it.
  status: "pending" | "sent" | "failed" | "done";
  ts: number;
  /// When this step was fed to the team (started as a job).
  startedAt?: number;
  /// When the run that processed this step finished.
  finishedAt?: number;
  /// Concise reason the last run did not complete. Failed steps stay on Active
  /// with a Re-feed action instead of being silently archived.
  failureReason?: string;
};

export type NotebookState = {
  text: string;
  /// The PLAN — a living document the digest agent drafts from the
  /// brainstorm (objective, approach, ordered milestones) and the user
  /// edits freely. Steps are the feedable units cut from it.
  plan: string;
  steps: NotebookStep[];
  autoFeed: boolean;
  /// Which surface DRIVES auto-feed — the notebook blob is shared per project,
  /// so without an owner every open page on the project popped the queue at
  /// its own run end (a second page opened "to do something else" started
  /// feeding notebook steps). The surface whose toggle turned auto-feed on
  /// owns it; unchecking from ANY page stops it everywhere.
  autoFeedOwner?: string;
  /// Liveness beacon the OWNER window stamps every few seconds while it drives
  /// an active queue. Other windows treat the lease as held only while this is
  /// fresh — so a window closed/crashed mid-queue stops ghosting the rest and
  /// any window can take over, but a genuinely live owner keeps its exclusive
  /// hold. Device-local: stripped before the blob syncs (see vaultSync).
  autoFeedHeartbeat?: number;
  /// Wall-clock bounds for one whole auto-fed queue run. Unlike the queue
  /// total below, this includes the gaps between jobs as well as their work.
  autoFeedStartedAt?: number;
  autoFeedFinishedAt?: number;
  /// A user may turn auto-feed off before the queue is empty. Keep that
  /// distinct from a naturally completed sequence in the timing display.
  autoFeedStopped?: boolean;
  /// EXPLICIT one-shot permission to START the chain from a run this queue did
  /// not itself dispatch. Set only by ▶ Start queue pressed while the agent is
  /// already busy ("begin as soon as this finishes"), and consumed by the first
  /// run end that uses it. Without it, `autoFeed` alone was enough for ANY
  /// clean run to pop a card: a plain chat message on the Coding page ended
  /// cleanly and silently resumed a queue the user had left switched on days
  /// earlier, injecting a notebook step as if the user had typed it. The
  /// checkbox now only governs whether a running chain CONTINUES; starting one
  /// is always a deliberate click. Device-local: stripped before sync.
  autoFeedArmed?: boolean;
  /// ADVISORY (unlike the run-lease above, this one DOES sync): the device that
  /// most recently started driving this queue. A peer PC reads it only to SAY
  /// "the queue is running on <name>" — it is never a lock. Device clocks are
  /// not synchronized, so a stale/skewed stamp must never be able to block a
  /// user from starting their own queue.
  runningOn?: { deviceId: string; deviceName: string; at: number };
  digest: Array<{ role: "you" | "digest"; text: string }>;
  /// Content stamp, rewritten by every saveNotebook. This is what lets two PCs
  /// order their copies of THIS notebook. The vault blob's single `syncedAt`
  /// covers every localStorage key at once, so without a per-notebook stamp an
  /// unrelated setting change on a stale PC republished its stale notebook as
  /// "newer" and archived steps came back. See vaultSync → mergeNotebook.
  updatedAt?: number;
  /// Tombstones for steps deleted on ANY device. Steps merge as a union by id
  /// across PCs (so a peer's completion is never overwritten by our stale
  /// copy), and a union without tombstones resurrects everything the user
  /// deliberately removed. Capped and pruned in saveNotebook.
  deletedSteps?: Array<{ id: string; ts: number }>;
  /// User-picked digest model (per project). Empty/undefined = inherit the
  /// surface's default (team model → server model), same rule as before.
  digestModel?: string;
  /// Digest output awaiting one-click apply/add. PERSISTED (not component
  /// state) so a tab switch or modal close mid-review never loses proposals.
  proposed?: string[];
  proposedPlan?: string;
};

export const NOTEBOOK_EVENT = "owllm:notebook-changed";
const EMPTY: NotebookState = { text: "", plan: "", steps: [], autoFeed: false, digest: [], deletedSteps: [] };
const keyFor = (projectId: string) => `owllm:agents:notebook:${projectId}`;
// The auto-feed/owner/sequence-clock fields below are the notebook's RUN-LEASE:
// they live IN this blob so tabs on THIS PC coordinate the queue through it, but
// vaultSync strips them before syncing to the user's other PCs (the queue owner
// is a live per-window concept — a peer PC must never inherit it, or its own
// window would think it owns a queue it never started). See vaultSync.ts →
// NOTEBOOK_RUN_LEASE_FIELDS / stripNotebookLease.
const newStepId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// Queue-lease liveness: the owner window beats every HEARTBEAT_MS; other windows
// treat the lease as held only while the last beat is within LEASE_TTL_MS (a
// couple of missed beats are tolerated before a lock releases to a takeover).
const NOTEBOOK_HEARTBEAT_MS = 8_000;
const NOTEBOOK_LEASE_TTL_MS = 20_000;

/// True only when ANOTHER surface owns the queue AND is still beating. The
/// run-end helpers below used to compare owners alone, so a window that owned
/// the queue and was then closed (or a Coding page that toggled auto-feed on
/// and was navigated away from) left an owner string nothing could clear:
/// takeNextAutoStep returned null forever, autoFeedWouldRun suppressed the very
/// "auto-feed paused" notice meant to explain it, and the queue silently
/// stopped with the toggle still reading ON. A dead owner now releases, exactly
/// as the UI's own takeover button already assumed.
export function leaseHeldByOtherSurface(nb: NotebookState, surfaceId: string): boolean {
  if (!nb.autoFeedOwner || nb.autoFeedOwner === surfaceId) return false;
  return nb.autoFeedHeartbeat != null && (Date.now() - nb.autoFeedHeartbeat) < NOTEBOOK_LEASE_TTL_MS;
}

/// Identity behind the cross-PC "queue is running on <name>" advisory. The
/// notebook helpers below are SYNCHRONOUS (they run inside run-end finally
/// blocks), so identity is fetched once in the background and read from this
/// cache. Until it warms we simply omit the advisory rather than guess.
let _selfDevice: { deviceId: string; deviceName: string } | null = null;
let _selfDeviceFetching = false;
export function warmNotebookDeviceIdentity(): void {
  if (_selfDevice || _selfDeviceFetching) return;
  _selfDeviceFetching = true;
  void invoke<{ device_id: string; name: string }>("device_get_identity")
    .then((d) => {
      if (d?.device_id) _selfDevice = { deviceId: d.device_id, deviceName: (d.name || d.device_id.slice(0, 8)).trim() };
    })
    .catch(() => { /* advisory only — never block the queue on identity */ })
    .finally(() => { _selfDeviceFetching = false; });
}
function describeThisDeviceRun(at: number): NotebookState["runningOn"] {
  return _selfDevice ? { ..._selfDevice, at } : undefined;
}

/// The advisory is informational ONLY — it never disables anything. Device
/// clocks are not synchronized (this vault's own history shows peers writing
/// out-of-order timestamps), so treating a peer stamp as a lock could lock the
/// user out of their own queue. A generous window keeps it from claiming a
/// long-finished run is still going.
const RUNNING_ON_STALE_MS = 30 * 60_000;
export function peerRunningQueue(nb: NotebookState): { deviceName: string; at: number } | null {
  const r = nb.runningOn;
  if (!r || !_selfDevice || r.deviceId === _selfDevice.deviceId) return null;
  if (Date.now() - r.at > RUNNING_ON_STALE_MS) return null;
  if (!nb.steps.some((s) => s.status === "pending" || (s.status === "sent" && s.finishedAt == null))) return null;
  return { deviceName: r.deviceName, at: r.at };
}

export function isLegacyWslRedirectorFalseFailure(step: NotebookStep): boolean {
  return step.status === "failed"
    && /project_cwd does not exist:.*(?:\\\\wsl\.localhost\\|\\\\wsl\$\\)/i.test(step.failureReason ?? "");
}

export function isLegacyCliPreflightFailure(step: NotebookStep): boolean {
  return step.status === "failed"
    && /npm ERR!\s+code ENOTEMPTY|write codex prompt to stdin:.*(?:pipe has been ended|os error 109)|Missing optional dependency @openai\/codex-|Could not prepare \w+ in the project environment/i.test(step.failureReason ?? "");
}

export function loadNotebook(projectId: string | null | undefined): NotebookState {
  if (!projectId) return { ...EMPTY };
  try {
    const raw = localStorage.getItem(keyFor(projectId));
    if (!raw) return { ...EMPTY };
    const p = JSON.parse(raw);
    let repairedLegacyPreflightFailure = false;
    const notebook: NotebookState = {
      text: typeof p.text === "string" ? p.text : "",
      plan: typeof p.plan === "string" ? p.plan : "",
      steps: Array.isArray(p.steps)
        ? p.steps.filter((s: NotebookStep) => s && typeof s.text === "string").map((s: NotebookStep) => {
            if (isLegacyWslRedirectorFalseFailure(s) || isLegacyCliPreflightFailure(s)) {
              repairedLegacyPreflightFailure = true;
              return {
                ...s,
                status: "pending" as const,
                startedAt: undefined,
                finishedAt: undefined,
                failureReason: undefined,
              };
            }
            return {
              ...s,
              startedAt: typeof s.startedAt === "number" ? s.startedAt : undefined,
              finishedAt: typeof s.finishedAt === "number" ? s.finishedAt : undefined,
            };
          })
        : [],
      autoFeed: p.autoFeed === true,
      autoFeedOwner: typeof p.autoFeedOwner === "string" && p.autoFeedOwner ? p.autoFeedOwner : undefined,
      autoFeedHeartbeat: typeof p.autoFeedHeartbeat === "number" ? p.autoFeedHeartbeat : undefined,
      autoFeedStartedAt: typeof p.autoFeedStartedAt === "number" ? p.autoFeedStartedAt : undefined,
      autoFeedFinishedAt: typeof p.autoFeedFinishedAt === "number" ? p.autoFeedFinishedAt : undefined,
      autoFeedStopped: p.autoFeedStopped === true,
      autoFeedArmed: p.autoFeedArmed === true,
      runningOn: p.runningOn && typeof p.runningOn === "object" && typeof p.runningOn.deviceId === "string" && typeof p.runningOn.at === "number"
        ? { deviceId: p.runningOn.deviceId, deviceName: typeof p.runningOn.deviceName === "string" ? p.runningOn.deviceName : p.runningOn.deviceId.slice(0, 8), at: p.runningOn.at }
        : undefined,
      updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : undefined,
      deletedSteps: Array.isArray(p.deletedSteps)
        ? p.deletedSteps.filter((d: unknown): d is { id: string; ts: number } =>
            !!d && typeof (d as any).id === "string" && typeof (d as any).ts === "number")
        : [],
      digest: Array.isArray(p.digest) ? p.digest.slice(-12) : [],
      digestModel: typeof p.digestModel === "string" && p.digestModel ? p.digestModel : undefined,
      proposed: Array.isArray(p.proposed) ? p.proposed.filter((t: unknown) => typeof t === "string") : [],
      proposedPlan: typeof p.proposedPlan === "string" ? p.proposedPlan : "",
    };
    // Belt-and-braces against resurrection: a step the user deleted must not
    // come back just because some path (an older build, a hand-edited blob)
    // re-introduced it alongside its tombstone.
    if (notebook.deletedSteps?.length) {
      const buried = new Set(notebook.deletedSteps.map((d) => d.id));
      notebook.steps = notebook.steps.filter((s) => !buried.has(s.id));
    }
    if (repairedLegacyPreflightFailure) {
      localStorage.setItem(keyFor(projectId), JSON.stringify(notebook));
    }
    return notebook;
  } catch { return { ...EMPTY }; }
}

/// Newest-first tombstone cap. A tombstone only has to outlive the moment a
/// peer still holds the deleted step; once every device has converged it is
/// dead weight, so an unbounded list would grow forever in the synced blob.
const MAX_STEP_TOMBSTONES = 200;

export function saveNotebook(projectId: string | null | undefined, nb: NotebookState): void {
  if (!projectId) return;
  try {
    const deletedSteps = (nb.deletedSteps ?? []).slice().sort((a, b) => b.ts - a.ts).slice(0, MAX_STEP_TOMBSTONES);
    localStorage.setItem(keyFor(projectId), JSON.stringify({
      ...nb,
      digest: nb.digest.slice(-12),
      deletedSteps,
      // Stamp EVERY write: this is the only per-notebook ordering signal two
      // PCs have when deciding whose copy of a field is newer.
      updatedAt: Date.now(),
    }));
    window.dispatchEvent(new CustomEvent(NOTEBOOK_EVENT, { detail: { projectId } }));
  } catch { /* best effort */ }
}

/// Run-end auto-feed helper (used by AgentsPage / CodePage): pop the first
/// pending step — marks it "sent" and persists — or null when auto-feed is
/// off / nothing is pending / auto-feed is driven by a DIFFERENT surface.
/// Legacy blobs saved before ownership existed have no owner: the first
/// surface to feed adopts them, so the queue converges to a single driver.
export function takeNextAutoStep(projectId: string | null | undefined, surfaceId: string): NotebookStep | null {
  const nb = loadNotebook(projectId);
  if (!nb.autoFeed) return null;
  if (leaseHeldByOtherSurface(nb, surfaceId)) return null;
  const next = nb.steps.find((s) => s.status === "pending");
  if (!next) return null;
  const now = Date.now();
  next.status = "sent";
  next.startedAt = now;
  next.finishedAt = undefined;
  next.failureReason = undefined;
  if (nb.autoFeedStartedAt == null || nb.autoFeedFinishedAt != null) {
    nb.autoFeedStartedAt = now;
    nb.autoFeedFinishedAt = undefined;
    nb.autoFeedStopped = false;
  }
  // We got here, so the lease is ours, unset, or belonged to a dead surface.
  // Adopt it outright (with a fresh beat) rather than only filling a blank —
  // otherwise the released-but-still-named owner keeps winning every later
  // comparison and the queue re-stalls on the very next card.
  if (nb.autoFeedOwner !== surfaceId) {
    nb.autoFeedOwner = surfaceId;
    nb.autoFeedHeartbeat = now;
  }
  // The chain is live from here on: every later card is dispatched by a run
  // this queue owns, so the one-shot arm has done its job.
  nb.autoFeedArmed = false;
  nb.runningOn = describeThisDeviceRun(now) ?? nb.runningOn;
  saveNotebook(projectId, nb);
  return next;
}

/// Convert the ordered `## Plan` in BRIEF.md into feedable implementation
/// steps. Brainstormer is required to write this section, but the fallback
/// still gives the team one useful job instead of ending at a dead-end CTA.
export function briefImplementationSteps(brief: string): string[] {
  const lines = brief.replace(/\r\n/g, "\n").split("\n");
  const steps: string[] = [];
  let inPlan = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#{1,3}\s+(?:implementation\s+)?plan\s*$/i.test(line)) {
      inPlan = true;
      continue;
    }
    if (inPlan && /^#{1,3}\s+/.test(line)) break;
    if (!inPlan) continue;
    const numbered = line.match(/^\d+[.)]\s+(.{3,})$/);
    const task = line.match(/^[-*]\s+\[[ xX]\]\s+(.{3,})$/);
    const text = (numbered?.[1] ?? task?.[1] ?? "").trim();
    if (text) steps.push(text);
  }
  return steps.length
    ? steps.slice(0, 12)
    : ["Implement the approved plan in BRIEF.md, follow its ordered scope, and run the verification described there."];
}

/// Finish an in-project brainstorm by preparing that SAME project's Notebook.
/// Existing queue/history stays intact; only new, non-duplicate plan steps are
/// appended. The brief itself becomes the living plan when the user has not
/// already written one.
export function seedNotebookFromBrief(projectId: string | null | undefined, brief: string): number {
  if (!projectId || !brief.trim()) return 0;
  const nb = loadNotebook(projectId);
  const known = new Set(nb.steps.map((s) => s.text.trim().toLocaleLowerCase()).filter(Boolean));
  const now = Date.now();
  const additions = briefImplementationSteps(brief).filter((text) => {
    const key = text.trim().toLocaleLowerCase();
    if (!key || known.has(key)) return false;
    known.add(key);
    return true;
  });
  if (!nb.plan.trim()) nb.plan = brief.trim();
  nb.steps.push(...additions.map((text, index) => ({
    id: `${newStepId()}${index.toString(36)}`,
    text,
    status: "pending" as const,
    ts: now + index,
  })));
  saveNotebook(projectId, nb);
  return additions.length;
}

/// Start the wall-clock timer for an auto-fed queue when a caller is not also
/// persisting its first step. The UI writes both atomically; later queue jobs
/// are covered by takeNextAutoStep.
export function markNotebookAutoFeedStarted(projectId: string | null | undefined, startedAt: number = Date.now()): void {
  if (!projectId) return;
  const nb = loadNotebook(projectId);
  if (!nb.autoFeed || (nb.autoFeedStartedAt != null && nb.autoFeedFinishedAt == null)) return;
  nb.autoFeedStartedAt = startedAt;
  nb.autoFeedFinishedAt = undefined;
  nb.autoFeedStopped = false;
  saveNotebook(projectId, nb);
}

/// Freeze the whole-sequence timer only after the owner finishes the final
/// auto-fed job. Pending or in-flight sent steps mean the sequence continues.
export function markNotebookAutoFeedFinished(projectId: string | null | undefined, surfaceId: string, finishedAt: number = Date.now()): boolean {
  if (!projectId) return false;
  const nb = loadNotebook(projectId);
  if (!nb.autoFeed || leaseHeldByOtherSurface(nb, surfaceId) || nb.autoFeedStartedAt == null || nb.autoFeedFinishedAt != null) return false;
  const stillActive = nb.steps.some((s) => s.status === "pending" || (s.status === "sent" && s.finishedAt == null));
  if (stillActive) return false;
  nb.autoFeedFinishedAt = finishedAt;
  nb.autoFeedStopped = false;
  saveNotebook(projectId, nb);
  return true;
}

/// How many cards are still waiting. Lets a caller tell "nothing left to do"
/// apart from "something is blocking me", which the tri-state return of
/// continueNotebookAutoFeed alone cannot express.
export function notebookPendingStepCount(projectId: string | null | undefined): number {
  return loadNotebook(projectId).steps.filter((s) => s.status === "pending").length;
}

/// Consume the one-shot permission to START the queue from a run the queue did
/// not dispatch (▶ Start queue pressed while the agent was already busy). True
/// at most once per press, and only for a surface allowed to drive: a manual
/// chat turn that ends cleanly must never be able to launch a queue on its own.
export function consumeAutoFeedArm(projectId: string | null | undefined, surfaceId: string): boolean {
  const nb = loadNotebook(projectId);
  if (!nb.autoFeedArmed) return false;
  if (leaseHeldByOtherSurface(nb, surfaceId)) return false;
  nb.autoFeedArmed = false;
  saveNotebook(projectId, nb);
  return true;
}

/// True when auto-feed is on with pending steps and THIS surface may drive it
/// — the run-end paths use it to say "auto-feed paused" instead of stalling
/// silently when a run doesn't finish cleanly.
export function autoFeedWouldRun(projectId: string | null | undefined, surfaceId: string): boolean {
  const nb = loadNotebook(projectId);
  if (!nb.autoFeed) return false;
  if (leaseHeldByOtherSurface(nb, surfaceId)) return false;
  return nb.steps.some((s) => s.status === "pending");
}

/// Make the complete clean-run transition in one place: atomically claim the
/// next pending card and hand it to the owning surface, or close the sequence
/// timer after the final card. AgentsPage and CodePage both use this helper so
/// their queue behavior cannot drift into separate one-card implementations.
export function continueNotebookAutoFeed(
  projectId: string | null | undefined,
  surfaceId: string,
  dispatch: (step: NotebookStep) => void,
): "dispatched" | "finished" | "inactive" {
  const step = takeNextAutoStep(projectId, surfaceId);
  if (step) {
    dispatch(step);
    return "dispatched";
  }
  return markNotebookAutoFeedFinished(projectId, surfaceId) ? "finished" : "inactive";
}

/// Stamp when a notebook step was fed to the team. Safe to call from any surface;
/// the blob is shared per project and the event re-syncs open surfaces.
export function markNotebookStepStarted(projectId: string | null | undefined, stepId: string, startedAt: number = Date.now()): void {
  if (!projectId || !stepId) return;
  const nb = loadNotebook(projectId);
  const idx = nb.steps.findIndex((s) => s.id === stepId);
  if (idx < 0) return;
  nb.steps[idx] = { ...nb.steps[idx], status: "sent", startedAt, finishedAt: undefined, failureReason: undefined };
  saveNotebook(projectId, nb);
}

/// Stamp when the run that processed a notebook step finished. Idempotent.
export function markNotebookStepFinished(projectId: string | null | undefined, stepId: string, finishedAt: number = Date.now()): void {
  if (!projectId || !stepId) return;
  const nb = loadNotebook(projectId);
  const idx = nb.steps.findIndex((s) => s.id === stepId);
  if (idx < 0) return;
  nb.steps[idx] = { ...nb.steps[idx], status: "sent", finishedAt, failureReason: undefined };
  saveNotebook(projectId, nb);
}

/// A stopped/errored run did not complete its notebook card. Keep the card in
/// Active and make the failed state durable so every page/PC offers Re-feed.
export function markNotebookStepFailed(
  projectId: string | null | undefined,
  stepId: string,
  reason: string,
  finishedAt: number = Date.now(),
): void {
  if (!projectId || !stepId) return;
  const nb = loadNotebook(projectId);
  const idx = nb.steps.findIndex((s) => s.id === stepId);
  if (idx < 0) return;
  nb.steps[idx] = {
    ...nb.steps[idx],
    status: "failed",
    finishedAt,
    failureReason: reason.trim() || "The run did not complete.",
  };
  saveNotebook(projectId, nb);
}

/// A filesystem preflight failed before an agent started. The card remains
/// pending and actionable instead of becoming a misleading failed delivery.
export function markNotebookStepPending(
  projectId: string | null | undefined,
  stepId: string,
): void {
  if (!projectId || !stepId) return;
  const nb = loadNotebook(projectId);
  const idx = nb.steps.findIndex((s) => s.id === stepId);
  if (idx < 0) return;
  nb.steps[idx] = {
    ...nb.steps[idx],
    status: "pending",
    startedAt: undefined,
    finishedAt: undefined,
    failureReason: undefined,
  };
  saveNotebook(projectId, nb);
}

/// How a run that was carrying notebook cards ended.
export type NotebookRunOutcome =
  | { kind: "clean" }
  /// A preflight refused BEFORE any agent started, so no work was attempted.
  | { kind: "preflight" }
  | { kind: "failed"; reason: string };

/// The single place both surfaces settle a notebook card at run end. The two
/// pages each hand-rolled this three-way branch and drifted: the Coding page
/// never imported markNotebookStepPending, so a preflight stop — where nothing
/// ran at all — was recorded as a real failure and the card was buried behind a
/// Re-feed instead of staying straightforwardly pending.
export function settleNotebookStep(
  projectId: string | null | undefined,
  stepId: string,
  outcome: NotebookRunOutcome,
  at: number = Date.now(),
): void {
  if (outcome.kind === "clean") markNotebookStepFinished(projectId, stepId, at);
  else if (outcome.kind === "preflight") markNotebookStepPending(projectId, stepId);
  else markNotebookStepFailed(projectId, stepId, outcome.reason, at);
}

/// A step is ARCHIVED once it is finished: the user checked it off ("done"),
/// or a run it was fed to has completed ("sent" with a finish stamp). Archived
/// steps leave the Active queue and appear only on the Archive tab — a fed
/// step that finished no longer needs a manual check-off to get out of the way.
export function isStepArchived(s: NotebookStep): boolean {
  return s.status === "done" || (s.status === "sent" && s.finishedAt != null);
}

/// Format a step's timing line: started → finished, duration, or still running.
function formatStepTiming(s: NotebookStep): string | null {
  if (s.startedAt == null) return null;
  const start = formatClock(s.startedAt);
  if (s.finishedAt != null) {
    const outcome = s.status === "failed" ? "incomplete" : "finished";
    return translateUiText(`started ${start} • ${outcome} ${formatClock(s.finishedAt)} • ${formatDuration(s.finishedAt - s.startedAt)}`);
  }
  return translateUiText(`started ${start} • running ${formatDuration(Date.now() - s.startedAt)}`);
}

function formatAutoFeedTiming(nb: NotebookState): string | null {
  if (nb.autoFeedStartedAt == null) return null;
  const finishedAt = nb.autoFeedFinishedAt;
  const elapsed = formatDuration((finishedAt ?? Date.now()) - nb.autoFeedStartedAt);
  if (finishedAt != null) {
    const outcome = nb.autoFeedStopped ? "stopped" : "finished";
    return `Auto-feed ${outcome} • started ${formatClock(nb.autoFeedStartedAt)} • finished ${formatClock(finishedAt)} • ${elapsed}`;
  }
  return `Auto-feed running • started ${formatClock(nb.autoFeedStartedAt)} • ${elapsed}`;
}

type KanbanPlan = { now: string; next: string; later: string };
const EMPTY_KANBAN: KanbanPlan = { now: "", next: "", later: "" };
const KANBAN_COLUMNS: Array<{ key: keyof KanbanPlan; label: string; hint: string; color: string }> = [
  { key: "now", label: "Now", hint: "active implementation batch", color: "var(--accent-ink)" },
  { key: "next", label: "Next", hint: "queued after Now", color: "var(--ok)" },
  { key: "later", label: "Later", hint: "parked / optional", color: "var(--warn)" },
];

/// The Kanban plan board is hidden for now — it never worked reliably and
/// reads as noise in the notebook. The board, its parse/feed logic, and the
/// digest's PLAN output are all kept intact (not deleted) so it can be turned
/// back on later; only the UI is gated off. Flip to `true` to restore it.
const SHOW_KANBAN = false;

function parseKanbanPlan(plan: string): KanbanPlan {
  const out: KanbanPlan = { ...EMPTY_KANBAN };
  let current: keyof KanbanPlan | null = null;
  let sawHeading = false;
  for (const line of plan.split(/\r?\n/)) {
    const heading = line.trim().match(/^(?:#{1,3}\s*)?(now|doing|current|next|later|backlog)\s*:?\s*$/i);
    if (heading) {
      sawHeading = true;
      const h = heading[1].toLowerCase();
      current = h === "now" || h === "doing" || h === "current" ? "now" : h === "next" ? "next" : "later";
      continue;
    }
    if (current) out[current] = `${out[current]}${out[current] ? "\n" : ""}${line}`.trimEnd();
  }
  if (!sawHeading && plan.trim()) out.now = plan.trim();
  return out;
}

function formatKanbanPlan(plan: KanbanPlan): string {
  return [
    `NOW:\n${plan.now.trim()}`,
    `NEXT:\n${plan.next.trim()}`,
    `LATER:\n${plan.later.trim()}`,
  ].join("\n\n").trim();
}

function normalizeKanbanPlan(plan: string): string {
  return formatKanbanPlan(parseKanbanPlan(plan));
}

/// Split a digest reply into the updated PLAN block (between "PLAN:" and
/// "STEPS:") and the proposed "- step" lines. Replies without a PLAN:
/// header keep the old shape — steps only.
function parseDigestReply(reply: string): { plan: string; steps: string[] } {
  let planLines: string[] | null = null;
  const steps: string[] = [];
  let inPlan = false;
  for (const line of reply.split(/\r?\n/)) {
    const t = line.trim();
    if (/^PLAN\s*:?\s*$/i.test(t)) { inPlan = true; planLines = planLines ?? []; continue; }
    if (/^(NEXT\s+)?STEPS\s*:?\s*$/i.test(t)) { inPlan = false; continue; }
    if (inPlan) { planLines!.push(line); continue; }
    const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.{3,})$/);
    if (m) steps.push(m[1].trim());
  }
  return { plan: (planLines ?? []).join("\n").trim(), steps };
}

// The PLAN half of this prompt is only asked for when the board is actually
// visible. With SHOW_KANBAN off the reply's PLAN block is parsed and then
// discarded (proposedPlan is never applied), so every digest was paying to
// generate and refine a board the user can't see. Kept intact behind the flag
// so restoring the board restores the prompt with it.
const DIGEST_SYSTEM = [
  "You are the Notebook Digest agent inside OWLLM. An agent team is working on the user's project;",
  SHOW_KANBAN
    ? "the user brainstorms alongside it. Your job: turn their raw notes/requests into (1) an updated Kanban PLAN and (2) clear, self-contained, implementable NEXT STEPS for that team."
    : "the user brainstorms alongside it. Your job: turn their raw notes/requests into clear, self-contained, implementable NEXT STEPS for that team.",
  "Rules:",
  ...(SHOW_KANBAN ? [
    "- PLAN is a Kanban board, not prose. Use exactly these lanes inside PLAN: NOW, NEXT, LATER.",
    "- NOW = the coherent implementation batch that should happen first. NEXT = follow-up batch.",
    "  LATER = optional/parked work. Keep only useful cards; remove duplication and stale wording.",
    "- You are shown the CURRENT PLAN; refine it (keep what still holds, never silently drop the user's decisions).",
    "  If the notes add nothing plan-worthy, omit the PLAN section entirely.",
  ] : []),
  "- STEPS are ADDITIVE: never rewrite, merge or remove the existing steps you are shown — only propose NEW ones.",
  "- Each step must stand alone: an agent receives it with no other context, so name the feature/file/behavior explicitly.",
  "- Do NOT create tiny painful micro-steps. Prefer 1-4 larger implementation chunks that a good agent can complete in one run.",
  "- Merge related UI/code/test work into one step when it belongs together. Split only when the work truly needs separate runs.",
  "- Output format, nothing else:",
  ...(SHOW_KANBAN ? [
    "  PLAN:",
    "  NOW:",
    "  - <card>",
    "  NEXT:",
    "  - <card>",
    "  LATER:",
    "  - <card>",
  ] : []),
  "  STEPS:",
  "  - <each proposed larger implementation chunk on its own line starting with '- '>",
].join("\n");

type Props = {
  projectId: string | null | undefined;
  projectName?: string;
  /// Multi-tab gate — only the visible Agents tab reacts to the open event.
  active?: boolean;
  /// Is a team run in progress right now (steers queue vs new dispatch).
  running: boolean;
  /// Feed one step to the team. Returns what happened so the UI can say it.
  /// The optional stepId lets the surface correlate a run back to the step
  /// that started it for start/finish timing.
  onFeed: (text: string, stepId?: string) => "queued" | "dispatched" | "no-team";
  /// Digest model routing (same trio the BrainstormPanel takes).
  modelId: string;
  port: number;
  models: ModelInfo[];
  /// Window event that opens this instance as a MODAL. Only the Agents page
  /// uses it (on the default name); the Code page mounts `inline` in its right
  /// column and never opens a modal, so it leaves this at the default.
  openEvent?: string;
  /// Needed by the digest-model ModelPicker (which providers are signed in).
  accountsStatus?: AccountsStatusLite | null;
  /// Render the notebook INLINE (fills its parent, stacked vertically) instead
  /// of as a modal — used by the Code page's right-column Notebook tab.
  inline?: boolean;
  /// Stable identity of the page hosting this notebook (e.g. "agents:main",
  /// "code:<pageId>"). Turning auto-feed ON records it as the owner so only
  /// this page walks the queue at run end; other pages on the same project
  /// see the toggle as "driven elsewhere" and can only switch it off.
  surfaceId?: string;
};

export default function RunNotebook({ projectId, projectName, active = true, running, onFeed, modelId, port, models, openEvent = "owllm:open-run-notebook", accountsStatus = null, inline = false, surfaceId = "main" }: Props) {
  const [open, setOpen] = useState(false);
  const [nb, setNb] = useState<NotebookState>(() => loadNotebook(projectId));
  const [newStep, setNewStep] = useState("");
  const [digestBusy, setDigestBusy] = useState(false);
  const [digestLogOpen, setDigestLogOpen] = useState(false);
  /// Which steps tab is shown: the actionable queue or the archive of done
  /// steps. Done steps are ONLY visible on the archive tab.
  const [stepsTab, setStepsTab] = useState<"active" | "archive">("active");
  const [digestError, setDigestError] = useState("");
  /// Transient per-step outcome of the last Feed click — the onFeed result
  /// ("queued" into a live run vs "dispatched" as a new goal vs "no-team")
  /// was previously computed and thrown away, leaving the user guessing.
  const [feedNotice, setFeedNotice] = useState<{ id: string; kind: "queued" | "dispatched" | "no-team" } | null>(null);
  /// Same transient outcome for the Kanban NOW-batch button (keyed separately —
  /// lanes have no step id).
  const [laneNotice, setLaneNotice] = useState<{ key: keyof KanbanPlan; kind: "queued" | "dispatched" | "no-team" } | null>(null);
  /// Transient whole-queue outcome for Start Queue clicked while a run is
  /// already in progress — tells the user the queue is deferred until the
  /// current job finishes instead of steering it now.
  const [queueNotice, setQueueNotice] = useState<"waiting" | null>(null);
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  // Digest proposals live IN the notebook blob (nb.proposed / nb.proposedPlan)
  // so they survive tab switches, modal close, and project swaps.
  const proposed = nb.proposed ?? [];
  const proposedPlan = nb.proposedPlan ?? "";
  const activeRef = useRef(active);
  activeRef.current = active;
  const projRef = useRef(projectId);
  projRef.current = projectId;
  useTick(nb.autoFeedStartedAt != null && nb.autoFeedFinishedAt == null);

  const kanbanPlan = useMemo(() => parseKanbanPlan(nb.plan), [nb.plan]);
  const brainstormRef = useAutoResize<HTMLTextAreaElement>(nb.text, { minRows: 4, maxRows: 16 });
  const nowPlanRef = useAutoResize<HTMLTextAreaElement>(kanbanPlan.now, { minRows: 3, maxRows: 10 });
  const nextPlanRef = useAutoResize<HTMLTextAreaElement>(kanbanPlan.next, { minRows: 3, maxRows: 10 });
  const laterPlanRef = useAutoResize<HTMLTextAreaElement>(kanbanPlan.later, { minRows: 3, maxRows: 10 });
  const newStepRef = useAutoResize<HTMLTextAreaElement>(newStep, { minRows: 1, maxRows: 6 });
  const editStepRef = useAutoResize<HTMLTextAreaElement>(editingText, { minRows: 1, maxRows: 8 });

  useEffect(() => {
    if (inline) return; // inline instances are always visible — no open event
    const onOpen = () => { if (activeRef.current) { setNb(loadNotebook(projRef.current)); setOpen(true); } };
    window.addEventListener(openEvent, onOpen as EventListener);
    return () => window.removeEventListener(openEvent, onOpen as EventListener);
  }, [openEvent, inline]);
  // Reload when the page (auto-feed) or another tab touches the same blob.
  useEffect(() => {
    const onChanged = (e: Event) => {
      const pid = (e as CustomEvent).detail?.projectId;
      if (pid && pid === projRef.current) setNb(loadNotebook(pid));
    };
    window.addEventListener(NOTEBOOK_EVENT, onChanged as EventListener);
    return () => window.removeEventListener(NOTEBOOK_EVENT, onChanged as EventListener);
  }, []);
  // Project switch → swap to that project's notebook (proposals travel with
  // the blob, so nothing to reset there).
  useEffect(() => {
    setNb(loadNotebook(projectId));
    setDigestError("");
    setEditingStepId(null);
    setFeedNotice(null);
    setQueueNotice(null);
  }, [projectId]);

  const updateNotebook = (makeNext: (prev: NotebookState) => NotebookState) => {
    setNb((prev) => {
      const next = makeNext(prev);
      saveNotebook(projRef.current, next);
      return next;
    });
  };

  const update = (patch: Partial<NotebookState>) => {
    updateNotebook((prev) => ({ ...prev, ...patch }));
  };
  const updateKanbanLane = (key: keyof KanbanPlan, value: string) => {
    update({ plan: formatKanbanPlan({ ...kanbanPlan, [key]: value }) });
  };

  const addStep = (text: string) => {
    const t = text.trim();
    if (!t) return;
    updateNotebook((prev) => ({
      ...prev,
      steps: [...prev.steps, { id: newStepId(), text: t, status: "pending", ts: Date.now() }],
    }));
  };
  const addSteps = (texts: string[]) => {
    const clean = texts.map((t) => t.trim()).filter(Boolean);
    if (!clean.length) return;
    const now = Date.now();
    updateNotebook((prev) => ({
      ...prev,
      steps: [
        ...prev.steps,
        ...clean.map((text, i) => ({ id: newStepId(), text, status: "pending" as const, ts: now + i })),
      ],
    }));
  };
  const setStep = (id: string, patch: Partial<NotebookStep>) =>
    updateNotebook((prev) => ({ ...prev, steps: prev.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  /// Deleting records a TOMBSTONE as well as dropping the step. Steps merge
  /// across PCs as a union by id (so a peer's completion can't be clobbered by
  /// our stale copy); without the tombstone that union would hand the deleted
  /// step straight back on the next sync.
  const removeStep = (id: string) => updateNotebook((prev) => ({
    ...prev,
    steps: prev.steps.filter((s) => s.id !== id),
    deletedSteps: [...(prev.deletedSteps ?? []).filter((d) => d.id !== id), { id, ts: Date.now() }],
  }));
  // Reorder within the VISIBLE (unfinished) cards only — archived steps are
  // hidden from the feed, so swap the two adjacent visible steps rather than raw
  // array neighbours (a raw swap could silently trade places with a hidden one).
  const moveStep = (id: string, dir: -1 | 1) =>
    updateNotebook((prev) => {
      const visible = prev.steps.filter((s) => !isStepArchived(s));
      const vi = visible.findIndex((s) => s.id === id);
      const vj = vi + dir;
      if (vi < 0 || vj < 0 || vj >= visible.length) return prev;
      const ai = prev.steps.findIndex((s) => s.id === visible[vi].id);
      const bi = prev.steps.findIndex((s) => s.id === visible[vj].id);
      const steps = [...prev.steps];
      [steps[ai], steps[bi]] = [steps[bi], steps[ai]];
      return { ...prev, steps };
    });
  const feedStep = (s: NotebookStep, claimQueue = false) => {
    const res = onFeed(s.text, s.id);
    setFeedNotice({ id: s.id, kind: res });
    window.setTimeout(() => setFeedNotice((n) => (n && n.id === s.id ? null : n)), 6000);
    if (res === "no-team") return;
    const now = Date.now();
    // Persist the first step and sequence clock together. Separate writes can
    // race React's queued state updater and erase the just-started sequence.
    updateNotebook((prev) => ({
      ...prev,
      steps: prev.steps.map((step) => step.id === s.id ? { ...step, status: "sent", startedAt: now, finishedAt: undefined, failureReason: undefined } : step),
      // Claiming the queue makes THIS window its owner even when auto-feed is
      // off: a started queue is driven by one window, and every other open
      // window (another tab here or the app on another PC) ghosts its run
      // controls until this one finishes or hands the lease over.
      ...(claimQueue ? { autoFeedOwner: surfaceId, autoFeedHeartbeat: now, runningOn: describeThisDeviceRun(now) ?? prev.runningOn } : {}),
      ...(prev.autoFeed && (prev.autoFeedStartedAt == null || prev.autoFeedFinishedAt != null)
        ? { autoFeedStartedAt: now, autoFeedFinishedAt: undefined, autoFeedStopped: false }
        : {}),
    }));
  };
  /// Feed a whole Kanban lane as one goal. The board is the plan of record, so
  /// the lane content is NEVER cleared or consumed — only read.
  const feedLane = (key: keyof KanbanPlan) => {
    const body = kanbanPlan[key].trim();
    if (!body) return;
    const label = KANBAN_COLUMNS.find((c) => c.key === key)!.label.toUpperCase();
    const res = onFeed(`Implement the ${label} batch from the Notebook plan board — work through every card, in order:\n${body}`);
    setLaneNotice({ key, kind: res });
    window.setTimeout(() => setLaneNotice((n) => (n && n.key === key ? null : n)), 6000);
  };
  /// The missing "start" for the step queue: feed the FIRST pending step now.
  /// With auto-feed on, each clean run end pulls the next one — this button is
  /// what kicks the chain off while the team is idle.
  const startQueue = () => {
    const first = nb.steps.find((s) => s.status === "pending");
    if (!first) return;
    if (running) {
      // Agent is already running — claim auto-feed ownership so the queue
      // starts automatically as soon as the current job finishes, without
      // steering the live run now. This click is the ONLY thing that lets a
      // run the queue did not dispatch start one (see autoFeedArmed).
      updateNotebook((prev) => ({ ...prev, autoFeed: true, autoFeedArmed: true, autoFeedOwner: surfaceId, autoFeedHeartbeat: Date.now() }));
      setQueueNotice("waiting");
      window.setTimeout(() => setQueueNotice(null), 6000);
      return;
    }
    // Start queue is an explicit request to drive the sequence from THIS
    // page. Claim ownership with the first persisted step so a stale owner
    // left by a closed page cannot dispatch card one and then strand card two.
    feedStep(first, true);
  };

  const startEdit = (s: NotebookStep) => { setEditingStepId(s.id); setEditingText(s.text); };
  const saveEdit = () => {
    if (!editingStepId) return;
    const t = editingText.trim();
    if (t) setStep(editingStepId, { text: t });
    else removeStep(editingStepId);
    setEditingStepId(null);
    setEditingText("");
  };
  const cancelEdit = () => { setEditingStepId(null); setEditingText(""); };

  const runDigest = async () => {
    const notes = nb.text.trim();
    const currentPlan = nb.plan.trim();
    if (digestBusy) return;
    if (!notes && !(SHOW_KANBAN && currentPlan) && nb.steps.length === 0) {
      setDigestError("Write working notes first, or add an existing plan/step for the digest to refine.");
      return;
    }
    setDigestBusy(true);
    setDigestError("");
    update({ proposed: [], proposedPlan: "" });
    const youText = "Digest the current notebook into a clearer plan and new feedable steps.";
    const history = [...nb.digest, { role: "you" as const, text: youText }];
    update({ digest: history });
    // Capture the project at digest START: results are written straight to
    // THAT project's blob (not through setState), so a page switch or project
    // swap mid-stream can no longer orphan the digest — mounted surfaces pick
    // the result up via NOTEBOOK_EVENT, and setNb below only syncs the local
    // mirror when we're still on the same project.
    const pid = projRef.current;
    try {
      const user = [
        SHOW_KANBAN && currentPlan ? `CURRENT PLAN (extend/refine additively):\n${currentPlan}` : "",
        nb.steps.length ? `EXISTING STEPS (do not repeat or rewrite):\n${nb.steps.map((s) => `- ${s.text}`).join("\n")}` : "",
        notes ? `NOTEBOOK NOTES:\n${notes}` : "",
      ].filter(Boolean).join("\n\n");
      let reply = "";
      const ctrl = new AbortController();
      // User override (persisted per project) wins; else the inherited default.
      const dm = nb.digestModel || modelId;
      if (!dm.trim()) throw new Error("No digest model is selected or loaded.");
      await streamChatCompletion(
        port, dm, providerFor(dm, models),
        DIGEST_SYSTEM, user, 0.3, ctrl.signal,
        (d) => { reply += d; },
      );
      const parsed = parseDigestReply(reply);
      const fresh = loadNotebook(pid);
      fresh.digest = [...fresh.digest, { role: "digest", text: reply.trim() || "(no reply)" }];
      fresh.proposed = parsed.steps;
      fresh.proposedPlan =
        parsed.plan && normalizeKanbanPlan(parsed.plan) !== normalizeKanbanPlan(fresh.plan.trim())
          ? normalizeKanbanPlan(parsed.plan)
          : "";
      saveNotebook(pid, fresh);
      if (pid === projRef.current) setNb(fresh);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const fresh = loadNotebook(pid);
      fresh.digest = [...fresh.digest, { role: "digest", text: `(error: ${msg})` }];
      saveNotebook(pid, fresh);
      if (pid === projRef.current) setNb(fresh);
      setDigestError(msg);
      setDigestLogOpen(true);
    } finally {
      setDigestBusy(false);
    }
  };

  const pendingCount = useMemo(() => nb.steps.filter((s) => s.status === "pending").length, [nb.steps]);
  const incompleteCount = useMemo(() => nb.steps.filter((s) => s.status === "failed").length, [nb.steps]);
  // Total queue timing: sum of finished durations plus currently-running time.
  const queueTiming = useMemo(() => {
    const finished = nb.steps.filter((s) => s.startedAt != null && s.finishedAt != null);
    const running = nb.steps.filter((s) => s.startedAt != null && s.finishedAt == null);
    const finishedMs = finished.reduce((a, s) => a + (s.finishedAt! - s.startedAt!), 0);
    const runningMs = running.reduce((a, s) => a + (Date.now() - s.startedAt!), 0);
    return { finishedMs, runningMs, finishedCount: finished.length, runningCount: running.length };
  }, [nb.steps]);
  const queueTimingText = useMemo(() => {
    const parts: string[] = [];
    if (queueTiming.finishedCount) {
      const doneText = `${formatDuration(queueTiming.finishedMs)} done`;
      parts.push(translateUiText(doneText));
    }
    if (queueTiming.runningCount) {
      const runningText = `${formatDuration(queueTiming.runningMs)} running`;
      parts.push(translateUiText(runningText));
    }
    return parts.join(" · ");
  }, [queueTiming]);
  const autoFeedTimingText = formatAutoFeedTiming(nb);
  // The active feed shows only unfinished, actionable cards. Finished steps
  // (checked off OR fed-and-completed) drop out of the feed into the Archive tab.
  const activeSteps = useMemo(() => nb.steps.filter((s) => !isStepArchived(s)), [nb.steps]);
  const doneSteps = useMemo(() => nb.steps.filter((s) => isStepArchived(s)), [nb.steps]);
  // ---- Window-owned queue lease (device-local; never synced) --------------
  // Once a window starts the queue (Start queue / auto-feed), it OWNS the run:
  // only that window feeds the team from this list. Every other open window on
  // the same project — another tab here or the app on another PC — becomes a
  // read-only spectator so two windows can never steer the one team at once.
  // A queue is "active" while its owner still has pending or in-flight steps.
  // The owner is a surface id that stays on THIS device (vaultSync denies the
  // run-lease key), so a peer PC sees the lock but can Take over if the owning
  // window is gone.
  const queueActive = useMemo(
    () => !!nb.autoFeedOwner && nb.steps.some((s) => s.status === "pending" || (s.status === "sent" && s.finishedAt == null)),
    [nb.autoFeedOwner, nb.steps],
  );
  // The owner is only "live" while its heartbeat is fresh. A window closed or
  // crashed mid-queue stops beating: its lease goes stale so other windows
  // un-ghost and Start queue takes over (never stranding the list behind a dead
  // owner), while a genuinely live owner keeps its exclusive hold. useTick keeps
  // this re-evaluating so a lock releases on its own once the beat lapses.
  const leaseLive = nb.autoFeedHeartbeat != null && (Date.now() - nb.autoFeedHeartbeat) < NOTEBOOK_LEASE_TTL_MS;
  useTick(queueActive && nb.autoFeedOwner !== surfaceId && nb.autoFeedHeartbeat != null);
  const lockedElsewhere = queueActive && nb.autoFeedOwner !== surfaceId && leaseLive;
  const takeOverQueue = () => updateNotebook((prev) => ({ ...prev, autoFeedOwner: surfaceId, autoFeedHeartbeat: Date.now() }));
  // Cross-PC ADVISORY. The run-lease deliberately never syncs, so until now a
  // second machine had no way to know a queue was already running and could
  // start the same steps again. This only informs — it must not disable, since
  // peer clocks are unsynchronized and a skewed stamp would lock the user out
  // of their own queue.
  useEffect(() => { warmNotebookDeviceIdentity(); }, []);
  useTick(nb.runningOn != null);
  const peerRun = peerRunningQueue(nb);
  // While THIS window owns an active queue, beat the heartbeat so peers keep
  // seeing the lease held. Stops when the queue ends or ownership moves away.
  useEffect(() => {
    if (nb.autoFeedOwner !== surfaceId || !queueActive) return;
    const stamp = () => updateNotebook((prev) => (prev.autoFeedOwner === surfaceId ? { ...prev, autoFeedHeartbeat: Date.now() } : prev));
    stamp();
    const t = window.setInterval(stamp, NOTEBOOK_HEARTBEAT_MS);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nb.autoFeedOwner, surfaceId, queueActive]);
  // Human-readable INHERITED digest model (the default when no override is
  // picked): the raw id with any file path stripped.
  const digestModelLabel = useMemo(() => {
    const raw = (modelId || "").trim();
    return raw ? (raw.split(/[\\/]/).pop() || raw) : "server model";
  }, [modelId]);
  if (!inline && !open) return null;

  const statusIcon = (s: NotebookStep) => (
    <ActionIcon name={s.status === "done" ? "check" : s.status === "sent" ? "bolt" : "circle"} size={15} />
  );
  const statusColor = (s: NotebookStep) => (s.status === "done" ? "var(--ok)" : s.status === "failed" ? "var(--error)" : s.status === "sent" ? "var(--warn)" : "var(--fg-muted)");

  const card: React.CSSProperties = {
    display: "flex", flexDirection: "column", gap: 8,
    background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10,
    padding: "10px 12px",
  };
  const sectionHeader: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 8,
    fontSize: 11, fontWeight: 800, letterSpacing: 0.8,
    color: "var(--fg-strong)", textTransform: "uppercase",
    paddingBottom: 6, borderBottom: "1px solid var(--border)",
  };
  const textareaBase: React.CSSProperties = {
    width: "100%", resize: "none", overflow: "hidden",
    background: "var(--bg-input)", color: "var(--fg)",
    border: "1px solid var(--border-strong)", borderRadius: 8,
    padding: 10, fontSize: "var(--chat-font-size, 13px)", lineHeight: 1.55, outline: "none",
  };

  const panel = (
      <div onClick={(e) => e.stopPropagation()} style={inline ? {
        width: "100%", height: "100%", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden",
      } : {
        width: "min(820px, 94vw)", height: "min(820px, 90vh)", display: "flex", flexDirection: "column",
        background: "var(--bg-panel)", border: "1px solid var(--border-strong)", borderRadius: 12,
        boxShadow: "0 18px 60px rgba(0,0,0,0.55)", overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: inline ? "8px 12px" : "12px 16px", borderBottom: "1px solid var(--border)", flexWrap: "wrap", flexShrink: 0 }}>
          <span style={{ fontSize: inline ? 15 : 18 }}>📓</span>
          {!inline && <span style={{ fontSize: 14, fontWeight: 700, color: "var(--fg-strong)" }}>Notebook{projectName ? ` — ${projectName}` : ""}</span>}
          <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>
            {running ? (inline ? "run live — steps steer it" : "team is running — fed steps steer it live") : (inline ? "idle — steps start a run" : "team idle — fed steps start a run")}
          </span>
          <div style={{ flex: 1 }} />
          {peerRun && !lockedElsewhere && (
            <span
              data-ui="NotebookPeerRunning"
              title={`Another of your PCs started this queue at ${formatClock(peerRun.at)}. This is informational only — you can still run it here, but both machines would work the same steps.`}
              style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: "var(--warn)" }}
            >
              <ActionIcon name="monitor" size={12} />queue started on {peerRun.deviceName}
            </span>
          )}
          {lockedElsewhere ? (
            // This window is a spectator: another window owns the running queue.
            // Ghost the toggle and offer an explicit takeover (for when the
            // owning window — e.g. on another PC — is gone) instead of letting
            // two windows drive the one team.
            <div data-ui="NotebookQueueLocked" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span title="The queue is being driven by another open window on this project. Its run controls are read-only here to avoid two windows steering the same team." style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, color: "var(--warn)" }}>
                <ActionIcon name="monitor" size={13} />Queue runs in another window
              </span>
              <button
                onClick={takeOverQueue}
                title="Take over driving the queue from this window (use only if the other window is closed or stuck)."
                style={{ height: 24, padding: "0 10px", border: "1px solid rgba(var(--warn-rgb),0.5)", borderRadius: 6, background: "rgba(var(--warn-rgb),0.12)", color: "var(--warn)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
              >Take over here</button>
            </div>
          ) : (
            <label
              title="When a run finishes cleanly, the next pending step is dispatched automatically — write the roadmap, the team walks it. Only the window that turns this on feeds the queue."
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: nb.autoFeed ? "var(--ok)" : "var(--fg-muted)", cursor: "pointer" }}
            >
              <input
                type="checkbox"
                checked={nb.autoFeed}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  const stoppedAt = Date.now();
                  updateNotebook((prev) => enabled
                    ? { ...prev, autoFeed: true, autoFeedOwner: surfaceId, autoFeedHeartbeat: Date.now() }
                    : {
                        ...prev,
                        autoFeed: false,
                        autoFeedArmed: false,
                        autoFeedOwner: undefined,
                        ...(prev.autoFeedStartedAt != null && prev.autoFeedFinishedAt == null
                          ? { autoFeedFinishedAt: stoppedAt, autoFeedStopped: true }
                          : {}),
                      });
                }}
              />
              Auto-feed next step
            </label>
          )}
          {!inline && <button className="ghost-btn" onClick={() => setOpen(false)} title="Close" aria-label="Close" style={{ height: 26, width: 28, padding: 0, display: "grid", placeItems: "center" }}><ActionIcon name="close" size={14} /></button>}
        </div>

        {/* Body: scrollable column of cards */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, padding: "12px 14px" }}>
          {/* Working notes and digest controls */}
          <div style={card}>
            <div style={sectionHeader}>
              <ActionIcon name="note" size={15} />
              <span>Working notes</span>
              <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 500, textTransform: "none", color: "var(--fg-muted)" }}>single source for digest</span>
            </div>
            <textarea
              ref={brainstormRef}
              value={nb.text}
              onChange={(e) => update({ text: e.target.value })}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !digestBusy) {
                  e.preventDefault();
                  void runDigest();
                }
              }}
              placeholder={"Think out loud here while the agents work: decisions, bugs, UI ideas, files to touch.\nPress Ctrl+Enter or use Digest notes to turn this into a plan and feedable steps."}
              style={textareaBase}
            />
            {digestError && (
              <div style={{ padding: "8px 10px", border: "1px solid rgba(var(--error-rgb),0.45)", borderRadius: 8, background: "rgba(var(--error-rgb),0.12)", color: "var(--error)", fontSize: 12, lineHeight: 1.4 }}>
                {digestError}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <div title="Digest agent model. Default: the team's model (pending override -> project's team model -> loaded server model)." style={{ width: inline ? 170 : 220, flexShrink: 0 }}>
                <ModelPicker
                  value={nb.digestModel || ""}
                  onChange={(id) => update({ digestModel: id })}
                  models={models}
                  status={accountsStatus}
                  fallbackLabel={digestModelLabel}
                />
              </div>
              {nb.digestModel && (
                <button className="ghost-btn" onClick={() => update({ digestModel: undefined })} title="Back to the default team model" aria-label="Back to the default team model" style={{ height: 28, width: 28, padding: 0, display: "grid", placeItems: "center", flexShrink: 0 }}><ActionIcon name="close" size={13} /></button>
              )}
              <button
                onClick={() => void runDigest()}
                disabled={digestBusy}
                aria-label={digestBusy ? "Digesting..." : "Digest notes"}
                title="Digest the working notes, current plan, and existing steps"
                style={{ height: 32, padding: "0 14px", display: "inline-flex", alignItems: "center", gap: 7, border: digestBusy ? "1px solid var(--border)" : "1px solid var(--accent)", borderRadius: 7, background: digestBusy ? "var(--bg-surface)" : "linear-gradient(135deg, color-mix(in srgb, var(--accent) 82%, white), var(--accent))", color: digestBusy ? "var(--fg-muted)" : "var(--accent-fg)", boxShadow: digestBusy ? "none" : "0 2px 10px rgba(var(--accent-rgb),0.3)", fontSize: 12, fontWeight: 800, cursor: digestBusy ? "wait" : "pointer", opacity: digestBusy ? 0.62 : 1, flexShrink: 0 }}
              ><ActionIcon name={digestBusy ? "loader" : "wand"} size={15} />{digestBusy ? "Digesting..." : "Digest notes"}</button>
              {nb.digest.length > 0 && (
                <button className="ghost-btn" onClick={() => setDigestLogOpen((v) => !v)} title="Show or hide the raw digest transcript" style={{ height: 28, padding: "0 10px", fontSize: 11 }}>
                  {digestLogOpen ? "Hide log" : "Show log"}
                </button>
              )}
              {nb.text.trim() && (
                <button className="ghost-btn" onClick={() => update({ text: "" })} title="Clear working notes and start a fresh note" style={{ height: 28, padding: "0 10px", fontSize: 11 }}>
                  Clear notes
                </button>
              )}
              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--fg-muted)" }}>
                {digestBusy ? "reading notebook..." : "Ctrl+Enter digests"}
              </span>
            </div>
            {digestLogOpen && (nb.digest.length > 0 || digestBusy) && (
              <LogBox
                title="Digest transcript"
                height={180}
                placeholder="(no digest yet)"
                text={
                  nb.digest.map((m) => `${m.role === "you" ? "REQUEST" : "DIGEST"}: ${m.text}`).join("\n\n")
                  + (digestBusy ? "\n\nDigesting..." : "")
                }
              />
            )}
          </div>

          {((SHOW_KANBAN && proposedPlan) || proposed.length > 0) && (
            <div style={{ ...card, borderColor: "rgba(var(--ok-rgb),0.35)" }}>
              <div style={sectionHeader}>
                <ActionIcon name="wand" size={15} />
                <span>Proposed update</span>
                <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 500, textTransform: "none", color: "var(--fg-muted)" }}>review before applying</span>
              </div>
              {SHOW_KANBAN && proposedPlan && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10, background: "rgba(var(--accent-rgb),0.08)", border: "1px solid rgba(var(--accent-rgb),0.35)", borderRadius: 8 }}>
                  <div style={{ fontSize: 11, color: "var(--accent-ink)", fontWeight: 700 }}>Proposed plan</div>
                  <div style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--fg)" }}>{proposedPlan}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => update({ plan: normalizeKanbanPlan(proposedPlan), text: "", proposedPlan: "" })}
                      style={{ height: 26, padding: "0 12px", border: "1px solid rgba(var(--accent-rgb),0.45)", borderRadius: 6, background: "rgba(var(--accent-rgb),0.12)", color: "var(--accent-ink)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                    >Save plan + clear notes</button>
                    <button className="ghost-btn" onClick={() => update({ proposedPlan: "" })} title="Discard the proposed plan" style={{ height: 26, padding: "0 10px", fontSize: 11 }}>Discard</button>
                  </div>
                </div>
              )}
              {proposed.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 11, color: "var(--ok)", fontWeight: 700 }}>Proposed steps</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {proposed.map((t, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: 8, background: "rgba(var(--ok-rgb),0.08)", border: "1px solid rgba(var(--ok-rgb),0.28)", borderRadius: 8 }}>
                        <div style={{ flex: 1, fontSize: 12, lineHeight: 1.45, color: "var(--fg)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{t}</div>
                        <button
                          onClick={() => updateNotebook((prev) => ({
                            ...prev,
                            steps: [...prev.steps, { id: newStepId(), text: t, status: "pending" as const, ts: Date.now() }],
                            proposed: (prev.proposed ?? []).filter((_, j) => j !== i),
                          }))}
                          title="Add this step to the list"
                          style={{ height: 26, padding: "0 10px", border: "1px solid rgba(var(--ok-rgb),0.45)", borderRadius: 6, background: "rgba(var(--ok-rgb),0.12)", color: "var(--ok)", fontSize: 11, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}
                        >Add</button>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => {
                        const now = Date.now();
                        updateNotebook((prev) => ({
                          ...prev,
                          steps: [
                            ...prev.steps,
                            ...(prev.proposed ?? []).map((t) => t.trim()).filter(Boolean)
                              .map((text, i) => ({ id: newStepId(), text, status: "pending" as const, ts: now + i })),
                          ],
                          proposed: [],
                          // Accepting the steps CONSUMES the working notes — the
                          // digest already turned them into the listed steps.
                          // Only keep the notes when the Kanban board is live AND
                          // still holds an unapplied plan (its own "Save plan +
                          // clear notes" button owns the clear then). With the
                          // board hidden (SHOW_KANBAN=false) that button never
                          // renders, so the notes must clear here or they strand
                          // forever — the recurring "notes won't clear" bug.
                          text: SHOW_KANBAN && prev.proposedPlan ? prev.text : "",
                          proposedPlan: SHOW_KANBAN ? prev.proposedPlan : "",
                        }));
                      }}
                      style={{ height: 28, padding: "0 12px", border: "none", borderRadius: 7, background: "var(--ok)", color: "#ffffff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
                    >Add all + clear notes</button>
                    <button className="ghost-btn" onClick={() => update({ proposed: [] })} title="Discard proposed steps" style={{ height: 28, padding: "0 10px", fontSize: 11 }}>Discard steps</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Kanban plan — hidden for now (SHOW_KANBAN=false); kept for future resume */}
          {SHOW_KANBAN && (
          <div style={card}>
            <div style={sectionHeader}>
              <ActionIcon name="clipboard" size={15} />
              <span>Plan board</span>
              <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 500, textTransform: "none", color: "var(--fg-muted)" }}>Kanban</span>
            </div>
            {/* auto-fit: uses whatever width the host gives it — 3 columns in the
                modal, 1-2 in the narrow Code side panel instead of a tall stack */}
            <div style={{ display: "grid", gridTemplateColumns: inline ? "repeat(auto-fit, minmax(170px, 1fr))" : "repeat(3, minmax(0, 1fr))", gap: 8 }}>
              {KANBAN_COLUMNS.map((col) => {
                const ref = col.key === "now" ? nowPlanRef : col.key === "next" ? nextPlanRef : laterPlanRef;
                return (
                  <div key={col.key} style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0, background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 9 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 7, height: 7, borderRadius: 999, background: col.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 11, fontWeight: 800, color: "var(--fg-strong)", textTransform: "uppercase" }}>{col.label}</span>
                      <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--fg-muted)" }}>{col.hint}</span>
                    </div>
                    <textarea
                      ref={ref}
                      value={kanbanPlan[col.key]}
                      onChange={(e) => updateKanbanLane(col.key, e.target.value)}
                      placeholder={col.key === "now" ? "- Ship the coherent first batch..." : col.key === "next" ? "- Follow-up batch..." : "- Optional or parked work..."}
                      style={{ ...textareaBase, minHeight: inline ? 64 : 92, fontSize: 12, background: "var(--bg-input)" }}
                    />
                    {col.key === "now" && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <button
                          onClick={() => feedLane("now")}
                          disabled={!kanbanPlan.now.trim()}
                          title={running ? "Feed the whole NOW batch — steers the running team at its next boundary. The board keeps its cards." : "Start the whole NOW batch as a new goal. The board keeps its cards."}
                          style={{ height: 24, padding: "0 10px", border: "1px solid rgba(var(--accent-rgb),0.5)", borderRadius: 6, background: "rgba(var(--accent-rgb),0.12)", color: "var(--accent-ink)", fontSize: 11, fontWeight: 700, cursor: kanbanPlan.now.trim() ? "pointer" : "default", opacity: kanbanPlan.now.trim() ? 1 : 0.45 }}
                        ><ActionIcon name="bolt" size={13} style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }} />Start batch</button>
                        {laneNotice?.key === "now" && (
                          <span style={{
                            fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: "2px 8px",
                            color: laneNotice.kind === "no-team" ? "var(--error)" : laneNotice.kind === "queued" ? "var(--warn)" : "var(--ok)",
                            border: `1px solid ${laneNotice.kind === "no-team" ? "rgba(var(--error-rgb),0.45)" : laneNotice.kind === "queued" ? "rgba(var(--warn-rgb),0.45)" : "rgba(var(--ok-rgb),0.45)"}`,
                          }}>
                            {laneNotice.kind === "queued" ? "queued — steers the live run" : laneNotice.kind === "dispatched" ? "dispatched as a new goal" : "no team ready — pick a project & model"}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          )}

          {/* Next steps */}
          <div style={card}>
            <div style={{ ...sectionHeader, borderBottom: "none", paddingBottom: 0 }}>
              <ActionIcon name="target" size={15} />
              <span>Next steps</span>
              {queueTimingText && (
                <span title="Total queue time across started steps" style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, color: "var(--accent-ink)", border: "1px solid rgba(var(--accent-rgb),0.35)", borderRadius: 999, padding: "1px 8px" }}><ActionIcon name="clock" size={11} />{queueTimingText}</span>
              )}
              <span style={{ fontSize: 10, fontWeight: 700, color: pendingCount ? "var(--ok)" : "var(--fg-muted)", border: "1px solid var(--border)", borderRadius: 999, padding: "1px 8px" }}>{pendingCount} pending</span>
              {incompleteCount > 0 && (
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--error)", border: "1px solid rgba(var(--error-rgb),0.45)", borderRadius: 999, padding: "1px 8px" }}>{incompleteCount} incomplete</span>
              )}
              {pendingCount > 0 && (
                <button
                  onClick={startQueue}
                  disabled={lockedElsewhere}
                  title={lockedElsewhere
                    ? "The queue is already running in another window on this project. Take over from the header to drive it here."
                    : running
                      ? "Queue is waiting for the current run to finish before starting"
                      : nb.autoFeed
                        ? "Feed the first pending step now — auto-feed walks the rest of the list, one step per clean run"
                        : "Feed the first pending step now (turn on auto-feed to walk the whole list automatically)"}
                  style={{ height: 24, padding: "0 10px", border: "none", borderRadius: 6, background: lockedElsewhere ? "var(--bg-surface)" : running ? "var(--warn)" : "var(--ok)", color: lockedElsewhere ? "var(--fg-muted)" : "#ffffff", fontSize: 11, fontWeight: 700, cursor: lockedElsewhere ? "not-allowed" : "pointer", opacity: lockedElsewhere ? 0.6 : 1, textTransform: "none", letterSpacing: 0 }}
                ><ActionIcon name="play" size={12} style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }} />Start queue</button>
              )}
              {queueNotice && (
                <span style={{
                  fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: "2px 8px",
                  color: "var(--warn)",
                  border: "1px solid rgba(var(--warn-rgb),0.45)",
                }}>
                  queued — starts after the current run
                </span>
              )}
            </div>

            {autoFeedTimingText && (
              <div
                data-ui="NotebookAutoFeedTiming"
                title="Total wall-clock time for this auto-fed notebook sequence"
                style={{
                  marginTop: 8, display: "inline-flex", alignItems: "center", alignSelf: "flex-start", gap: 5,
                  maxWidth: "100%", padding: "4px 8px", borderRadius: 6, fontSize: 10.5, fontWeight: 700,
                  fontVariantNumeric: "tabular-nums", color: "var(--accent-ink)",
                  background: "rgba(var(--accent-rgb),0.10)", border: "1px solid rgba(var(--accent-rgb),0.30)",
                }}
              >
                <ActionIcon name="clock" size={12} />
                <span>{autoFeedTimingText}</span>
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {/* Active/Archive tabs — done steps live ONLY on the archive tab
                  so the queue never shows finished work unless asked. */}
              <div role="tablist" aria-label="Steps" style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--border)" }}>
                {([
                  { key: "active" as const, label: "Active", count: activeSteps.length },
                  { key: "archive" as const, label: "Archive", count: doneSteps.length },
                ]).map((t) => (
                  <button
                    key={t.key}
                    role="tab"
                    aria-selected={stepsTab === t.key}
                    onClick={() => setStepsTab(t.key)}
                    style={{
                      height: 28, padding: "0 12px", border: "none", background: "transparent",
                      borderBottom: stepsTab === t.key ? "2px solid var(--accent-ink)" : "2px solid transparent",
                      color: stepsTab === t.key ? "var(--fg-strong)" : "var(--fg-muted)",
                      fontSize: 11.5, fontWeight: 700, cursor: "pointer",
                    }}
                  >{t.label} ({t.count})</button>
                ))}
              </div>

              {stepsTab === "active" && (<>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <textarea
                  ref={newStepRef}
                  value={newStep}
                  onChange={(e) => setNewStep(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addStep(newStep); setNewStep(""); } }}
                  placeholder="Write a step and press Enter…"
                  style={{ ...textareaBase, flex: 1, minHeight: 32 }}
                />
                <button className="ghost-btn" onClick={() => { addStep(newStep); setNewStep(""); }} style={{ height: 32, padding: "0 12px", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, flexShrink: 0 }}><ActionIcon name="plus" size={14} />Add</button>
              </div>

              {activeSteps.length === 0 && (
                <div style={{ padding: 14, textAlign: "center", fontSize: 12, color: "var(--fg-muted)", background: "var(--bg-input)", borderRadius: 8, border: "1px dashed var(--border)" }}>
                  {doneSteps.length > 0
                    ? "All steps done — reopen one from the Archive tab, or add a new step above."
                    : "No steps yet — add one above, or digest your notes below."}
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {activeSteps.map((s) => (
                  <div key={s.id} style={{
                    display: "flex", flexDirection: "column", gap: 8,
                    padding: 10,
                    background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8,
                    opacity: s.status === "done" ? 0.6 : 1,
                  }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <button
                        onClick={() => setStep(s.id, { status: s.status === "done" ? "pending" : "done" })}
                        title={s.status === "done" ? "Re-open this step" : "Mark done"}
                        style={{ border: "none", background: "transparent", cursor: "pointer", color: statusColor(s), fontSize: 15, lineHeight: "20px", width: 20, padding: 0, flexShrink: 0 }}
                      >{statusIcon(s)}</button>

                      {editingStepId === s.id ? (
                        <textarea
                          ref={editStepRef}
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(); } else if (e.key === "Escape") { cancelEdit(); } }}
                          onBlur={saveEdit}
                          style={{ ...textareaBase, flex: 1, minHeight: 28 }}
                          autoFocus
                        />
                      ) : (
                        <div
                          onClick={() => startEdit(s)}
                          title="Click to edit"
                          style={{ flex: 1, fontSize: "var(--chat-font-size, 13px)", lineHeight: 1.5, color: "var(--fg)", textDecoration: s.status === "done" ? "line-through" : "none", whiteSpace: "pre-wrap", wordBreak: "break-word", cursor: "text" }}
                        >
                          {s.text}
                          {s.status === "sent" && <span style={{ display: "inline-block", marginLeft: 8, fontSize: 10, color: "var(--warn)", border: "1px solid rgba(var(--warn-rgb),0.45)", borderRadius: 999, padding: "1px 7px" }}>fed to team</span>}
                          {s.status === "failed" && <span style={{ display: "inline-block", marginLeft: 8, fontSize: 10, color: "var(--error)", border: "1px solid rgba(var(--error-rgb),0.45)", borderRadius: 999, padding: "1px 7px" }}>incomplete</span>}
                        </div>
                      )}
                    </div>
                    {s.status === "failed" && s.failureReason && (
                      <div style={{ paddingLeft: 28, fontSize: 10.5, color: "var(--error)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        {s.failureReason}
                      </div>
                    )}
                    {formatStepTiming(s) && (
                      <div style={{ paddingLeft: 28, fontSize: 10.5, color: "var(--fg-muted)", fontVariantNumeric: "tabular-nums" }}>
                        {formatStepTiming(s)}
                      </div>
                    )}

                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", paddingLeft: 28 }}>
                      {s.status !== "done" && (
                        <button
                          onClick={() => feedStep(s)}
                          disabled={lockedElsewhere}
                          aria-label={s.status === "sent" || s.status === "failed" ? "Re-feed" : "Feed"}
                          title={lockedElsewhere
                            ? "The queue is running in another window on this project — feeding is read-only here. Take over from the header to feed from this window."
                            : running ? "Feed now — steers the running team at its next boundary" : "Feed now — dispatches this step as a new goal"}
                          style={{ height: 24, padding: "0 10px", display: "inline-flex", alignItems: "center", gap: 4, border: "1px solid rgba(var(--warn-rgb),0.5)", borderRadius: 6, background: "rgba(var(--warn-rgb),0.12)", color: "var(--warn)", fontSize: 11, fontWeight: 700, cursor: lockedElsewhere ? "not-allowed" : "pointer", opacity: lockedElsewhere ? 0.5 : 1 }}
                        ><ActionIcon name="bolt" size={12} />{s.status === "sent" || s.status === "failed" ? "Re-feed" : "Feed"}</button>
                      )}
                      {feedNotice?.id === s.id && (
                        <span style={{
                          fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: "2px 8px",
                          color: feedNotice.kind === "no-team" ? "var(--error)" : feedNotice.kind === "queued" ? "var(--warn)" : "var(--ok)",
                          border: `1px solid ${feedNotice.kind === "no-team" ? "rgba(var(--error-rgb),0.45)" : feedNotice.kind === "queued" ? "rgba(var(--warn-rgb),0.45)" : "rgba(var(--ok-rgb),0.45)"}`,
                        }}>
                          {feedNotice.kind === "queued" ? "queued — steers the live run" : feedNotice.kind === "dispatched" ? "dispatched as a new goal" : "no team ready — pick a project & model"}
                        </span>
                      )}
                      <button className="ghost-btn" onClick={() => moveStep(s.id, -1)} title="Move up" aria-label="Move up" style={{ height: 24, width: 24, padding: 0, display: "grid", placeItems: "center" }}><ActionIcon name="chevron-up" size={14} /></button>
                      <button className="ghost-btn" onClick={() => moveStep(s.id, 1)} title="Move down" aria-label="Move down" style={{ height: 24, width: 24, padding: 0, display: "grid", placeItems: "center" }}><ActionIcon name="chevron-down" size={14} /></button>
                      <div style={{ flex: 1 }} />
                      <button className="ghost-btn" onClick={() => removeStep(s.id)} title="Delete step" aria-label="Delete step" style={{ height: 24, width: 24, padding: 0, display: "grid", placeItems: "center", color: "var(--error)" }}><ActionIcon name="trash" size={13} /></button>
                    </div>
                  </div>
                ))}
              </div>
              </>)}

              {/* Archive — done steps leave the active feed and live only on
                  this tab, where each can be reopened or cleared for good. */}
              {stepsTab === "archive" && (
                doneSteps.length === 0 ? (
                  <div style={{ padding: 14, textAlign: "center", fontSize: 12, color: "var(--fg-muted)", background: "var(--bg-input)", borderRadius: 8, border: "1px dashed var(--border)" }}>
                    No archived steps yet — steps marked done move here.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {doneSteps.map((s) => (
                      <div key={s.id} style={{ display: "flex", flexDirection: "column", gap: 3, padding: "6px 10px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 8, opacity: 0.75 }}>
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                          <ActionIcon name="check" size={13} style={{ color: "var(--ok)", marginTop: 2 }} />
                          <div style={{ flex: 1, fontSize: "var(--chat-font-size, 13px)", lineHeight: 1.45, color: "var(--fg-muted)", textDecoration: "line-through", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{s.text}</div>
                          <button className="ghost-btn" onClick={() => setStep(s.id, { status: "pending", startedAt: undefined, finishedAt: undefined })} title="Reopen this step (moves it back to the active feed)" aria-label="Reopen" style={{ height: 22, padding: "0 8px", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, flexShrink: 0 }}><ActionIcon name="rotate" size={12} />Reopen</button>
                          <button className="ghost-btn" onClick={() => removeStep(s.id)} title="Delete permanently" aria-label="Delete permanently" style={{ height: 22, width: 22, padding: 0, display: "grid", placeItems: "center", color: "var(--error)", flexShrink: 0 }}><ActionIcon name="trash" size={12} /></button>
                        </div>
                        {formatStepTiming(s) && (
                          <div style={{ paddingLeft: 22, fontSize: 10.5, color: "var(--fg-muted)", fontVariantNumeric: "tabular-nums" }}>{formatStepTiming(s)}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          </div>

        </div>
      </div>
  );

  if (inline) return panel;
  return (
    <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(8,12,20,0.6)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {panel}
    </div>
  );
}

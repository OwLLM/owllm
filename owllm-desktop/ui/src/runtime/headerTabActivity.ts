// headerTabActivity.ts — workflow-awareness for the second header (SubTabs).
//
// The second-header buttons for the Coding and Agents pages mirror those pages'
// own tab-strip "activity glow": the button pulses while that page has a run in
// flight and — if the run FINISHES while you're looking at another tab — the
// glow converts to a "finished (unseen)" check badge that clears when you open
// the page. Detection reuses runActivity's existing tags (code runs are tagged
// "code:*"/"stream:code:*", agent runs "agents:*"), so no page has to report
// anything new. This module is the pure state machine behind that UI, factored
// out so the active / completed / idle / simultaneous transitions are testable
// without a DOM.

/// Page key → the run-activity tag prefixes that mean "this page is working".
/// Code chats stream under "code:*" (CodePage setBusy) and "stream:code:*"
/// (chatRuntime); agent runs flag "agents:*". Pages absent here are never
/// workflow-aware (their header button behaves exactly as before).
export const HEADER_TAB_RUN_PREFIXES: Record<string, readonly string[]> = {
  code: ["code:", "stream:code:"],
  agents: ["agents:"],
};

/// Prefixes that make a page's header button workflow-aware ([] = never).
export function runPrefixesForPage(key: string): readonly string[] {
  return HEADER_TAB_RUN_PREFIXES[key] ?? [];
}

/// Does this page participate in the workflow-aware glow at all?
export function isWorkflowAwarePage(key: string): boolean {
  return runPrefixesForPage(key).length > 0;
}

export type TabActivityState = {
  /// Last-seen working flag per page key (the transition source).
  working: Record<string, boolean>;
  /// "Finished while you were away" badge per page key.
  done: Record<string, boolean>;
};

export function initTabActivity(): TabActivityState {
  return { working: {}, done: {} };
}

function sameFlags(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

/// Advance the badge state machine one tick.
/// - a page whose run finishes (working → idle) while it is NOT the active tab
///   earns a finished badge;
/// - opening a tab (activeKey) clears its badge — you've now "seen" it;
/// - a page that is still working never carries a badge (the live glow wins;
///   see `showFinishedBadge`), so the two signals never show at once.
/// Returns `prev` unchanged when nothing moved, so it's a safe React updater
/// (Object.is bail-out — no needless re-render).
export function stepTabActivity(
  prev: TabActivityState,
  workingNow: Record<string, boolean>,
  activeKey: string,
): TabActivityState {
  const done: Record<string, boolean> = { ...prev.done };
  for (const key of Object.keys(workingNow)) {
    const was = prev.working[key] ?? false;
    const now = workingNow[key] ?? false;
    // Active tab is always "seen", so a run finishing there never badges.
    if (was && !now && key !== activeKey) done[key] = true;
  }
  // Opening a tab clears its finished badge.
  if (done[activeKey]) delete done[activeKey];

  const workingChanged = !sameFlags(prev.working, workingNow);
  const doneChanged = !sameFlags(prev.done, done);
  if (!workingChanged && !doneChanged) return prev;
  return { working: { ...workingNow }, done };
}

/// Show the finished badge only when the page finished-while-away AND is not
/// currently working — the live glow takes precedence so there's never a
/// double signal on one button.
export function showFinishedBadge(
  state: TabActivityState,
  key: string,
  workingNow: boolean,
): boolean {
  return !!state.done[key] && !workingNow;
}

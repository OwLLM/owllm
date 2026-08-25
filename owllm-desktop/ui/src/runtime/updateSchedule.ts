// When a running app looks for a new release.
//
// This exists because a fixed interval alone cannot answer "notify me without
// restarting". A multi-OS publish takes ~90 minutes: the hub uploads its own
// installer and writes latest.json with ONLY its own platform key (the sibling
// keys are deliberately wiped when the version changes — a carried-forward
// entry would point a platform at the PREVIOUS version's artifact and loop it
// forever), and finish-multihost.sh merges the other platforms in later.
//
// While that window is open, tauri-plugin-updater's check() does not report
// "no update" for the platforms not yet merged — it THROWS TargetNotFound
// (updater.rs resolves the platform URL before it looks at the version). So an
// app that happened to check inside the window got an error, and on a plain
// setInterval it would not look again for a full period. Linux and macOS
// installs sat on the old version for hours after the release completed.
//
// Hence two cadences: a steady one for "a release appeared since I last
// looked", and a fast backoff for "I asked and could not get an answer", which
// is what a publish in progress looks like from the client.
//
// v1.0.29 showed the OTHER half of that story, and it is why the steady cadence
// is minutes rather than half an hour. Releases are published as a PRE-release
// and promoted to Latest only once every platform is uploaded (standing
// policy). While a pre-release is in flight, the updater endpoint —
// releases/LATEST/download/latest.json — still resolves to the PREVIOUS
// release, whose manifest names the version the client already runs. So the
// client does not get TargetNotFound at all: it gets a clean, correct "you are
// up to date", resets its failure count, and sleeps a full steady period. A
// promote landing one second later is therefore invisible for that whole
// period. Measured on v1.0.29: the merged manifest went live at 11:40:11Z and
// the hub's own running app still showed nothing at 12:02Z — not broken, just
// asleep. The backoff above cannot help, because nothing failed.
//
// Two fixes, both here so they are executable by the gate: a steady period
// short enough that "the release is online" and "the app said so" are minutes
// apart, and an event-driven re-check (back online, or the user returning to
// the window) floored so it cannot become a storm.

/// Steady cadence once a check has answered — success or a clean "nothing new".
/// Costs one ~4 KB GET of a static CDN asset; a promote is never more than this
/// far from being noticed.
export const RECHECK_MS = 5 * 60 * 1000;

/// Floor between two EVENT-driven checks (network back, window focused,
/// webview un-occluded). Alt-tabbing must not re-check on every focus.
export const MIN_EVENT_RECHECK_MS = 60 * 1000;

/// Whether an event-driven re-check may run now, given when the last check ran.
/// `lastRunAt === 0` means "never checked", which always may.
export function mayRecheckNow(lastRunAt: number, now: number): boolean {
  return now - lastRunAt >= MIN_EVENT_RECHECK_MS;
}

/// First retry after a check that could not answer.
export const RETRY_BASE_MS = 60 * 1000;

/// Ceiling for the retry backoff, so a genuinely broken release settles into a
/// quiet poll instead of hammering the endpoint, while still recovering within
/// minutes of the manifest being completed.
export const RETRY_MAX_MS = 15 * 60 * 1000;

/// A publish in progress makes "this platform has no artifact" briefly TRUE.
/// Only tell the user once it has stayed true across enough retries that it is
/// no longer explainable by a release still being assembled.
export const FAILURES_BEFORE_SURFACING = 4;

/// How long to wait before the next check, given how many checks in a row have
/// failed (0 = the last one answered).
export function nextCheckDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return RECHECK_MS;
  const backoff = RETRY_BASE_MS * 2 ** (consecutiveFailures - 1);
  return Math.min(backoff, RETRY_MAX_MS);
}

/// Whether a failing check has failed long enough to be worth showing.
export function shouldSurfaceCheckError(consecutiveFailures: number): boolean {
  return consecutiveFailures >= FAILURES_BEFORE_SURFACING;
}

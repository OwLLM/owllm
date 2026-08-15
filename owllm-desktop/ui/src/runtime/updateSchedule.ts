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

/// Steady cadence once a check has answered — success or a clean "nothing new".
export const RECHECK_MS = 30 * 60 * 1000;

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

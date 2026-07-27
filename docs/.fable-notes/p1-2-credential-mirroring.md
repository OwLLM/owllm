# P1-2 · Credential mirroring observability — notes

Completed 2026-06-13. Probes: unit test covering all 4 (on_host × in_sandbox)
states; live `probe_sync_logins_report` ran the REAL sync on this machine —
all 5 providers (codex/claude/gemini/kimi/keys) reported "mirrored", flags
consistent with the found/synced sets.

## What this package is and is NOT

The plan names vault.rs, but the real sync lives in `sandbox.rs`
(`sync_logins_impl`) — vault.rs's `github_connect` path reports via its own
sandboxConfigured/hostConfigured flags already. The copy mechanics were
already deterministic (stdin-piped script, FOUND:/SYNCED: sentinels, /mnt
path conversion in Rust). What was missing was the per-credential report.
**Did not add any new credential-file copying** — the classifier limits in
the plan (§P1-2) forbid new auth.json-into-WSL paths; this package only
maps the existing found/synced sets to named per-provider outcomes.

- `build_mirror_report(found, synced)` — pure, unit-tested, one row per
  provider with the why ("mirrored" / "found on Windows but did NOT land —
  check WSL distro" / "present from an earlier sync" / "log in first").
- `SyncResult.report: Vec<MirrorStatus>` — additive; existing fields kept
  so other callers don't break.
- CodePage "Sync logins" renders the full report (status line now expands
  to multi-line via whiteSpace: pre-line when the text contains \n).

## Lessons

- sandbox.rs had TWO `SyncResult` definitions — an ungated one and a
  `#[cfg(not(windows))]` duplicate → would be a duplicate-definition error
  on a Linux build. Consolidated to one. Check for this pattern when
  touching cfg-split modules (P0-7 will hit it).
- CodePage's status line was nowrap+ellipsis — any multi-line report would
  silently truncate. If a surface is getting structured output, check the
  render path, not just the data path.

## Remaining risks

- The auto-sync after provisioning (CodePage ~line 408) still shows the
  short summary, not the full report — fine (the manual button is the
  diagnostic surface), but extend if users miss it.
- Per-credential FAILURE reasons (why a cp failed: permissions vs missing
  distro) are inferred, not captured per-file. Capturing them would mean
  touching the credential-copy script — deliberately out of scope.

# P0-5 · Isolation reliability (WSL path hardening) — notes

Completed 2026-06-13. Probe: `cargo test --lib -- --ignored probe_` run with the
WSL service cold (`wsl --shutdown`) AND docker-desktop temporarily set as the
default distro — the exact done-when scenario. 6/6 live probes passed; default
restored to Ubuntu afterwards.

## What was actually broken (verified, not assumed)

- **Raw-default-distro (§0.5b) had crept back in 6 places** despite v0.4.73:
  `wsl_toolchain_status`, `wsl_provision` (wsl.rs), `sync_logins_impl`,
  `login_status_impl`, `convert_impl` host→isolated (sandbox.rs), and
  `configure_sandbox` + `github_disconnect` scrub (github.rs). All resolved
  `wsl_status().default_distro` — on a docker-desktop-default machine these
  probe/provision/sync/scrub in busybox, or worse, a *different* distro than
  the one holding projects/envs.
- **convert_impl was a split-brain bug**: project created via
  `best_linux_distro()` (Ubuntu) but the file copy ran in the raw default
  (docker-desktop). Fix: parse the distro back out of the created project's
  UNC path so create and copy always agree.
- **Positional line parsing (§0.5c)** survived in `env_manager::status_impl`
  (line-0 "OK", line-1 hash) and `wsl_backend::wsl_home` (line 0 = $HOME).
  Both now use `OWLLM_*=` sentinels scanned across all lines.
- **`run_root_capture` (wsl_setup.rs) bypassed `decode_wsl`** → UTF-16LE
  mojibake on wsl.exe-level errors. Now delegates to the shared runner.
- **`wsl_provision`'s script went through `bash -lc "<arg>"`** with nested
  double quotes (the gh-keyring line) — the exact mangling class from
  `feedback_wsl_complex_script_via_stdin`. Now piped via stdin.

## Structural fix that prevents recurrence

Added `wsl::run_in_distro_script_user(distro, Option<user>, script)` — stdin
piping + `decode_wsl` + `-u` in ONE place. `run_in_distro_script` and
wsl_setup's `run_root_capture` delegate to it; `run_wsl_user` (the `-lc`-arg
path) was deleted. Any future "run as root in distro" need should use this,
not a new Command::new("wsl.exe").

## Lessons

- `wsl.exe` output on this machine IS UTF-16LE (confirmed live: `wsl -l -v`
  prints space-interleaved chars in PowerShell). Never parse it undecoded.
- The committed `#[ignore]`d `probe_*` tests in wsl.rs/env_manager.rs are the
  regression harness for this whole class: run them cold
  (`wsl --shutdown` first) and ideally with `wsl --set-default docker-desktop`
  (restore after!). Cheap to re-run before any release touching wsl/sandbox.
- Sentinel checks now also guard *writes*: `ensure_user` requires `USER_OK`,
  `convert_impl` requires `OWLLM_COPIED=1`, `wsl_provision` requires
  `PROVISION_DONE` in output — a zero exit alone is not proof the script ran.
- bridges.rs `round_trip_through_json` test was stale (missing new
  BridgeConfigs fields) and blocked the whole `cargo test --lib` target;
  fixed with `..Default::default()`.
- Frontend was already compliant: readinessStore keeps last-good on transient
  failure, HomePage self-heals one forced re-check 4s after a not-ready first
  probe. No persistent "not installed" cache exists.

## Remaining risks

- `wsl_setup_status` reports stage "ready" when a registered distro can't run
  `id -u` after 2 attempts and no install marker exists (optimistic by
  design — avoids false reboot loops). A manually-half-installed WSL can read
  as ready. Acceptable; revisit in P1-1 honest-status if it bites.
- `sandbox_status.available` is still true when ONLY docker-desktop exists
  (P1-1 honest-isolation territory; `default_target` now reports the real
  distro, so the UI has the data to be honest).
- Probes ran on this dev box (Ubuntu present). A box with ONLY docker-desktop
  → best_linux_distro=None paths are unit-covered but not live-probed.

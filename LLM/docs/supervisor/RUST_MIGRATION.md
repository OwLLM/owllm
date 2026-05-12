# Rust migration plan — bootstrap.exe

## Why

The current native binary lineup has two toolchains:

| Binary | Lang | Toolchain | Role |
|---|---|---|---|
| `LLM/launcher.exe` | C++ | MinGW (g++) | Spawns python_runtime + LAUNCHER.py |
| `LLM/bootstrap/bootstrap.exe` | Go | Go 1.22 | AI installer (probe → spawn brain → plan → execute) |

Both binaries are native launchers that run before Python exists.
Both jobs could be done in any of {C++, Go, Rust}. Maintaining
**two** native toolchains for the same architectural role is
duplicated complexity.

**Decision (recorded 2026-05-12):** standardize on Rust going forward.
Reasons:

1. **Tauri-ready.** The Q1 future-state recommendation in
   `docs/supervisor/ARCHITECTURE.md` (and re-affirmed in chat) is a
   Tauri-shelled desktop app. Tauri IS Rust. Bootstrap code written
   in Rust can be reused inside Tauri commands when/if we make that
   pivot. Go code would be discarded.
2. **Smaller binary.** Equivalent installer in Rust ≈ 2–3 MB vs Go ≈ 5 MB.
3. **Memory + type safety.** No nil panics in production.
4. **Cargo ecosystem.** `reqwest` / `serde_json` / `sha2` / `clap` are
   tier-1 and have no Go equivalent advantage.

Tradeoffs accepted:
- ~3-10× slower clean compile than Go (~30-90 s vs ~3-5 s).
- Steeper learning curve for anyone joining the project.

## Scope (port targets)

From `LLM/bootstrap/bootstrap_go/`:

| Component | Lines | Tests | Priority |
|---|---|---|---|
| `main.go` | ~ | 0 | last |
| `exec/runner.go` | 34 | n/a | foundation |
| `exec/args.go` | (in stubs) | n/a | foundation |
| `exec/stubs.go` | 174 | n/a | foundation |
| `exec/set_env.go` | 94 | 85 | P0 (proof of concept) |
| `exec/ask_user.go` | ~50 | ~60 | P0 |
| `exec/uninstall_pkg.go` | 48 | 46 | P0 |
| `exec/create_venv.go` | ~70 | ~80 | P1 |
| `exec/install_pkg.go` | 93 | 95 | P1 |
| `exec/download_file.go` | 138 | 134 | P1 |
| `exec/swap_wheel.go` | 132 | 115 | P1 |
| `exec/profile.go` + `pick_profile` | 70 | 160 | P2 |
| `plan/plan.go` | ~? | ~? | P2 |
| `server/llama.go` + hide_*.go | ~? | 0 | P2 |
| `hardware/probe.go` | ~? | 0 | P3 |
| `main.go` orchestration | ~ | 0 | last |

Total: ~2000 lines Go + ~50 tests to port. Estimate: 3 weeks
focused work.

## Crate selections

| Concern | Crate | Why |
|---|---|---|
| HTTPS download | `reqwest` (blocking) | de-facto standard, has progress hook |
| JSON | `serde` + `serde_json` | de-facto standard, derive-able structs |
| SHA-256 | `sha2` | RustCrypto, audited |
| CLI args | `argh` | small, derive-based, no help-text bloat |
| Errors | `anyhow` + `thiserror` | anyhow for app code, thiserror for libs |
| Logging | `tracing` | structured, lower overhead than `log` |
| Process | `std::process::Command` | stdlib is enough |
| Atomic writes | `tempfile` | tested rename-on-windows path |
| Windows-specific (hidden console, etc.) | `windows-sys` (cherry-picked) | only what we need, not the full `windows` crate |

`reqwest` brings tokio in by default — use `default-features = false`
with `["blocking", "rustls-tls"]` to stay sync and avoid OpenSSL.

## Target: portable Rust toolchain

Mirror the Go pattern. The Rust toolchain lives under
`LLM/tools/rust/` (not committed; ~250 MB extracted), pulled in via
`LLM/tools/download_rust.ps1`. `build_installer.bat` auto-detects it
the same way it auto-detects Go.

Toolchain choice: **rust-x86_64-pc-windows-gnu** so we reuse the
existing MinGW link toolchain (`launcher.exe` already builds against
MinGW). Avoids requiring MSVC build tools / Visual Studio.

## Migration phases

### R1 — Scaffold (1-2 days)

- Create `LLM/bootstrap/bootstrap_rs/` with `Cargo.toml`
- Module layout mirrors Go:
  ```
  bootstrap_rs/
    Cargo.toml
    src/
      main.rs        ← entry
      exec/          ← executor module per action
        mod.rs
        runner.rs
        set_env.rs
        ...
      plan/
        mod.rs
      server/
      hardware/
  ```
- Set up `LLM/tools/download_rust.ps1`
- `build_installer.bat` learns to find and use Rust the same way it
  finds Go
- Cargo workspace pinned to a known Rust version via `rust-toolchain.toml`
- CI placeholder: `cargo test --workspace` (replaces `go test ./...`)

### R2 — Port simple actions (3-5 days)

In rough dependency order:
- `runner.rs` — `CmdRunner` trait + default `RealRunner` impl
- `args.rs` — typed accessors (`args.string("key")`, `args.int("k")`)
- `set_env.rs` + tests
- `ask_user.rs` + tests
- `uninstall_pkg.rs` + tests
- `stubs.rs` — `Executor` struct + `dispatch()` table

Each action's port flow:
1. Read the Go file + test
2. Translate to idiomatic Rust (no line-for-line — use enums where Go
   used string switches, etc.)
3. Port tests using same fakes pattern (Go's `runner` interface →
   Rust's `Runner` trait + mock impl)
4. `cargo test` green before moving on

### R3 — Port HTTP / package actions (3-5 days)

- `download_file.rs` — reqwest blocking, sha256 verify, atomic
  `.part` → rename via `tempfile::PersistableFile`
- `install_pkg.rs` — pip subprocess wrapper with `--index-url`,
  version pinning, extras
- `swap_wheel.rs` — uninstall + install at version
- `create_venv.rs` — idempotent venv with non-venv refusal logic

### R4 — Port plan + server (5-7 days)

- `plan.rs` — JSON parsing with markdown-fence stripping. serde
  handles strict JSON; add a small pre-pass for fences and trailing
  prose. Balanced-brace recovery via custom parser if needed.
- `server.rs` — llama-server spawn with `CREATE_NO_WINDOW` flag (via
  `windows-sys`), `/health` polling
- `pick_profile.rs` — profile match logic + inline expansion +
  recursion guard

### R5 — Port hardware probe + main (3-4 days)

- `hardware.rs` — nvidia-smi/wmic/dxdiag shell-outs + JSON output
  matching the schema the Python `hardware_probe.py` expects
- `main.rs` — orchestration loop (probe → spawn brain → fetch plan →
  execute → done)

### R6 — Cutover (1-2 days)

- `build_installer.bat`: switch Rust to default, Go as fallback path
- Mark `bootstrap_go/` directory with `DEPRECATED.md` note
- Keep Go in tree for 2 releases as rollback safety
- After 2 releases with no Rust-side regressions: delete `bootstrap_go/`

## Test parity rules

- A port is not "done" until `cargo test --package bootstrap_rs --test <action>`
  has at least as much coverage as `go test ./exec/<action>_test.go`
- Each action port keeps the same fake-injection pattern so behavior
  invariants stay testable offline (no llama-server in unit tests)
- Once R5 ships, the **Go and Rust binaries must be functionally
  identical** — run them side-by-side against the same plan JSON,
  diff their output

## Parallel-build safety

Same pattern as the supervisor itself:

- Both binaries co-exist throughout the migration
- `build_installer.bat` flag picks which one ships:
  - `--use-rust` (default after R6) → `bootstrap_rs` → `bootstrap.exe`
  - `--use-go` (rollback) → `bootstrap_go` → `bootstrap.exe`
- The NSIS installer is unchanged — it just bundles whichever
  `bootstrap.exe` got built
- No feature-flag changes on the Python side; the Rust binary
  satisfies the same contract

## Risks

| Risk | Mitigation |
|---|---|
| Rust compile times slow down iteration | Use `cargo check` during dev (~5 s); only full build on commit |
| `reqwest` pulls TLS via OpenSSL | Use `rustls-tls` feature, no system OpenSSL |
| MinGW vs MSVC ABI gotchas | Pin to `x86_64-pc-windows-gnu` triple consistently |
| Tokio gets pulled in despite blocking choice | Audit `cargo tree`, gate `reqwest` features carefully |
| Test fakes harder than Go interfaces | Use `mockall` if hand-rolled traits get unwieldy |
| Migration drags, Go side bit-rots | Hard freeze on Go-side changes after R3; bug-fixes only |

## Status tracking

| Phase | State | Owner | Date |
|---|---|---|---|
| R1 — scaffold | ✅ complete | claude | 2026-05-12 |
| R2 — simple actions | ✅ complete | claude | 2026-05-12 |
| R3 — HTTP / pkg | ✅ complete | claude | 2026-05-12 |
| R4 — plan + server | not started | | |
| R5 — hardware + main | not started | | |
| R6 — cutover | not started | | |

### R2 deliverables (2026-05-12)

Ported from `bootstrap_go/exec/`:

- `runner.rs` — `Runner` trait + `RealRunner` (std::process::Command) +
  `FakeRunner` (captures calls + optional canned error). Tests: 3
- `python.rs` — `python_exe_path`, `is_existing_venv`,
  `find_host_python` (env override → bundled → PATH). Tests: 3
- `pkgname.rs` — `stripped_package_name`. Tests: 6
- `args.rs` — added `arg_string_slice`. Tests: now 10 (was 5)
- `plan.rs` — added `reason`, `fallback` fields + `Step::new(...)
  .with_args(...).with_reason(...)` builder for ergonomic test setup.
- `exec/set_env.rs` — unchanged from R1, tests updated to builder.
- `exec/ask_user.rs` — new. Writes `runtime/pending_question.json`,
  errors to halt the plan loop. Tests: 5
- `exec/uninstall_pkg.rs` — new. Wraps `pip uninstall --yes` via
  `Runner`. Tests: 4
- `exec/create_venv.rs` — new. Idempotent venv build, refuses
  non-venv clobber. Tests: 3 (idempotent, refuse-clobber, default-path
  + side-effecting fake runner pattern)
- `exec/stubs.rs` — new. `Executor` struct with active-venv state
  threaded across steps; `run_plan` walks a `&[Step]` with step cap +
  dry-run support; `dispatch` routes to ported actions and returns a
  clear "not yet ported" error for R3-R4 actions. Tests: 4

**Total**: 11 (R1) + 35 (R2) = **46 tests passing**, 0 failures.

Binary size after R2:
- `bootstrap_rs/target/release/bootstrap.exe` = **0.25 MB**
- `bootstrap.exe` (Go, full 8-action surface) = **5.20 MB**

Rust binary doesn't grow noticeably across R1→R2 because the new code
is small relative to the serde+anyhow baseline. R3 will pull in
`reqwest` + `sha2` which adds ~500 KB-1 MB.

### R3 deliverables (2026-05-12)

Ported from `bootstrap_go/exec/`:

- `pipspec.rs` — `build_pip_spec(name, version, extras)`. 7 tests
  covering the buildPipSpec table from the Go side, including the
  inline-version pass-through case.
- `profile.rs` — `ProfileTable` / `ProfileSpec` types, `load_profile_table`,
  `find_profile`. Tolerant: missing recipe file is not an error, but a
  malformed one is. 4 tests.
- `exec/install_pkg.rs` — pip install wrapper with `--index-url` and
  extras. 6 tests including runner-failure-with-context, missing
  index/extras paths, omits-index-when-not-given.
- `exec/swap_wheel.rs` — uninstall + install at target version. 5 tests
  including version-stripping for the uninstall target.
- `exec/download_file.rs` — HTTPS download via ureq (blocking +
  bundled rustls — no async runtime, no system OpenSSL). Atomic
  `.part` → rename, optional sha256 verify with hash-match short-
  circuit, `validate_url` (https only unless `LOCALLLM_ALLOW_HTTP=1`).
  Introduces a `Fetcher` trait so production wires `UreqFetcher` and
  tests use either a `FakeFetcher` (canned `(status, body)`) or
  the hand-rolled `MockHttpServer` (real `TcpListener` on
  127.0.0.1:0) — same `httptest` pattern Go uses. 6 tests including
  the loopback integration test (gated behind `#[ignore]` for
  sandboxed CI).
- `exec/stubs.rs` — Executor now wires ALL eight actions plus
  pick_profile + abort. New state fields: `fetcher` (defaults to a
  static `UreqFetcher`), `profiles` (lazily loaded), and
  `expanding_profile` (recursion guard so a profile whose steps
  include another `pick_profile` fails loudly instead of looping).
  5 new pick_profile tests (dry-run walks substeps, unknown id,
  missing id, recursion guard, install-after-create-venv threading).

Toolchain bump:

  rust-toolchain.toml: 1.78.0 → 1.86.0. ureq's transitive deps
  (`idna_adapter`, `url`, `icu_*`) require edition2024, which was
  stabilized in 1.85. Bumping to 1.86 removed the version-pinning
  workarounds in dev-dependencies and the inline `=2.10.1` on ureq.
  Portable Rust at LLM/tools/rust/ is now ~600 MB of 1.86 GNU.

Build:
  cargo build --release: clean in 16.58 s (includes ureq+rustls
    compilation from scratch on first run)
  cargo test --quiet -- --include-ignored: 78 / 78 passing
  bootstrap.exe (Rust, all 8 actions wired)  = 0.26 MB
  bootstrap.exe (Go,   all 8 actions wired)  = 5.20 MB

Note: the Rust binary stays at 0.26 MB after R3 because ureq +
rustls + serde compile to ~200 KB after LTO + strip + size-opt.
The earlier projection of "1-2 MB after R3" was conservative;
real-world result is much better.

R4 = plan parser (markdown-fence-tolerant JSON parsing of LLM
output) + llama-server lifecycle (spawn with hidden console,
`/health` poll, graceful shutdown). Most of the JSON heavy
lifting will already be there via serde — the actual parser code
is small, but the GBNF-grammar work for constrained generation
needs careful handling.

This doc is the source of truth for the migration. Update the table
above as phases complete.

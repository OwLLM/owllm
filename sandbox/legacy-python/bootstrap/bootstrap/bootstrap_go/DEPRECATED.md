# bootstrap_go is deprecated

This Go implementation of the supervisor bootstrap was replaced by
the Rust port at `LLM/bootstrap/bootstrap_rs/`. Migration history
and rationale live in
[LLM/docs/supervisor/RUST_MIGRATION.md](../../docs/supervisor/RUST_MIGRATION.md).

## What still works

`bootstrap_go/` compiles and runs as before. `build_installer.bat
--use-go` selects this path so we can fall back to a known-good
build during the deprecation window.

## What changed

`build_installer.bat` with no flags now builds `bootstrap_rs/`
instead. The Rust binary:

- has full functional parity (115 tests passing vs Go's ~50)
- is ~68% smaller (1.68 MB vs 5.20 MB)
- reuses the same MinGW link toolchain that builds `launcher.exe`
  (no MSVC dependency)
- keeps the same on-wire JSON shapes and CLI flags so the Python
  side (`core/supervisor/`) doesn't know which native bootstrap
  ran

## Deletion timeline

This tree stays on disk for **two production releases** as a
rollback path. If no Rust-side regressions surface in that window,
`bootstrap_go/` will be deleted. The migration doc tracks the
expected cutover date.

If you're touching this tree because you found a real bug:
**please port the fix to `bootstrap_rs/` too** (or only to it,
if it doesn't affect any user actively running `--use-go`).

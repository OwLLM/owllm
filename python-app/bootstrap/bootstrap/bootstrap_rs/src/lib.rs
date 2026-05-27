//! bootstrap_rs — Rust port of bootstrap_go. See
//! `LLM/docs/supervisor/RUST_MIGRATION.md` for the migration plan.
//!
//! Phase R5 complete: all of bootstrap_go is now ported. The
//! `bootstrap` binary in main.rs orchestrates probe -> spawn ->
//! diagnose -> execute -> shutdown. R6 (cutover) is the remaining
//! phase — flip `build_installer.bat` so bootstrap_rs is the
//! default build target.

pub mod args;
pub mod diagnose;
pub mod exec;
pub mod hardware;
pub mod pipspec;
pub mod pkgname;
pub mod plan;
pub mod plan_parser;
pub mod profile;
pub mod python;
pub mod runner;
pub mod server;

pub use exec::Executor;
pub use plan::Step;
pub use runner::{FakeRunner, RealRunner, Runner};
pub use server::{Server, ServerConfig};

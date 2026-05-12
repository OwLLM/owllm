//! bootstrap_rs — Rust port of bootstrap_go. See
//! `LLM/docs/supervisor/RUST_MIGRATION.md` for the migration plan.
//!
//! Phase R2 in progress: scaffold + simple actions (set_env, ask_user,
//! uninstall_pkg, create_venv) + executor dispatcher.

pub mod args;
pub mod exec;
pub mod pkgname;
pub mod plan;
pub mod python;
pub mod runner;

pub use exec::Executor;
pub use plan::Step;
pub use runner::{FakeRunner, RealRunner, Runner};

//! bootstrap_rs — Rust port of bootstrap_go. See
//! `LLM/docs/supervisor/RUST_MIGRATION.md` for the migration plan.
//!
//! Phase R1 in progress: scaffold + one proof-of-concept action
//! (`set_env`). The full executor surface lands in R2-R5.

pub mod args;
pub mod exec;
pub mod plan;

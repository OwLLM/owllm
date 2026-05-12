//! bootstrap_rs — Rust port of bootstrap_go. See
//! `LLM/docs/supervisor/RUST_MIGRATION.md` for the migration plan.
//!
//! Phase R4 complete: all 8 executor actions ported, hardware
//! profile loader ported, plan parser ported, llama-server lifecycle
//! ported, diagnose orchestration ported.
//!
//! Pending: hardware probe + main orchestration (R5), cutover (R6).

pub mod args;
pub mod diagnose;
pub mod exec;
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

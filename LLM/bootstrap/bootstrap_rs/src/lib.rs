//! bootstrap_rs — Rust port of bootstrap_go. See
//! `LLM/docs/supervisor/RUST_MIGRATION.md` for the migration plan.
//!
//! Phase R3 complete: all 8 executor actions ported, hardware
//! profile loader ported. Pending: plan parser + llama-server
//! lifecycle (R4) and hardware probe + main orchestration (R5).

pub mod args;
pub mod exec;
pub mod pipspec;
pub mod pkgname;
pub mod plan;
pub mod profile;
pub mod python;
pub mod runner;

pub use exec::Executor;
pub use plan::Step;
pub use runner::{FakeRunner, RealRunner, Runner};

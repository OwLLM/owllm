//! Placeholder entry point. Real orchestration (probe -> spawn brain
//! -> fetch plan -> execute) lands in Phase R5 (see
//! `LLM/docs/supervisor/RUST_MIGRATION.md`). For now the binary just
//! prints a banner so `cargo build` produces a working executable we
//! can ship alongside the Go bootstrap.

fn main() {
    let version = env!("CARGO_PKG_VERSION");
    eprintln!("bootstrap_rs v{version} — scaffold (phase R1). Use bootstrap_go for now.");
    std::process::exit(0);
}

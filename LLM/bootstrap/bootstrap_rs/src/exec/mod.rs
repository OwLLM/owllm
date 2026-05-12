//! Executor module — one Rust submodule per action.
//!
//! Mirrors `bootstrap_go/exec/` one-to-one. Each action file owns its
//! implementation plus its tests. Higher-level orchestration (the
//! action dispatcher, the trust-tier table) will land in
//! [`stubs`] alongside the remaining ports.

pub mod set_env;

// pub mod ask_user;
// pub mod uninstall_pkg;
// pub mod create_venv;
// pub mod install_pkg;
// pub mod download_file;
// pub mod swap_wheel;
// pub mod pick_profile;
// pub mod runner;
// pub mod stubs;

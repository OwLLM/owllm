//! Executor module — one Rust submodule per action.
//!
//! Mirrors `bootstrap_go/exec/` one-to-one.

pub mod ask_user;
pub mod create_venv;
pub mod set_env;
pub mod stubs;
pub mod uninstall_pkg;

// pub mod install_pkg;   // R3
// pub mod download_file; // R3
// pub mod swap_wheel;    // R3
// pub mod pick_profile;  // R3

pub use stubs::Executor;

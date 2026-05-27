//! Executor module — one Rust submodule per action.
//!
//! Mirrors `bootstrap_go/exec/` one-to-one.

pub mod ask_user;
pub mod create_venv;
pub mod download_file;
pub mod install_pkg;
pub mod set_env;
pub mod stubs;
pub mod swap_wheel;
pub mod uninstall_pkg;

pub use stubs::Executor;

//! OWLLM install-time bootstrap — main entry point.
//!
//! Port of `bootstrap_go/main.go`. Pipeline:
//!   1. Probe hardware (wmic + nvidia-smi).
//!   2. Spawn the bundled llama-server + Gemma 4 E2B GGUF; wait
//!      for `/health`.
//!   3. POST the structured install request to the model. The
//!      model responds with a JSON Plan: a list of Steps.
//!   4. Execute steps sequentially. Errors halt with a clear
//!      message — every action is idempotent so the user can
//!      re-run bootstrap and the model picks up where it left off.
//!   5. Shut down llama-server. Exit.

use anyhow::{Context, Result};
use bootstrap_rs::{
    diagnose::{diagnose_with_files, DiagnoseRequest},
    exec::Executor,
    hardware::probe as probe_hardware,
    runner::RealRunner,
    server::{Server, ServerConfig},
};
use std::env;
use std::path::PathBuf;
use std::time::Duration;

const DEFAULT_PORT: u16 = 8765;
const BOOT_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_STEPS_PER_RUN: usize = 50;

#[derive(Debug, Default)]
struct Args {
    dry_run: bool,
    port: u16,
    verbose: bool,
}

fn parse_args() -> Args {
    let mut a = Args {
        port: DEFAULT_PORT,
        ..Default::default()
    };
    let mut it = env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--dry-run" => a.dry_run = true,
            "-v" | "--verbose" => a.verbose = true,
            "--port" => {
                if let Some(v) = it.next() {
                    a.port = v.parse().unwrap_or(DEFAULT_PORT);
                }
            }
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            other => {
                eprintln!("bootstrap: unknown flag {other:?}");
                print_usage();
                std::process::exit(2);
            }
        }
    }
    a
}

fn print_usage() {
    eprintln!("Usage: bootstrap [--dry-run] [--port N] [-v]");
    eprintln!();
    eprintln!("  --dry-run      Skip action execution; print plan only.");
    eprintln!("  --port N       llama-server HTTP port (default {DEFAULT_PORT}).");
    eprintln!("  -v, --verbose  Verbose logging.");
}

fn bootstrap_dir() -> PathBuf {
    if let Ok(v) = env::var("LOCALLLM_BOOTSTRAP_DIR") {
        if !v.is_empty() {
            return PathBuf::from(v);
        }
    }
    match env::current_exe() {
        Ok(exe) => exe.parent().unwrap_or(&PathBuf::from(".")).to_path_buf(),
        Err(_) => PathBuf::from("."),
    }
}

fn llama_server_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

fn load_recipe_summary(boot_dir: &std::path::Path) -> String {
    std::fs::read_to_string(boot_dir.join("recipes").join("hardware_profiles.json"))
        .unwrap_or_else(|_| "{}".to_string())
}

fn run() -> Result<()> {
    let args = parse_args();
    let boot_dir = bootstrap_dir();
    eprintln!("OWLLM bootstrap starting (dir={})", boot_dir.display());

    // 1. Probe.
    let hw = probe_hardware();
    if args.verbose {
        let pretty = serde_json::to_string_pretty(&hw).unwrap_or_default();
        eprintln!("hardware spec:\n{pretty}");
    }

    // 2. Spawn llama-server.
    let cfg = ServerConfig {
        binary: boot_dir.join("runtime").join(llama_server_name()),
        model: boot_dir
            .join("runtime")
            .join("gemma-4-E2B-it-Q4_K_M.gguf"),
        grammar: Some(boot_dir.join("recipes").join("plan.gbnf")),
        port: args.port,
        boot_timeout: BOOT_TIMEOUT,
    };
    let mut srv = Server::start(cfg).context("could not start llama-server")?;

    // 3. Build request and ask the model for a plan.
    let hw_json = serde_json::to_value(&hw).context("hardware -> JSON")?;
    let req = DiagnoseRequest {
        hardware: hw_json,
        install_goal: "owllm-3.0".into(),
        recipes: load_recipe_summary(&boot_dir),
    };
    let recipes_dir = boot_dir.join("recipes");
    let steps = diagnose_with_files(&srv, &recipes_dir, &req, REQUEST_TIMEOUT)
        .context("model returned no plan")?;
    eprintln!("model returned {} steps", steps.len());

    // 4. Execute.
    let runner = RealRunner;
    let mut executor = Executor::new(boot_dir.clone(), &runner).with_dry_run(args.dry_run);
    let result = executor.run_plan(&steps, MAX_STEPS_PER_RUN);

    // 5. Shutdown. Always attempt, even on failure.
    if let Err(e) = srv.shutdown(Duration::from_secs(2)) {
        eprintln!("llama-server shutdown error: {e}");
    }

    result.context("plan execution failed")?;
    eprintln!("OWLLM bootstrap complete.");
    Ok(())
}

fn main() {
    match run() {
        Ok(()) => std::process::exit(0),
        Err(e) => {
            eprintln!("FATAL: {e:#}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_dir_honors_env_override() {
        std::env::set_var("LOCALLLM_BOOTSTRAP_DIR", "C:\\custom\\path");
        let d = bootstrap_dir();
        assert_eq!(d, PathBuf::from("C:\\custom\\path"));
        std::env::remove_var("LOCALLLM_BOOTSTRAP_DIR");
    }

    #[test]
    fn load_recipe_summary_returns_braces_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let summary = load_recipe_summary(tmp.path());
        // No file in the tempdir → fallback "{}".
        assert_eq!(summary, "{}");
    }

    #[test]
    fn llama_server_name_is_platform_aware() {
        let name = llama_server_name();
        if cfg!(windows) {
            assert_eq!(name, "llama-server.exe");
        } else {
            assert_eq!(name, "llama-server");
        }
    }
}

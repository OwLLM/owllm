//! Action dispatcher — the heart of the executor.
//!
//! Port of `bootstrap_go/exec/stubs.go`, but Phase R2 only has the
//! simple actions wired up:
//!
//!   * create_venv  (real)
//!   * set_env      (real)
//!   * ask_user     (real)
//!   * uninstall_pkg (real)
//!   * abort        (real, terminal)
//!
//! Actions still pending (lit-up in R3-R4):
//!   * install_pkg, download_file, swap_wheel, pick_profile
//!
//! State that survives across steps (currently the active venv) lives
//! on `Executor` so later actions can reference what earlier ones
//! produced.

use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;

use crate::exec::{
    ask_user::{ask_user, AskUserOpts},
    create_venv::{create_venv, CreateVenvOpts},
    set_env::{set_env, SetEnvOpts},
    uninstall_pkg::{uninstall_pkg, UninstallPkgOpts},
};
use crate::plan::Step;
use crate::runner::Runner;

pub struct Executor<'a> {
    pub dry_run: bool,
    pub boot_dir: PathBuf,
    pub runner: &'a dyn Runner,

    // State carried across steps in a single plan run.
    active_venv: PathBuf,
}

impl<'a> Executor<'a> {
    pub fn new(boot_dir: PathBuf, runner: &'a dyn Runner) -> Self {
        Self {
            dry_run: false,
            boot_dir,
            runner,
            active_venv: PathBuf::new(),
        }
    }

    pub fn with_dry_run(mut self, dry: bool) -> Self {
        self.dry_run = dry;
        self
    }

    /// Currently-active venv (set after a successful `create_venv`).
    pub fn active_venv(&self) -> &std::path::Path {
        &self.active_venv
    }

    /// Walk `steps` sequentially. Returns the first executor error,
    /// with the step index pinned to the message so the caller can
    /// match it back to the model's plan.
    pub fn run_plan(&mut self, steps: &[Step], max_steps: usize) -> Result<()> {
        if steps.len() > max_steps {
            return Err(anyhow!(
                "plan has {} steps; cap is {} — refusing",
                steps.len(),
                max_steps
            ));
        }
        for (i, step) in steps.iter().enumerate() {
            eprintln!(
                "[{}/{}] {} {}",
                i + 1,
                steps.len(),
                step.action,
                step.args
            );
            if self.dry_run {
                eprintln!("  (dry-run) skipping execution");
                continue;
            }
            self.dispatch(step)
                .with_context(|| format!("step {} ({}) failed", i + 1, step.action))?;
        }
        Ok(())
    }

    pub fn dispatch(&mut self, step: &Step) -> Result<()> {
        match step.action.as_str() {
            "create_venv" => {
                let path = create_venv(
                    &CreateVenvOpts {
                        boot_dir: self.boot_dir.clone(),
                        runner: self.runner,
                    },
                    step,
                )?;
                self.active_venv = path;
                Ok(())
            }
            "set_env" => set_env(
                &SetEnvOpts {
                    boot_dir: self.boot_dir.clone(),
                },
                step,
            ),
            "ask_user" => ask_user(
                &AskUserOpts {
                    boot_dir: self.boot_dir.clone(),
                },
                step,
            ),
            "uninstall_pkg" => uninstall_pkg(
                &UninstallPkgOpts {
                    venv_dir: self.active_venv.clone(),
                    runner: self.runner,
                },
                step,
            ),
            "abort" => Err(anyhow!("model requested abort: {}", step.reason)),
            // R3-R4 actions land below this comment as they get ported.
            "install_pkg" | "download_file" | "swap_wheel" | "pick_profile" => Err(anyhow!(
                "action {:?} not yet ported to bootstrap_rs (still in bootstrap_go)",
                step.action
            )),
            other => Err(anyhow!("unknown action {:?}", other)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::create_venv::fabricate_venv_shell;
    use crate::runner::FakeRunner;
    use serde_json::json;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn create_venv_then_uninstall_threads_active_venv() {
        let tmp = tempdir().unwrap();
        let venv_path = tmp.path().join("venv");

        let fake_py = tmp.path().join("fakepython.exe");
        fs::write(&fake_py, "").unwrap();
        std::env::set_var("LOCALLLM_HOST_PYTHON", &fake_py);

        // Need the runner to fabricate the venv shell after the
        // create_venv subprocess call, then accept the pip
        // uninstall call.
        struct FabricatingRunner<'a> {
            inner: FakeRunner,
            venv: &'a std::path::Path,
        }
        impl<'a> Runner for FabricatingRunner<'a> {
            fn run(
                &self,
                t: std::time::Duration,
                bin: &str,
                args: &[&str],
            ) -> Result<()> {
                self.inner.run(t, bin, args)?;
                // First call (python -m venv) is the one that should
                // make the shell appear.
                if args.contains(&"venv") && !self.venv.join("pyvenv.cfg").exists() {
                    fabricate_venv_shell(self.venv);
                }
                Ok(())
            }
        }
        let runner = FabricatingRunner {
            inner: FakeRunner::new(),
            venv: &venv_path,
        };

        let mut exec = Executor::new(tmp.path().to_path_buf(), &runner);
        let steps = vec![
            Step {
                action: "create_venv".into(),
                args: json!({ "path": venv_path.to_string_lossy() }),
                reason: String::new(),
                fallback: None,
            },
            Step {
                action: "uninstall_pkg".into(),
                args: json!({ "name": "torch==2.5.1+cu121" }),
                reason: String::new(),
                fallback: None,
            },
        ];
        exec.run_plan(&steps, 32).expect("plan should succeed");

        // active_venv should have been set, and the uninstall_pkg
        // call's python.exe path lives inside it.
        assert!(exec.active_venv().ends_with("venv"));
        let calls = runner.inner.captured();
        assert_eq!(calls.len(), 2);
        // 2nd call is pip uninstall, whose binary must be inside the venv.
        let pip_bin = &calls[1].bin;
        assert!(
            pip_bin.contains("venv"),
            "uninstall binary should be inside venv: {pip_bin}"
        );
        std::env::remove_var("LOCALLLM_HOST_PYTHON");
    }

    #[test]
    fn abort_is_terminal() {
        let runner = FakeRunner::new();
        let mut exec = Executor::new(PathBuf::from("/tmp"), &runner);
        let err = exec
            .run_plan(
                &[Step::new("abort").with_reason("model said stop")],
                32,
            )
            .unwrap_err();
        // run_plan wraps each step error with "step N (action) failed";
        // {:#} walks the chain so we see the inner abort message.
        let chain = format!("{err:#}");
        assert!(chain.contains("model requested abort"), "got: {chain}");
    }

    #[test]
    fn unknown_action_fails() {
        let runner = FakeRunner::new();
        let mut exec = Executor::new(PathBuf::from("/tmp"), &runner);
        let err = exec
            .run_plan(&[Step::new("wat")], 32)
            .unwrap_err();
        let chain = format!("{err:#}");
        assert!(chain.contains("unknown action"), "got: {chain}");
    }

    #[test]
    fn step_cap_enforced() {
        let runner = FakeRunner::new();
        let mut exec = Executor::new(PathBuf::from("/tmp"), &runner);
        let many: Vec<Step> = (0..50)
            .map(|_| Step {
                action: "abort".into(),
                args: json!({}),
                reason: String::new(),
                fallback: None,
            })
            .collect();
        let err = exec.run_plan(&many, 32).unwrap_err();
        assert!(err.to_string().contains("refusing"));
    }

    #[test]
    fn dry_run_skips_all_dispatch() {
        let runner = FakeRunner::new();
        let mut exec = Executor::new(PathBuf::from("/tmp"), &runner).with_dry_run(true);
        // Even abort doesn't fire in dry-run mode.
        exec.run_plan(
            &[
                Step {
                    action: "abort".into(),
                    args: json!({}),
                    reason: String::new(),
                    fallback: None,
                },
                Step {
                    action: "uninstall_pkg".into(),
                    args: json!({}),
                    reason: String::new(),
                    fallback: None,
                },
            ],
            32,
        )
        .expect("dry-run succeeds even with normally-failing steps");
        assert_eq!(runner.captured().len(), 0);
    }
}

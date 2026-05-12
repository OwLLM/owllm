//! Action dispatcher — the heart of the executor.
//!
//! Port of `bootstrap_go/exec/stubs.go`. After R3 all 8 actions plus
//! `abort` and `pick_profile` (with its recursion guard) are wired.
//!
//! State that survives across steps:
//!   * `active_venv` — set after `create_venv`, read by `install_pkg`,
//!     `uninstall_pkg`, and `swap_wheel`.
//!   * `profiles` — lazily loaded on first `pick_profile`.
//!   * `expanding_profile` — recursion guard so a profile whose
//!     steps include another `pick_profile` fails loudly instead of
//!     looping.

use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;

use crate::args::arg_required;
use crate::exec::{
    ask_user::{ask_user, AskUserOpts},
    create_venv::{create_venv, CreateVenvOpts},
    download_file::{download_file, DownloadFileOpts, Fetcher, UreqFetcher},
    install_pkg::{install_pkg, InstallPkgOpts},
    set_env::{set_env, SetEnvOpts},
    swap_wheel::{swap_wheel, SwapWheelOpts},
    uninstall_pkg::{uninstall_pkg, UninstallPkgOpts},
};
use crate::plan::Step;
use crate::profile::{load_profile_table, ProfileTable};
use crate::runner::Runner;

pub struct Executor<'a> {
    pub dry_run: bool,
    pub boot_dir: PathBuf,
    pub runner: &'a dyn Runner,
    pub fetcher: &'a dyn Fetcher,

    // State carried across steps in a single plan run.
    active_venv: PathBuf,
    profiles: Option<ProfileTable>,
    expanding_profile: bool,
}

impl<'a> Executor<'a> {
    /// Production constructor. Defaults to `UreqFetcher` for HTTP;
    /// callers that want to inject a test fetcher use `with_fetcher`.
    pub fn new(boot_dir: PathBuf, runner: &'a dyn Runner) -> Executor<'a>
    where
        Self: 'a,
    {
        // SAFETY: a const default fetcher would be ideal, but
        // UreqFetcher has no state and can be referenced as a
        // 'static singleton.
        static UREQ: UreqFetcher = UreqFetcher;
        Self {
            dry_run: false,
            boot_dir,
            runner,
            fetcher: &UREQ,
            active_venv: PathBuf::new(),
            profiles: None,
            expanding_profile: false,
        }
    }

    pub fn with_fetcher(mut self, fetcher: &'a dyn Fetcher) -> Self {
        self.fetcher = fetcher;
        self
    }

    pub fn with_dry_run(mut self, dry: bool) -> Self {
        self.dry_run = dry;
        self
    }

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
            "install_pkg" => install_pkg(
                &InstallPkgOpts {
                    venv_dir: self.active_venv.clone(),
                    runner: self.runner,
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
            "swap_wheel" => swap_wheel(
                &SwapWheelOpts {
                    venv_dir: self.active_venv.clone(),
                    runner: self.runner,
                },
                step,
            ),
            "download_file" => download_file(
                &DownloadFileOpts {
                    fetcher: self.fetcher,
                },
                step,
            ),
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
            "pick_profile" => self.run_pick_profile(step),
            "abort" => Err(anyhow!("model requested abort: {}", step.reason)),
            other => Err(anyhow!("unknown action {:?}", other)),
        }
    }

    /// Load (lazily, once per Executor) the profile table, look up
    /// the requested id, and dispatch each of the profile's steps
    /// inline through this same Executor so they share venv state.
    fn run_pick_profile(&mut self, step: &Step) -> Result<()> {
        if self.expanding_profile {
            return Err(anyhow!("pick_profile inside pick_profile is not allowed"));
        }
        let id = arg_required(&step.args, "profile_id").context("pick_profile")?;

        if self.profiles.is_none() {
            let table = load_profile_table(&self.boot_dir).context("pick_profile")?;
            self.profiles = Some(table);
        }

        // We can't hold a borrow into `self.profiles` while also
        // mutably calling `self.dispatch` further down — clone the
        // sub-steps out so the borrow is short-lived.
        let (substeps, profile_id, profile_desc) = {
            let table = self.profiles.as_ref().expect("just loaded");
            let known: Vec<String> = table.profiles.iter().map(|p| p.id.clone()).collect();
            let profile = table.find_profile(&id).ok_or_else(|| {
                anyhow!(
                    "pick_profile: unknown profile id {id:?} (known: {known:?})"
                )
            })?;
            (
                profile.steps.clone(),
                profile.id.clone(),
                profile.description.clone(),
            )
        };

        eprintln!(
            "  pick_profile: {profile_id} — {profile_desc} ({} steps)",
            substeps.len()
        );

        self.expanding_profile = true;
        let result = (|| {
            for (i, sub) in substeps.iter().enumerate() {
                eprintln!(
                    "    [{profile_id}/{}] {} {}",
                    i + 1,
                    sub.action,
                    sub.args
                );
                if self.dry_run {
                    eprintln!("      (dry-run) skipping execution");
                    continue;
                }
                self.dispatch(sub).with_context(|| {
                    format!(
                        "pick_profile {profile_id}: sub-step {} ({}) failed",
                        i + 1,
                        sub.action
                    )
                })?;
            }
            Ok(())
        })();
        self.expanding_profile = false;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::create_venv::fabricate_venv_shell;
    use crate::exec::download_file::Fetcher;
    use crate::runner::FakeRunner;
    use serde_json::json;
    use std::fs;
    use std::sync::Mutex;
    use tempfile::tempdir;

    struct NoopFetcher;
    impl Fetcher for NoopFetcher {
        fn fetch(&self, _url: &str) -> Result<(u16, Vec<u8>)> {
            Err(anyhow!("no fetcher configured for this test"))
        }
    }

    fn write_profiles(boot_dir: &std::path::Path, body: &str) {
        let recipes = boot_dir.join("recipes");
        fs::create_dir_all(&recipes).unwrap();
        fs::write(recipes.join("hardware_profiles.json"), body).unwrap();
    }

    #[test]
    fn create_venv_then_install_threads_active_venv() {
        let tmp = tempdir().unwrap();
        let venv_path = tmp.path().join("venv");
        let fake_py = tmp.path().join("fakepython.exe");
        fs::write(&fake_py, "").unwrap();
        std::env::set_var("LOCALLLM_HOST_PYTHON", &fake_py);

        // Wrap FakeRunner so the create_venv call also fabricates
        // the post-creation venv shell (pyvenv.cfg + python.exe).
        struct FabricatingRunner<'a> {
            inner: FakeRunner,
            venv: &'a std::path::Path,
            done: Mutex<bool>,
        }
        impl<'a> Runner for FabricatingRunner<'a> {
            fn run(
                &self,
                t: std::time::Duration,
                bin: &str,
                args: &[&str],
            ) -> Result<()> {
                self.inner.run(t, bin, args)?;
                if args.contains(&"venv") {
                    let mut d = self.done.lock().unwrap();
                    if !*d {
                        fabricate_venv_shell(self.venv);
                        *d = true;
                    }
                }
                Ok(())
            }
        }
        let runner = FabricatingRunner {
            inner: FakeRunner::new(),
            venv: &venv_path,
            done: Mutex::new(false),
        };
        let fetcher = NoopFetcher;

        let mut exec = Executor::new(tmp.path().to_path_buf(), &runner)
            .with_fetcher(&fetcher);
        let steps = vec![
            Step::new("create_venv")
                .with_args(json!({ "path": venv_path.to_string_lossy() })),
            Step::new("install_pkg")
                .with_args(json!({ "name": "requests", "version": "2.31.0" })),
        ];
        exec.run_plan(&steps, 32).expect("plan should succeed");
        assert_eq!(exec.active_venv(), venv_path);

        let calls = runner.inner.captured();
        assert_eq!(calls.len(), 2);
        // 2nd call is pip install — binary path must be inside the venv.
        assert!(
            calls[1].bin.contains("venv"),
            "install binary should live inside venv: {}",
            calls[1].bin
        );
        // …and the spec is the build_pip_spec output we expect.
        assert_eq!(*calls[1].args.last().unwrap(), "requests==2.31.0");
        std::env::remove_var("LOCALLLM_HOST_PYTHON");
    }

    #[test]
    fn pick_profile_dry_run_walks_substeps() {
        let tmp = tempdir().unwrap();
        write_profiles(
            tmp.path(),
            r#"{
                "version": 1,
                "profiles": [
                    {"id": "p1", "description": "x", "match": {},
                     "steps": [
                        {"action": "create_venv", "args": {"python_version": "3.11"}},
                        {"action": "install_pkg", "args": {"name": "torch"}}
                     ]}
                ]
            }"#,
        );
        let runner = FakeRunner::new();
        let fetcher = NoopFetcher;
        let mut exec = Executor::new(tmp.path().to_path_buf(), &runner)
            .with_fetcher(&fetcher)
            .with_dry_run(true);
        exec.dispatch(
            &Step::new("pick_profile").with_args(json!({ "profile_id": "p1" })),
        )
        .expect("dry-run should succeed");
        // Dry-run skips every sub-dispatch.
        assert_eq!(runner.captured().len(), 0);
    }

    #[test]
    fn pick_profile_unknown_id_fails() {
        let tmp = tempdir().unwrap();
        write_profiles(
            tmp.path(),
            r#"{"version":1,"profiles":[{"id":"p1","description":"","match":{},"steps":[]}]}"#,
        );
        let runner = FakeRunner::new();
        let fetcher = NoopFetcher;
        let mut exec = Executor::new(tmp.path().to_path_buf(), &runner)
            .with_fetcher(&fetcher)
            .with_dry_run(true);
        let err = exec
            .dispatch(
                &Step::new("pick_profile").with_args(json!({ "profile_id": "nope" })),
            )
            .unwrap_err();
        assert!(err.to_string().contains("unknown profile id"));
    }

    #[test]
    fn pick_profile_missing_id_fails() {
        let tmp = tempdir().unwrap();
        write_profiles(
            tmp.path(),
            r#"{"version":1,"profiles":[]}"#,
        );
        let runner = FakeRunner::new();
        let fetcher = NoopFetcher;
        let mut exec = Executor::new(tmp.path().to_path_buf(), &runner)
            .with_fetcher(&fetcher)
            .with_dry_run(true);
        let err = exec
            .dispatch(&Step::new("pick_profile"))
            .unwrap_err();
        let chain = format!("{err:#}");
        assert!(chain.contains("missing required arg"), "got: {chain}");
    }

    #[test]
    fn pick_profile_recursion_guard_refuses_nested() {
        let tmp = tempdir().unwrap();
        write_profiles(
            tmp.path(),
            r#"{
                "version": 1,
                "profiles": [
                    {"id": "outer", "description": "", "match": {},
                     "steps": [{"action": "pick_profile", "args": {"profile_id": "inner"}}]},
                    {"id": "inner", "description": "", "match": {},
                     "steps": [{"action": "create_venv", "args": {"python_version": "3.11"}}]}
                ]
            }"#,
        );
        let runner = FakeRunner::new();
        let fetcher = NoopFetcher;
        // NOT dry-run — we want the inner dispatch to actually fire so
        // the guard triggers.
        let mut exec = Executor::new(tmp.path().to_path_buf(), &runner)
            .with_fetcher(&fetcher);
        let err = exec
            .dispatch(
                &Step::new("pick_profile").with_args(json!({ "profile_id": "outer" })),
            )
            .unwrap_err();
        let chain = format!("{err:#}");
        assert!(
            chain.contains("pick_profile inside pick_profile"),
            "got: {chain}"
        );
    }

    #[test]
    fn abort_is_terminal() {
        let runner = FakeRunner::new();
        let fetcher = NoopFetcher;
        let mut exec = Executor::new(PathBuf::from("/tmp"), &runner)
            .with_fetcher(&fetcher);
        let err = exec
            .run_plan(
                &[Step::new("abort").with_reason("model said stop")],
                32,
            )
            .unwrap_err();
        let chain = format!("{err:#}");
        assert!(chain.contains("model requested abort"), "got: {chain}");
    }

    #[test]
    fn unknown_action_fails() {
        let runner = FakeRunner::new();
        let fetcher = NoopFetcher;
        let mut exec = Executor::new(PathBuf::from("/tmp"), &runner)
            .with_fetcher(&fetcher);
        let err = exec
            .run_plan(&[Step::new("wat")], 32)
            .unwrap_err();
        let chain = format!("{err:#}");
        assert!(chain.contains("unknown action"), "got: {chain}");
    }

    #[test]
    fn step_cap_enforced() {
        let runner = FakeRunner::new();
        let fetcher = NoopFetcher;
        let mut exec = Executor::new(PathBuf::from("/tmp"), &runner)
            .with_fetcher(&fetcher);
        let many: Vec<Step> = (0..50).map(|_| Step::new("abort")).collect();
        let err = exec.run_plan(&many, 32).unwrap_err();
        assert!(err.to_string().contains("refusing"));
    }

    #[test]
    fn dry_run_skips_all_dispatch() {
        let runner = FakeRunner::new();
        let fetcher = NoopFetcher;
        let mut exec = Executor::new(PathBuf::from("/tmp"), &runner)
            .with_fetcher(&fetcher)
            .with_dry_run(true);
        exec.run_plan(
            &[Step::new("abort"), Step::new("uninstall_pkg")],
            32,
        )
        .expect("dry-run succeeds even with normally-failing steps");
        assert_eq!(runner.captured().len(), 0);
    }
}

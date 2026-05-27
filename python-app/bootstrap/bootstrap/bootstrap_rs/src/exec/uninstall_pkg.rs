//! `uninstall_pkg` — remove a package from the active venv.
//!
//! Port of `bootstrap_go/exec/uninstall_pkg.go`. Idempotent:
//! `pip uninstall --yes` exits 0 even when the package isn't
//! installed.

use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;
use std::time::Duration;

use crate::args::arg_required;
use crate::pkgname::stripped_package_name;
use crate::plan::Step;
use crate::python::python_exe_path;
use crate::runner::Runner;

pub struct UninstallPkgOpts<'a> {
    pub venv_dir: PathBuf,
    pub runner: &'a dyn Runner,
}

pub fn uninstall_pkg(opts: &UninstallPkgOpts<'_>, step: &Step) -> Result<()> {
    if opts.venv_dir.as_os_str().is_empty() {
        return Err(anyhow!(
            "uninstall_pkg: no venv configured (run create_venv first)"
        ));
    }
    let name = arg_required(&step.args, "name").context("uninstall_pkg")?;
    let bare = stripped_package_name(&name);
    let py = python_exe_path(&opts.venv_dir);
    let py_str = py.to_string_lossy();

    eprintln!("  uninstall_pkg: {bare}");
    let args = [
        "-m",
        "pip",
        "uninstall",
        "--yes",
        "--disable-pip-version-check",
        &bare,
    ];

    opts.runner
        .run(Duration::from_secs(120), &py_str, &args)
        .with_context(|| format!("uninstall_pkg: {bare} failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::FakeRunner;
    use serde_json::json;

    #[test]
    fn builds_expected_pip_command() {
        let runner = FakeRunner::new();
        let step = Step {
            action: "uninstall_pkg".into(),
            args: json!({ "name": "torch==2.5.1+cu121" }),
            reason: String::new(),
            fallback: None,
        };
        uninstall_pkg(
            &UninstallPkgOpts {
                venv_dir: PathBuf::from("/tmp/v"),
                runner: &runner,
            },
            &step,
        )
        .expect("clean fake runner shouldn't fail");
        let calls = runner.captured();
        assert_eq!(calls.len(), 1);
        // Version-stripping mirrors the Go test exactly.
        assert_eq!(
            calls[0].args,
            vec![
                "-m",
                "pip",
                "uninstall",
                "--yes",
                "--disable-pip-version-check",
                "torch",
            ]
        );
    }

    #[test]
    fn no_venv_fails() {
        let runner = FakeRunner::new();
        let step = Step {
            action: "uninstall_pkg".into(),
            args: json!({ "name": "torch" }),
            reason: String::new(),
            fallback: None,
        };
        let err = uninstall_pkg(
            &UninstallPkgOpts {
                venv_dir: PathBuf::new(),
                runner: &runner,
            },
            &step,
        )
        .unwrap_err();
        assert!(err.to_string().contains("no venv"));
    }

    #[test]
    fn missing_name_fails() {
        let runner = FakeRunner::new();
        let err = uninstall_pkg(
            &UninstallPkgOpts {
                venv_dir: PathBuf::from("/tmp/v"),
                runner: &runner,
            },
            &Step::new("uninstall_pkg"),
        )
        .unwrap_err();
        // anyhow::Error::to_string only shows the outer context;
        // {:#} walks the chain so we can see the inner
        // missing-required-arg failure that uninstall_pkg wraps.
        let chain = format!("{err:#}");
        assert!(
            chain.contains("missing required arg"),
            "unexpected: {chain}"
        );
    }

    #[test]
    fn runner_failure_propagates_with_context() {
        let runner = FakeRunner::failing("pip blew up");
        let err = uninstall_pkg(
            &UninstallPkgOpts {
                venv_dir: PathBuf::from("/tmp/v"),
                runner: &runner,
            },
            &Step {
                action: "uninstall_pkg".into(),
                args: json!({ "name": "torch" }),
                reason: String::new(),
                fallback: None,
            },
        )
        .unwrap_err();
        let s = format!("{err:#}");
        assert!(s.contains("uninstall_pkg"));
        assert!(s.contains("torch"));
        assert!(s.contains("pip blew up"), "unexpected: {s}");
    }
}

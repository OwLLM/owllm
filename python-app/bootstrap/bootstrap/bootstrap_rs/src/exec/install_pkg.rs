//! `install_pkg` — pip-install one package into the active venv.
//!
//! Port of `bootstrap_go/exec/install_pkg.go`. Builds the pip CLI
//! from (name, version, index, extras) and shells out via the
//! injected `Runner`.

use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;
use std::time::Duration;

use crate::args::{arg_required, arg_string, arg_string_slice};
use crate::pipspec::build_pip_spec;
use crate::plan::Step;
use crate::python::python_exe_path;
use crate::runner::Runner;

pub struct InstallPkgOpts<'a> {
    pub venv_dir: PathBuf,
    pub runner: &'a dyn Runner,
}

pub fn install_pkg(opts: &InstallPkgOpts<'_>, step: &Step) -> Result<()> {
    if opts.venv_dir.as_os_str().is_empty() {
        return Err(anyhow!(
            "install_pkg: no venv configured (run create_venv first)"
        ));
    }
    let name = arg_required(&step.args, "name").context("install_pkg")?;
    let version = arg_string(&step.args, "version").unwrap_or_default();
    let index = arg_string(&step.args, "index").unwrap_or_default();
    let extras = arg_string_slice(&step.args, "extras").unwrap_or_default();

    let spec = build_pip_spec(&name, &version, &extras);
    let py = python_exe_path(&opts.venv_dir);
    let py_str = py.to_string_lossy();

    eprintln!("  install_pkg: {spec} -> {py_str}");

    // Build the arg vector. Using a Vec because the optional
    // --index-url pair makes a fixed-size array awkward.
    let mut argv: Vec<&str> = vec![
        "-m",
        "pip",
        "install",
        "--no-input",
        "--disable-pip-version-check",
        &spec,
    ];
    if !index.is_empty() {
        argv.push("--index-url");
        argv.push(&index);
    }

    opts.runner
        .run(Duration::from_secs(600), &py_str, &argv)
        .with_context(|| format!("install_pkg: pip install {spec} failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::FakeRunner;
    use serde_json::json;

    #[test]
    fn builds_expected_pip_command() {
        let runner = FakeRunner::new();
        let step = Step::new("install_pkg").with_args(json!({
            "name": "torch",
            "version": "2.5.1+cu121",
            "index": "https://download.pytorch.org/whl/cu121",
        }));
        install_pkg(
            &InstallPkgOpts {
                venv_dir: PathBuf::from("/tmp/venv"),
                runner: &runner,
            },
            &step,
        )
        .expect("clean fake should succeed");
        let calls = runner.captured();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].args,
            vec![
                "-m",
                "pip",
                "install",
                "--no-input",
                "--disable-pip-version-check",
                "torch==2.5.1+cu121",
                "--index-url",
                "https://download.pytorch.org/whl/cu121",
            ]
        );
    }

    #[test]
    fn omits_index_when_not_given() {
        let runner = FakeRunner::new();
        let step = Step::new("install_pkg").with_args(json!({
            "name": "requests",
            "version": "2.31.0",
        }));
        install_pkg(
            &InstallPkgOpts {
                venv_dir: PathBuf::from("/tmp/venv"),
                runner: &runner,
            },
            &step,
        )
        .unwrap();
        let calls = runner.captured();
        assert!(!calls[0].args.iter().any(|a| a == "--index-url"));
        assert_eq!(calls[0].args.last().unwrap(), "requests==2.31.0");
    }

    #[test]
    fn forwards_extras_through_pip_spec() {
        let runner = FakeRunner::new();
        let step = Step::new("install_pkg").with_args(json!({
            "name": "foo",
            "version": "1.0",
            "extras": ["dev", "test"],
        }));
        install_pkg(
            &InstallPkgOpts {
                venv_dir: PathBuf::from("/tmp/venv"),
                runner: &runner,
            },
            &step,
        )
        .unwrap();
        assert_eq!(runner.captured()[0].args.last().unwrap(), "foo[dev,test]==1.0");
    }

    #[test]
    fn no_venv_fails() {
        let runner = FakeRunner::new();
        let err = install_pkg(
            &InstallPkgOpts {
                venv_dir: PathBuf::new(),
                runner: &runner,
            },
            &Step::new("install_pkg").with_args(json!({ "name": "torch" })),
        )
        .unwrap_err();
        assert!(err.to_string().contains("no venv"));
    }

    #[test]
    fn missing_name_fails() {
        let runner = FakeRunner::new();
        let err = install_pkg(
            &InstallPkgOpts {
                venv_dir: PathBuf::from("/tmp/v"),
                runner: &runner,
            },
            &Step::new("install_pkg"),
        )
        .unwrap_err();
        let chain = format!("{err:#}");
        assert!(chain.contains("missing required arg"), "got: {chain}");
    }

    #[test]
    fn runner_failure_propagates() {
        let runner = FakeRunner::failing("pip exploded");
        let err = install_pkg(
            &InstallPkgOpts {
                venv_dir: PathBuf::from("/tmp/v"),
                runner: &runner,
            },
            &Step::new("install_pkg").with_args(json!({ "name": "torch" })),
        )
        .unwrap_err();
        let chain = format!("{err:#}");
        assert!(chain.contains("pip exploded"), "got: {chain}");
    }
}

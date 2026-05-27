//! `swap_wheel` — replace an installed package with a different
//! version (uninstall + install at target version).
//!
//! Port of `bootstrap_go/exec/swap_wheel.go`. This is what the model
//! emits when the rule-based path picked the wrong wheel for the
//! user's hardware (e.g. profile shipped torch+cu121 but the GPU
//! only supports CUDA 11.8). Both pip invocations run in the active
//! venv; uninstall is `--yes` so it no-ops cleanly when the package
//! isn't installed.

use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;
use std::time::Duration;

use crate::args::{arg_required, arg_string, arg_string_slice};
use crate::pipspec::build_pip_spec;
use crate::pkgname::stripped_package_name;
use crate::plan::Step;
use crate::python::python_exe_path;
use crate::runner::Runner;

pub struct SwapWheelOpts<'a> {
    pub venv_dir: PathBuf,
    pub runner: &'a dyn Runner,
}

pub fn swap_wheel(opts: &SwapWheelOpts<'_>, step: &Step) -> Result<()> {
    if opts.venv_dir.as_os_str().is_empty() {
        return Err(anyhow!(
            "swap_wheel: no venv configured (run create_venv first)"
        ));
    }
    let name = arg_required(&step.args, "name").context("swap_wheel")?;
    let to_version = arg_required(&step.args, "to_version").context("swap_wheel")?;
    let from_version = arg_string(&step.args, "from_version").unwrap_or_default();
    let index = arg_string(&step.args, "index").unwrap_or_default();
    let extras = arg_string_slice(&step.args, "extras").unwrap_or_default();

    let py = python_exe_path(&opts.venv_dir);
    let py_str = py.to_string_lossy();

    if from_version.is_empty() {
        eprintln!("  swap_wheel: {name} -> {to_version}");
    } else {
        eprintln!("  swap_wheel: {name} {from_version} -> {to_version}");
    }

    // 1. Uninstall the bare distribution. pip exits 0 for "not
    //    installed" when --yes is set, so no special-case needed.
    let bare = stripped_package_name(&name);
    let uninstall_args = [
        "-m",
        "pip",
        "uninstall",
        "--yes",
        "--disable-pip-version-check",
        &bare,
    ];
    opts.runner
        .run(Duration::from_secs(120), &py_str, &uninstall_args)
        .with_context(|| format!("swap_wheel: uninstall {bare} failed"))?;

    // 2. Install at the target version. Reuse build_pip_spec so the
    //    on-wire format matches install_pkg exactly.
    let spec = build_pip_spec(&name, &to_version, &extras);
    let mut install_args: Vec<&str> = vec![
        "-m",
        "pip",
        "install",
        "--no-input",
        "--disable-pip-version-check",
        &spec,
    ];
    if !index.is_empty() {
        install_args.push("--index-url");
        install_args.push(&index);
    }
    opts.runner
        .run(Duration::from_secs(600), &py_str, &install_args)
        .with_context(|| format!("swap_wheel: install {spec} failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::FakeRunner;
    use serde_json::json;

    #[test]
    fn runs_uninstall_then_install() {
        let runner = FakeRunner::new();
        let step = Step::new("swap_wheel").with_args(json!({
            "name":         "torch",
            "from_version": "2.5.1+cu121",
            "to_version":   "2.4.1+cu118",
            "index":        "https://download.pytorch.org/whl/cu118",
        }));
        swap_wheel(
            &SwapWheelOpts {
                venv_dir: PathBuf::from("/tmp/v"),
                runner: &runner,
            },
            &step,
        )
        .expect("clean run should succeed");
        let calls = runner.captured();
        assert_eq!(calls.len(), 2, "expected uninstall + install");

        // First call: uninstall <bare>
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

        // Second call: install at target version + custom index.
        assert_eq!(
            calls[1].args,
            vec![
                "-m",
                "pip",
                "install",
                "--no-input",
                "--disable-pip-version-check",
                "torch==2.4.1+cu118",
                "--index-url",
                "https://download.pytorch.org/whl/cu118",
            ]
        );
    }

    #[test]
    fn strips_version_from_uninstall_target() {
        // Model emits "torch==2.5.1+cu121" as name; pip uninstall
        // still gets the bare "torch".
        let runner = FakeRunner::new();
        let step = Step::new("swap_wheel").with_args(json!({
            "name": "torch==2.5.1+cu121",
            "to_version": "2.4.1+cu118",
        }));
        swap_wheel(
            &SwapWheelOpts {
                venv_dir: PathBuf::from("/tmp/v"),
                runner: &runner,
            },
            &step,
        )
        .unwrap();
        let calls = runner.captured();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].args.last().unwrap(), "torch");
        // And install passes the inline-version name through verbatim
        // (build_pip_spec sees the marker and short-circuits).
        assert_eq!(calls[1].args[5], "torch==2.5.1+cu121");
    }

    #[test]
    fn no_venv_fails() {
        let runner = FakeRunner::new();
        let err = swap_wheel(
            &SwapWheelOpts {
                venv_dir: PathBuf::new(),
                runner: &runner,
            },
            &Step::new("swap_wheel").with_args(json!({
                "name": "x", "to_version": "1",
            })),
        )
        .unwrap_err();
        assert!(err.to_string().contains("no venv"));
    }

    #[test]
    fn missing_name_fails() {
        let runner = FakeRunner::new();
        let err = swap_wheel(
            &SwapWheelOpts {
                venv_dir: PathBuf::from("/tmp/v"),
                runner: &runner,
            },
            &Step::new("swap_wheel").with_args(json!({ "to_version": "1" })),
        )
        .unwrap_err();
        let chain = format!("{err:#}");
        assert!(chain.contains("missing required arg"), "got: {chain}");
    }

    #[test]
    fn missing_to_version_fails() {
        let runner = FakeRunner::new();
        let err = swap_wheel(
            &SwapWheelOpts {
                venv_dir: PathBuf::from("/tmp/v"),
                runner: &runner,
            },
            &Step::new("swap_wheel").with_args(json!({ "name": "torch" })),
        )
        .unwrap_err();
        let chain = format!("{err:#}");
        assert!(chain.contains("missing required arg"), "got: {chain}");
    }
}

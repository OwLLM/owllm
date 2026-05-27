//! `create_venv` — build a Python venv at the configured target path.
//!
//! Port of `bootstrap_go/exec/create_venv.go`. Idempotent: existing
//! venv is a no-op success. Refuses to clobber non-venv content.

use anyhow::{anyhow, Context, Result};
use std::fs;
use std::path::PathBuf;
#[cfg(test)]
use std::path::Path;
use std::time::Duration;

use crate::args::arg_string;
use crate::plan::Step;
use crate::python::{find_host_python, is_existing_venv};
use crate::runner::Runner;

pub struct CreateVenvOpts<'a> {
    pub boot_dir: PathBuf,
    pub runner: &'a dyn Runner,
}

/// Run `python -m venv <path>`. Returns the path created (or
/// pre-existing).
pub fn create_venv(opts: &CreateVenvOpts<'_>, step: &Step) -> Result<PathBuf> {
    let target: PathBuf = match arg_string(&step.args, "path") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => opts.boot_dir.join("venv"),
    };
    let python_ver = arg_string(&step.args, "python_version").unwrap_or_default();

    // Idempotence: bail out cleanly if already a venv.
    if is_existing_venv(&target) {
        eprintln!(
            "  create_venv: {} already a venv — skipping",
            target.display()
        );
        return Ok(target);
    }

    // Refuse to clobber a non-venv directory.
    if target.exists() {
        let non_empty = fs::read_dir(&target)
            .map(|mut it| it.next().is_some())
            .unwrap_or(false);
        if non_empty {
            return Err(anyhow!(
                "create_venv: {} exists and is not a venv (refusing to clobber non-venv content)",
                target.display()
            ));
        }
    }

    let py = find_host_python(&opts.boot_dir).context("create_venv")?;
    eprintln!(
        "  create_venv: using {} (requested version={:?}) -> {}",
        py.display(),
        python_ver,
        target.display()
    );

    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).context("create_venv: mkdir parent")?;
        }
    }

    let py_str = py.to_string_lossy();
    let target_str = target.to_string_lossy();
    opts.runner
        .run(
            Duration::from_secs(120),
            &py_str,
            &["-m", "venv", &target_str],
        )
        .context("create_venv: python -m venv failed")?;

    if !is_existing_venv(&target) {
        return Err(anyhow!(
            "create_venv: post-creation check failed at {}",
            target.display()
        ));
    }
    Ok(target)
}

/// Helper for tests: fabricate a "venv shell" at `path` so subsequent
/// idempotence checks succeed. Mirrors how the Go test setup creates
/// `pyvenv.cfg` + `Scripts/python.exe` (or `bin/python`).
#[cfg(test)]
pub(crate) fn fabricate_venv_shell(path: &Path) {
    let py = crate::python::python_exe_path(path);
    if let Some(parent) = py.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path.join("pyvenv.cfg"), "").unwrap();
    fs::write(&py, "").unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::FakeRunner;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn existing_venv_is_noop() {
        let tmp = tempdir().unwrap();
        let target = tmp.path().join("v");
        fabricate_venv_shell(&target);

        let runner = FakeRunner::new();
        let got = create_venv(
            &CreateVenvOpts {
                boot_dir: tmp.path().to_path_buf(),
                runner: &runner,
            },
            &Step {
                action: "create_venv".into(),
                args: json!({ "path": target.to_string_lossy() }),
                reason: String::new(),
                fallback: None,
            },
        )
        .expect("idempotent path");
        assert_eq!(got, target);
        // No subprocess call should have been made.
        assert_eq!(runner.captured().len(), 0);
    }

    #[test]
    fn refuses_to_clobber_non_venv() {
        let tmp = tempdir().unwrap();
        let target = tmp.path().join("v");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("important.txt"), "do not delete").unwrap();

        let runner = FakeRunner::new();
        let err = create_venv(
            &CreateVenvOpts {
                boot_dir: tmp.path().to_path_buf(),
                runner: &runner,
            },
            &Step {
                action: "create_venv".into(),
                args: json!({ "path": target.to_string_lossy() }),
                reason: String::new(),
                fallback: None,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("not a venv"), "got: {err}");
    }

    #[test]
    fn calls_python_minus_m_venv_on_fresh_target() {
        let tmp = tempdir().unwrap();
        let target = tmp.path().join("v");

        // Fake interpreter so find_host_python's env override succeeds.
        let fake_py = tmp.path().join("fakepython.exe");
        fs::write(&fake_py, "").unwrap();
        std::env::set_var("LOCALLLM_HOST_PYTHON", &fake_py);

        // FakeRunner has to additionally fabricate the post-creation
        // venv files because the real `python -m venv` would do that;
        // wrap it so the side-effect happens.
        struct FabricatingRunner<'a> {
            inner: FakeRunner,
            venv: &'a Path,
        }
        impl<'a> Runner for FabricatingRunner<'a> {
            fn run(&self, t: Duration, bin: &str, args: &[&str]) -> Result<()> {
                self.inner.run(t, bin, args)?;
                // Reproduce side effect of a successful venv build.
                fabricate_venv_shell(self.venv);
                Ok(())
            }
        }
        let runner = FabricatingRunner {
            inner: FakeRunner::new(),
            venv: &target,
        };

        let got = create_venv(
            &CreateVenvOpts {
                boot_dir: tmp.path().to_path_buf(),
                runner: &runner,
            },
            &Step {
                action: "create_venv".into(),
                args: json!({ "path": target.to_string_lossy() }),
                reason: String::new(),
                fallback: None,
            },
        )
        .expect("should build venv");
        assert_eq!(got, target);

        let calls = runner.inner.captured();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].args[0], "-m");
        assert_eq!(calls[0].args[1], "venv");
        assert!(calls[0].args[2].ends_with("v") || calls[0].args[2].contains("v"));

        std::env::remove_var("LOCALLLM_HOST_PYTHON");
    }

    #[test]
    fn default_path_is_boot_dir_slash_venv() {
        let tmp = tempdir().unwrap();
        let target = tmp.path().join("venv");

        let fake_py = tmp.path().join("fakepython.exe");
        fs::write(&fake_py, "").unwrap();
        std::env::set_var("LOCALLLM_HOST_PYTHON", &fake_py);

        struct FabricatingRunner<'a> {
            inner: FakeRunner,
            venv: &'a Path,
        }
        impl<'a> Runner for FabricatingRunner<'a> {
            fn run(&self, t: Duration, bin: &str, args: &[&str]) -> Result<()> {
                self.inner.run(t, bin, args)?;
                fabricate_venv_shell(self.venv);
                Ok(())
            }
        }
        let runner = FabricatingRunner {
            inner: FakeRunner::new(),
            venv: &target,
        };

        let got = create_venv(
            &CreateVenvOpts {
                boot_dir: tmp.path().to_path_buf(),
                runner: &runner,
            },
            &Step {
                action: "create_venv".into(),
                args: json!({}),
                reason: String::new(),
                fallback: None,
            },
        )
        .expect("default path");
        assert_eq!(got, target);
        std::env::remove_var("LOCALLLM_HOST_PYTHON");
    }
}

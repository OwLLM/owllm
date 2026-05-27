//! Python interpreter discovery + venv path helpers. Mirrors the
//! `PythonExePath`, `IsExistingVenv`, and `findHostPython` helpers in
//! `bootstrap_go/exec/create_venv.go`.

use anyhow::{anyhow, Result};
use std::env;
use std::path::{Path, PathBuf};

/// Returns the in-venv python executable path. Windows uses
/// `<venv>/Scripts/python.exe`; everything else uses
/// `<venv>/bin/python`.
pub fn python_exe_path(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// True iff `path` looks like an already-built venv (has both
/// `pyvenv.cfg` and the in-venv python executable).
pub fn is_existing_venv(path: &Path) -> bool {
    if path.as_os_str().is_empty() {
        return false;
    }
    path.join("pyvenv.cfg").exists() && python_exe_path(path).exists()
}

/// Discover a python interpreter for venv creation. Priority order
/// matches the Go side:
///
/// 1. `$LOCALLLM_HOST_PYTHON` environment override (highest).
/// 2. Bundled `<bootDir>/../python_runtime/python3.11/python.exe`.
/// 3. `python` or `python3` on PATH (last resort).
pub fn find_host_python(boot_dir: &Path) -> Result<PathBuf> {
    if let Ok(v) = env::var("LOCALLLM_HOST_PYTHON") {
        if !v.is_empty() {
            let p = PathBuf::from(&v);
            if p.exists() {
                return Ok(p);
            }
        }
    }

    // Bundled runtime: <bootstrap>/../python_runtime/python3.11/...
    let bundled = boot_dir
        .parent()
        .unwrap_or(boot_dir)
        .join("python_runtime")
        .join("python3.11");
    let candidates = [bundled.join("python.exe"), bundled.join("python")];
    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }

    // PATH lookup.
    for name in ["python", "python3"] {
        if let Some(p) = which_on_path(name) {
            return Ok(p);
        }
    }

    Err(anyhow!(
        "no python interpreter found (set LOCALLLM_HOST_PYTHON)"
    ))
}

/// Tiny `which` — walks the `PATH` env var looking for `name` (with
/// or without `.exe`/`.bat` on Windows). Avoids pulling in the
/// `which` crate for one function.
fn which_on_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    let extensions: &[&str] = if cfg!(windows) {
        &["", ".exe", ".bat", ".cmd"]
    } else {
        &[""]
    };
    for dir in env::split_paths(&path) {
        for ext in extensions {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn python_exe_path_is_platform_specific() {
        let venv = Path::new("/some/venv");
        let p = python_exe_path(venv);
        if cfg!(windows) {
            assert!(p.ends_with("Scripts\\python.exe") || p.ends_with("Scripts/python.exe"));
        } else {
            assert!(p.ends_with("bin/python"));
        }
    }

    #[test]
    fn is_existing_venv_requires_both_files() {
        let tmp = tempdir().unwrap();
        let venv = tmp.path();
        assert!(!is_existing_venv(venv), "empty dir is not a venv");

        // pyvenv.cfg alone isn't enough.
        fs::write(venv.join("pyvenv.cfg"), "").unwrap();
        assert!(!is_existing_venv(venv));

        // Create the in-venv python; now it counts as a venv.
        let py = python_exe_path(venv);
        if let Some(parent) = py.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&py, "").unwrap();
        assert!(is_existing_venv(venv));
    }

    #[test]
    fn host_python_env_override_wins() {
        let tmp = tempdir().unwrap();
        let fake_py = tmp.path().join("fakepython.exe");
        fs::write(&fake_py, "").unwrap();

        // Scope the env var to this test using a guard pattern so a
        // failure doesn't leak state into other tests in the suite.
        struct EnvGuard {
            key: &'static str,
            prev: Option<String>,
        }
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                match &self.prev {
                    Some(v) => env::set_var(self.key, v),
                    None => env::remove_var(self.key),
                }
            }
        }
        let _g = EnvGuard {
            key: "LOCALLLM_HOST_PYTHON",
            prev: env::var("LOCALLLM_HOST_PYTHON").ok(),
        };
        env::set_var("LOCALLLM_HOST_PYTHON", &fake_py);

        let got = find_host_python(tmp.path()).expect("should find override");
        assert_eq!(got, fake_py);
    }
}

//! `set_env` — persist an environment variable that the desktop app
//! reads on startup.
//!
//! Port of `bootstrap_go/exec/set_env.go`. See the Go file's header
//! comment for the design rationale (why a JSON file instead of
//! `setx` / HKCU registry: isolation from system env). Behavior must
//! stay identical so the two implementations are drop-in
//! interchangeable.
//!
//! ## Args
//!
//! | key   | required | values                                  |
//! |-------|----------|-----------------------------------------|
//! | name  | yes      | env var name (e.g. `CUDA_HOME`)         |
//! | value | yes      | string value                            |
//! | scope | no       | `session` (default) / `user` / `machine`. Phase-0 only honors `session` |

use anyhow::{anyhow, Context, Result};
use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;

use crate::args::{arg_required, arg_string};
use crate::plan::Step;

const ENV_FILE_NAME: &str = "bootstrap_env.json";

pub struct SetEnvOpts {
    pub boot_dir: PathBuf,
}

/// Merge `{name: value}` into `<boot_dir>/runtime/bootstrap_env.json`
/// under the requested scope bucket.
pub fn set_env(opts: &SetEnvOpts, step: &Step) -> Result<()> {
    let name = arg_required(&step.args, "name").context("set_env")?;
    let value = arg_required(&step.args, "value").context("set_env")?;

    let scope = arg_string(&step.args, "scope").unwrap_or_else(|| "session".to_string());
    match scope.as_str() {
        "session" | "user" | "machine" => {}
        other => return Err(anyhow!("set_env: unknown scope {:?}", other)),
    }
    if scope != "session" {
        // Recorded but not yet applied — log loudly so the model
        // learns this avenue isn't ready, matching the Go log line.
        eprintln!(
            "  set_env: scope={:?} recorded only; machine/user scope wiring not yet implemented",
            scope
        );
    }

    let env_path = opts.boot_dir.join("runtime").join(ENV_FILE_NAME);

    // Read existing file, if any. Tolerant: malformed JSON resets
    // to an empty map (matches the Go path's `_ = json.Unmarshal(...)`).
    let mut current: Map<String, Value> = match fs::read(&env_path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(e) => return Err(anyhow!("set_env: read {}: {}", env_path.display(), e)),
    };

    // Bucket = current["<scope>"] or new empty map.
    let mut bucket: Map<String, Value> = current
        .get(&scope)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    bucket.insert(name.clone(), Value::String(value.clone()));
    current.insert(scope.clone(), Value::Object(bucket));

    if let Some(parent) = env_path.parent() {
        fs::create_dir_all(parent).context("set_env: mkdir")?;
    }

    let out =
        serde_json::to_vec_pretty(&Value::Object(current)).context("set_env: marshal")?;
    fs::write(&env_path, out).context("set_env: write")?;

    eprintln!("  set_env: {}={:?} (scope={})", name, value, scope);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;
    use tempfile::tempdir;

    fn read_env_file(boot_dir: &std::path::Path) -> BTreeMap<String, BTreeMap<String, Value>> {
        let p = boot_dir.join("runtime").join(ENV_FILE_NAME);
        let data = fs::read(&p).expect("env file exists");
        serde_json::from_slice(&data).expect("env file parses")
    }

    #[test]
    fn writes_session_bucket() {
        let tmp = tempdir().unwrap();
        let step = Step::new("set_env")
            .with_args(json!({ "name": "CUDA_HOME", "value": "/opt/cuda-12.1" }));
        set_env(
            &SetEnvOpts { boot_dir: tmp.path().to_path_buf() },
            &step,
        )
        .expect("set_env should succeed");
        let got = read_env_file(tmp.path());
        assert_eq!(
            got["session"]["CUDA_HOME"],
            Value::String("/opt/cuda-12.1".into())
        );
    }

    #[test]
    fn appends_to_existing_file() {
        let tmp = tempdir().unwrap();
        let opts = SetEnvOpts { boot_dir: tmp.path().to_path_buf() };
        let first = Step::new("set_env").with_args(json!({ "name": "A", "value": "1" }));
        let second = Step::new("set_env").with_args(json!({ "name": "B", "value": "2" }));
        set_env(&opts, &first).unwrap();
        set_env(&opts, &second).unwrap();
        let got = read_env_file(tmp.path());
        assert_eq!(got["session"]["A"], Value::String("1".into()));
        assert_eq!(got["session"]["B"], Value::String("2".into()));
    }

    #[test]
    fn rejects_unknown_scope() {
        let tmp = tempdir().unwrap();
        let step = Step::new("set_env")
            .with_args(json!({ "name": "X", "value": "y", "scope": "bogus" }));
        let err = set_env(
            &SetEnvOpts { boot_dir: tmp.path().to_path_buf() },
            &step,
        )
        .unwrap_err();
        assert!(err.to_string().contains("unknown scope"), "got: {}", err);
    }

    #[test]
    fn missing_name_fails() {
        let tmp = tempdir().unwrap();
        let step = Step::new("set_env").with_args(json!({ "value": "x" }));
        assert!(
            set_env(
                &SetEnvOpts { boot_dir: tmp.path().to_path_buf() },
                &step
            )
            .is_err()
        );
    }

    #[test]
    fn missing_value_fails() {
        let tmp = tempdir().unwrap();
        let step = Step::new("set_env").with_args(json!({ "name": "x" }));
        assert!(
            set_env(
                &SetEnvOpts { boot_dir: tmp.path().to_path_buf() },
                &step
            )
            .is_err()
        );
    }

    #[test]
    fn tolerates_corrupt_existing_file() {
        // The Go path drops a malformed JSON file silently and starts
        // fresh. Mirror that — otherwise a stray edit to bootstrap_env.json
        // would brick every subsequent set_env call.
        let tmp = tempdir().unwrap();
        let runtime = tmp.path().join("runtime");
        fs::create_dir_all(&runtime).unwrap();
        fs::write(runtime.join(ENV_FILE_NAME), b"not valid json {{{").unwrap();

        let step = Step::new("set_env").with_args(json!({ "name": "X", "value": "y" }));
        set_env(
            &SetEnvOpts { boot_dir: tmp.path().to_path_buf() },
            &step,
        )
        .expect("should recover from corrupt file");
        let got = read_env_file(tmp.path());
        assert_eq!(got["session"]["X"], Value::String("y".into()));
    }
}

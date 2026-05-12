//! Typed accessors for `Step::args`. Mirrors the Go helpers
//! `argString` / `argInt` / `argRequired` from
//! `bootstrap_go/exec/args.go` so action implementations look the
//! same shape across languages.

use anyhow::{anyhow, Result};
use serde_json::Value;

/// Read an optional string arg. Returns `None` if the key is missing
/// OR if it's present but not a string — caller decides if that's an
/// error.
pub fn arg_string(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Read a required string arg. Returns `Err` if missing, present-but-
/// wrong-type, or empty.
pub fn arg_required(args: &Value, key: &str) -> Result<String> {
    let v = args
        .get(key)
        .ok_or_else(|| anyhow!("missing required arg {:?}", key))?;
    let s = v
        .as_str()
        .ok_or_else(|| anyhow!("arg {:?} must be a string", key))?;
    if s.is_empty() {
        return Err(anyhow!("arg {:?} must be non-empty", key));
    }
    Ok(s.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn arg_string_missing_returns_none() {
        let args = json!({});
        assert!(arg_string(&args, "x").is_none());
    }

    #[test]
    fn arg_string_present_returns_some() {
        let args = json!({ "name": "CUDA_HOME" });
        assert_eq!(arg_string(&args, "name"), Some("CUDA_HOME".into()));
    }

    #[test]
    fn arg_required_missing_errors() {
        let args = json!({});
        assert!(arg_required(&args, "name").is_err());
    }

    #[test]
    fn arg_required_empty_errors() {
        let args = json!({ "name": "" });
        assert!(arg_required(&args, "name").is_err());
    }

    #[test]
    fn arg_required_wrong_type_errors() {
        let args = json!({ "name": 42 });
        assert!(arg_required(&args, "name").is_err());
    }
}

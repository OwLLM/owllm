//! Typed accessors for `Step::args`. Mirrors the Go helpers
//! `argString` / `argStringSlice` / `argRequired` from
//! `bootstrap_go/exec/args.go`.

use anyhow::{anyhow, Result};
use serde_json::Value;

/// Read an optional string arg. Returns `None` if the key is missing
/// OR if it's present but not a string.
pub fn arg_string(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Read a required string arg. Errors if missing, wrong-type, or empty.
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

/// Read an arg expected to be a list of strings. Tolerates JSON-typed
/// arrays-of-Value where every element is a string. Returns `None` if
/// the key is missing, the value isn't an array, or the array is empty
/// after filtering non-string elements — matches the Go behavior.
pub fn arg_string_slice(args: &Value, key: &str) -> Option<Vec<String>> {
    let arr = args.get(key)?.as_array()?;
    let out: Vec<String> = arr
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn arg_string_missing_returns_none() {
        assert!(arg_string(&json!({}), "x").is_none());
    }

    #[test]
    fn arg_string_present_returns_some() {
        assert_eq!(
            arg_string(&json!({ "name": "CUDA_HOME" }), "name"),
            Some("CUDA_HOME".into())
        );
    }

    #[test]
    fn arg_required_missing_errors() {
        assert!(arg_required(&json!({}), "name").is_err());
    }

    #[test]
    fn arg_required_empty_errors() {
        assert!(arg_required(&json!({ "name": "" }), "name").is_err());
    }

    #[test]
    fn arg_required_wrong_type_errors() {
        assert!(arg_required(&json!({ "name": 42 }), "name").is_err());
    }

    #[test]
    fn arg_string_slice_reads_string_array() {
        let v = arg_string_slice(&json!({ "opts": ["a", "b", "c"] }), "opts");
        assert_eq!(v, Some(vec!["a".into(), "b".into(), "c".into()]));
    }

    #[test]
    fn arg_string_slice_filters_non_strings() {
        let v = arg_string_slice(&json!({ "opts": ["a", 42, "b"] }), "opts");
        assert_eq!(v, Some(vec!["a".into(), "b".into()]));
    }

    #[test]
    fn arg_string_slice_empty_returns_none() {
        assert!(arg_string_slice(&json!({ "opts": [] }), "opts").is_none());
    }

    #[test]
    fn arg_string_slice_missing_returns_none() {
        assert!(arg_string_slice(&json!({}), "opts").is_none());
    }

    #[test]
    fn arg_string_slice_wrong_type_returns_none() {
        assert!(arg_string_slice(&json!({ "opts": "not an array" }), "opts").is_none());
    }
}

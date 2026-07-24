// Append-only, redacted audit trail — written on BOTH the controller and the
// target. One JSON line per request. Same discipline as kvm.rs: redaction is
// the default path, applied by the only constructor, so a new field can't leak
// by forgetting to opt in.
//
// What we deliberately do NOT persist: raw command OUTPUT. stdout/stderr can
// contain secrets the operator never intended to store, so the audit keeps only
// their length + SHA-256 digest (enough to prove "the same output" without
// holding it). The command LINE itself is recorded — that is the whole point of
// the trail (accountability for what ran on your machine), the same visibility
// a shell history gives.

use std::{
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use serde_json::{json, Value};

use super::protocol::CommandResult;

fn audit_path() -> Option<PathBuf> {
    crate::paths::user_data_root().map(|r| r.join("remote_devices_audit.jsonl"))
}

fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Redact free output to a length + digest — never the bytes themselves.
fn digest_field(s: &str) -> Value {
    if s.is_empty() {
        json!({ "len": 0 })
    } else {
        json!({ "len": s.chars().count(), "sha256": sha256_hex(s) })
    }
}

/// Build the redacted audit record. `direction` is "inbound" (a command this
/// machine executed for a remote controller) or "outbound" (a command this
/// machine sent to a remote target).
pub fn record(
    direction: &str,
    from_device: &str,
    to_device: &str,
    kind: &str,
    command: &str,
    decision: &str,
    result: &CommandResult,
) -> Value {
    json!({
        "ts": crate::remote_devices::now_rfc3339(),
        "dir": direction,
        "from_device": from_device,
        "to_device": to_device,
        "kind": kind,
        "command": command,
        "decision": decision,
        "ok": result.ok,
        "exit_code": result.exit_code,
        "error": result.error,
        // Output is digested, never stored raw.
        "stdout": digest_field(&result.stdout),
        "stderr": digest_field(&result.stderr),
        "duration_ms": result.duration_ms,
    })
}

fn append_line(path: &Path, record: &Value) -> std::io::Result<()> {
    use std::io::Write;
    let line = serde_json::to_string(record)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(f, "{line}")
}

/// Write one audit line. Best-effort: a missing data dir must not swallow the
/// command result, but any failure is surfaced to stderr (never silent).
pub fn write(record: &Value) {
    match audit_path() {
        Some(path) => {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(e) = append_line(&path, record) {
                eprintln!(
                    "remote_devices audit write failed ({}): {e}",
                    path.display()
                );
            }
        }
        None => eprintln!("remote_devices audit skipped: could not resolve app data dir"),
    }
}

/// The last `limit` audit lines, newest last, for the UI viewer.
pub fn tail(limit: usize) -> Vec<Value> {
    let Some(path) = audit_path() else {
        return vec![];
    };
    if limit == 0 {
        return vec![];
    }

    // The audit is append-only and can grow for months. Reading and parsing the
    // whole file just to render the newest rows used to stall the Devices page.
    let Ok(mut file) = std::fs::File::open(&path) else {
        return vec![];
    };
    let Ok(mut offset) = file.metadata().map(|m| m.len()) else {
        return vec![];
    };
    let mut bytes = Vec::new();
    const CHUNK_BYTES: u64 = 64 * 1024;

    while offset > 0 && bytes.iter().filter(|b| **b == b'\n').count() <= limit {
        let chunk_len = offset.min(CHUNK_BYTES) as usize;
        offset -= chunk_len as u64;
        if file.seek(SeekFrom::Start(offset)).is_err() {
            return vec![];
        }
        let mut chunk = vec![0; chunk_len];
        if file.read_exact(&mut chunk).is_err() {
            return vec![];
        }
        chunk.extend_from_slice(&bytes);
        bytes = chunk;
    }

    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.lines();
    // A chunk that did not start at byte zero begins in the middle of one JSON
    // line. Drop that partial record before parsing the complete tail.
    if offset > 0 {
        let _ = lines.next();
    }
    let all: Vec<Value> = lines
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect();
    let start = all.len().saturating_sub(limit);
    all[start..].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_devices::protocol::CommandResult;

    fn res(stdout: &str) -> CommandResult {
        CommandResult {
            request_id: "r".into(),
            ok: true,
            stdout: stdout.into(),
            stderr: "".into(),
            exit_code: Some(0),
            error: None,
            decision: "allowed".into(),
            duration_ms: 5,
            ..Default::default()
        }
    }

    #[test]
    fn output_is_never_stored_raw() {
        let secret = "SUPER_SECRET_TOKEN_abc123";
        let rec = record(
            "inbound",
            "a",
            "b",
            "shell",
            "whoami",
            "allowed",
            &res(secret),
        );
        let serialized = serde_json::to_string(&rec).unwrap();
        // The raw output must not appear anywhere in the audit line.
        assert!(!serialized.contains(secret));
        // But the digest + length are present.
        assert_eq!(rec["stdout"]["len"], json!(secret.chars().count()));
        assert!(rec["stdout"]["sha256"].is_string());
    }

    #[test]
    fn command_line_is_recorded_for_accountability() {
        let rec = record(
            "inbound",
            "a",
            "b",
            "shell",
            "systeminfo",
            "allowed",
            &res(""),
        );
        assert_eq!(rec["command"], json!("systeminfo"));
        assert_eq!(rec["dir"], json!("inbound"));
    }
}

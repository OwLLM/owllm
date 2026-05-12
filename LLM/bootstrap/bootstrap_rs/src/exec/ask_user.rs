//! `ask_user` — persist a question for the human and abort the run.
//!
//! Port of `bootstrap_go/exec/ask_user.go`. See that file's header
//! for the design rationale (no UI at install time, so we write a
//! JSON file the launcher surfaces via the toast widget on next
//! launch).
//!
//! Returns an `Err` even on the happy path so the plan loop halts —
//! that's the contract `Executor::run_plan` consumes.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use crate::args::{arg_required, arg_string_slice};
use crate::plan::Step;

const PENDING_QUESTION_FILE: &str = "pending_question.json";

pub struct AskUserOpts {
    pub boot_dir: PathBuf,
}

#[derive(Debug, Serialize)]
struct PendingQuestion {
    ts: String,
    question: String,
    options: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    reason: String,
}

/// Write the prompt JSON and return an error so the plan loop halts.
pub fn ask_user(opts: &AskUserOpts, step: &Step) -> Result<()> {
    let question = arg_required(&step.args, "question").context("ask_user")?;

    let options = arg_string_slice(&step.args, "options").unwrap_or_else(|| {
        vec!["continue".to_string(), "abort".to_string()]
    });

    let q = PendingQuestion {
        ts: format_now_rfc3339_utc(),
        question: question.clone(),
        options: options.clone(),
        reason: step.reason.clone(),
    };

    let dir = opts.boot_dir.join("runtime");
    fs::create_dir_all(&dir).context("ask_user: mkdir")?;
    let json = serde_json::to_vec_pretty(&q).context("ask_user: marshal")?;
    fs::write(dir.join(PENDING_QUESTION_FILE), json).context("ask_user: write")?;

    eprintln!("  ask_user: {:?}  options={:?}", question, options);
    Err(anyhow!(
        "ask_user: {} (options: {:?}) — pending in {}",
        question,
        options,
        PENDING_QUESTION_FILE
    ))
}

/// RFC 3339 (ISO 8601) timestamp in UTC, second precision. Avoids
/// pulling in `chrono` for ~10 lines of formatting.
fn format_now_rfc3339_utc() -> String {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Convert Unix seconds → Y/M/D H:M:S (UTC). Civil-from-days
    // algorithm by Howard Hinnant, public domain.
    let days = (now / 86_400) as i64;
    let secs_of_day = now % 86_400;
    let h = secs_of_day / 3600;
    let m = (secs_of_day % 3600) / 60;
    let s = secs_of_day % 60;

    let (year, month, day) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, h, m, s
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use tempfile::tempdir;

    fn read_pending(boot_dir: &std::path::Path) -> Value {
        let p = boot_dir.join("runtime").join(PENDING_QUESTION_FILE);
        let data = fs::read(&p).expect("pending file exists");
        serde_json::from_slice(&data).expect("parses")
    }

    #[test]
    fn writes_pending_question_file() {
        let tmp = tempdir().unwrap();
        let step = Step {
            action: "ask_user".into(),
            args: json!({ "question": "Continue with CPU profile?" }),
            reason: String::new(),
            fallback: None,
        };
        let err = ask_user(
            &AskUserOpts { boot_dir: tmp.path().to_path_buf() },
            &step,
        )
        .unwrap_err();
        assert!(err.to_string().contains("ask_user"));
        let got = read_pending(tmp.path());
        assert_eq!(got["question"], "Continue with CPU profile?");
        assert_eq!(got["options"], json!(["continue", "abort"]));
    }

    #[test]
    fn honors_custom_options() {
        let tmp = tempdir().unwrap();
        let step = Step {
            action: "ask_user".into(),
            args: json!({
                "question": "Which torch?",
                "options": ["cu121", "cu128", "cpu"]
            }),
            reason: String::new(),
            fallback: None,
        };
        let _ = ask_user(
            &AskUserOpts { boot_dir: tmp.path().to_path_buf() },
            &step,
        );
        let got = read_pending(tmp.path());
        assert_eq!(got["options"], json!(["cu121", "cu128", "cpu"]));
    }

    #[test]
    fn missing_question_fails() {
        let tmp = tempdir().unwrap();
        let step = Step {
            action: "ask_user".into(),
            args: json!({}),
            reason: String::new(),
            fallback: None,
        };
        let err = ask_user(
            &AskUserOpts { boot_dir: tmp.path().to_path_buf() },
            &step,
        )
        .unwrap_err();
        // Must be the missing-arg error, not the post-write halt
        // error. {:#} renders anyhow's full chain so we see the
        // inner missing-required-arg message that the `ask_user`
        // context wraps.
        let chain = format!("{err:#}");
        assert!(
            chain.contains("missing required arg"),
            "unexpected error: {chain}"
        );
        // And no file should have been written.
        let p = tmp.path().join("runtime").join(PENDING_QUESTION_FILE);
        assert!(!p.exists());
    }

    #[test]
    fn includes_reason_when_provided() {
        let tmp = tempdir().unwrap();
        let step = Step {
            action: "ask_user".into(),
            args: json!({ "question": "Continue?" }),
            reason: "GPU detected: Pascal — legacy profile is flaky".to_string(),
            fallback: None,
        };
        let _ = ask_user(
            &AskUserOpts { boot_dir: tmp.path().to_path_buf() },
            &step,
        );
        let got = read_pending(tmp.path());
        assert_eq!(got["reason"], "GPU detected: Pascal — legacy profile is flaky");
    }

    #[test]
    fn omits_reason_when_empty() {
        let tmp = tempdir().unwrap();
        let step = Step {
            action: "ask_user".into(),
            args: json!({ "question": "Continue?" }),
            reason: String::new(),
            fallback: None,
        };
        let _ = ask_user(
            &AskUserOpts { boot_dir: tmp.path().to_path_buf() },
            &step,
        );
        let got = read_pending(tmp.path());
        assert!(got.get("reason").is_none(), "reason should be omitted when empty");
    }
}

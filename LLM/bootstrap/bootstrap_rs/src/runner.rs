//! Subprocess runner. Mirrors `bootstrap_go/exec/runner.go`.
//!
//! Production wires `RealRunner` which calls `std::process::Command`.
//! Tests inject a `FakeRunner` to record `(bin, args)` without
//! spawning anything — same pattern as Go's `newFakeRunner`.

use anyhow::{anyhow, Result};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Subprocess execution surface.
///
/// `timeout` is honoured by the real implementation via a kill thread;
/// fakes can ignore it. Returns `Ok(())` on a clean exit-0 from the
/// child, or `Err` with a message containing the (truncated) output
/// tail so the LLM gets useful diagnostic feedback.
pub trait Runner: Send + Sync {
    fn run(&self, timeout: Duration, bin: &str, args: &[&str]) -> Result<()>;
}

/// Production runner — actually spawns the child process.
pub struct RealRunner;

impl Runner for RealRunner {
    fn run(&self, _timeout: Duration, bin: &str, args: &[&str]) -> Result<()> {
        // NB: spawning with a hard timeout requires a sidecar thread
        // that kills the child if it overruns. For Phase R2 we
        // accept the simpler behavior of "wait until done"; R3 (HTTP
        // / pkg actions) will add the kill-on-timeout wrapper since
        // pip can genuinely hang. The Go side uses
        // exec.CommandContext + context.WithTimeout for the same
        // result — port that pattern when we touch the slower
        // actions.
        let mut cmd = Command::new(bin);
        cmd.args(args);
        let out = cmd.output().map_err(|e| anyhow!("spawn {bin}: {e}"))?;
        if !out.status.success() {
            // Truncate combined output tail so log lines don't blow up.
            // Matches the Go side's 2000-byte tail behavior.
            let mut combined = Vec::with_capacity(out.stdout.len() + out.stderr.len() + 1);
            combined.extend_from_slice(&out.stdout);
            if !out.stdout.is_empty() && !out.stderr.is_empty() {
                combined.push(b'\n');
            }
            combined.extend_from_slice(&out.stderr);
            let tail = if combined.len() > 2000 {
                &combined[combined.len() - 2000..]
            } else {
                &combined[..]
            };
            let text = String::from_utf8_lossy(tail).trim().to_string();
            return Err(anyhow!(
                "{bin} {} exited with {}: (output tail: {})",
                args.join(" "),
                out.status,
                text
            ));
        }
        Ok(())
    }
}

/// Recorded subprocess call: (bin, args). FakeRunner appends to a
/// shared Vec so tests can assert exact command lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedCall {
    pub bin: String,
    pub args: Vec<String>,
}

/// Test fake. Records each call; optionally returns a pre-canned
/// error to simulate a failed subprocess. Mirrors the Go
/// `newFakeRunner(err)` helper.
pub struct FakeRunner {
    pub calls: Arc<Mutex<Vec<CapturedCall>>>,
    pub fail_with: Option<String>,
}

impl FakeRunner {
    pub fn new() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            fail_with: None,
        }
    }

    pub fn failing(msg: impl Into<String>) -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            fail_with: Some(msg.into()),
        }
    }

    /// Convenience: snapshot the recorded calls.
    pub fn captured(&self) -> Vec<CapturedCall> {
        self.calls.lock().unwrap().clone()
    }
}

impl Default for FakeRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl Runner for FakeRunner {
    fn run(&self, _timeout: Duration, bin: &str, args: &[&str]) -> Result<()> {
        let call = CapturedCall {
            bin: bin.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
        };
        self.calls.lock().unwrap().push(call);
        if let Some(ref msg) = self.fail_with {
            return Err(anyhow!("{}", msg));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_records_calls() {
        let r = FakeRunner::new();
        r.run(Duration::from_secs(1), "python", &["-V"]).unwrap();
        r.run(Duration::from_secs(1), "python", &["-c", "print(1)"])
            .unwrap();
        let calls = r.captured();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].bin, "python");
        assert_eq!(calls[0].args, vec!["-V"]);
        assert_eq!(calls[1].args, vec!["-c", "print(1)"]);
    }

    #[test]
    fn fake_returns_canned_error() {
        let r = FakeRunner::failing("pretend pip exploded");
        let err = r.run(Duration::from_secs(1), "pip", &[]).unwrap_err();
        assert!(err.to_string().contains("pretend pip exploded"));
        // Even on failure, the call was recorded.
        assert_eq!(r.captured().len(), 1);
    }

    #[test]
    fn real_runner_executes_and_succeeds() {
        // Use a command that should always succeed cheaply on Windows
        // and *nix alike. `cmd /c exit 0` on Windows is reliable; on
        // unix we fall through to /bin/true. The test stays portable
        // because `cfg!(windows)` resolves at compile time.
        let r = RealRunner;
        if cfg!(windows) {
            r.run(Duration::from_secs(5), "cmd", &["/c", "exit", "0"])
                .expect("cmd /c exit 0 should succeed");
        } else {
            r.run(Duration::from_secs(5), "true", &[])
                .expect("/bin/true should succeed");
        }
    }
}

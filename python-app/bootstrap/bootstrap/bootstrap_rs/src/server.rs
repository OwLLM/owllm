//! Server — llama-server.exe lifecycle.
//!
//! Port of `bootstrap_go/server/llama.go` + `hide_windows.go`.
//! Spawn the binary with a hidden console on Windows, poll `/health`
//! until ready, expose `post` / `healthy` / `shutdown` against the
//! local HTTP endpoint via ureq.
//!
//! Tests use a hand-rolled in-process HTTP server to validate
//! `post` / `healthy` / `shutdown` behavior without spawning a real
//! llama-server binary. `Start` itself is harder to unit-test because
//! it spawns a subprocess and waits on `/health` — the integration
//! test for that path is gated behind `#[ignore]`.

use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::thread;
use std::time::{Duration, Instant};

pub struct ServerConfig {
    pub binary: PathBuf,
    pub model: PathBuf,
    /// Optional path to a GBNF grammar — passed at request time, not
    /// at server start, so the same llama-server process can serve
    /// multiple grammars over its lifetime.
    pub grammar: Option<PathBuf>,
    pub port: u16,
    pub boot_timeout: Duration,
}

pub struct Server {
    cfg: ServerConfig,
    child: Option<Child>,
    base: String,
}

impl Server {
    /// Spawn llama-server and poll `/health` until it answers 200.
    /// Returns `Err` (and kills the child) if it doesn't become
    /// healthy within `boot_timeout`.
    pub fn start(cfg: ServerConfig) -> Result<Self> {
        if !cfg.binary.exists() {
            return Err(anyhow!(
                "llama-server binary missing: {}",
                cfg.binary.display()
            ));
        }
        if !cfg.model.exists() {
            return Err(anyhow!(
                "gguf model missing: {}",
                cfg.model.display()
            ));
        }

        let mut cmd = Command::new(&cfg.binary);
        cmd.arg("--model").arg(&cfg.model);
        cmd.arg("--port").arg(cfg.port.to_string());
        cmd.arg("--ctx-size").arg("16384");
        cmd.arg("-ngl").arg("0"); // CPU-only at install time

        // stdout / stderr -> /dev/null. We don't tee them anywhere
        // because the user sees a clean install GUI; if you need to
        // debug a hang, attach a debugger or run llama-server.exe by
        // hand.
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
        cmd.stdin(std::process::Stdio::null());

        hide_console(&mut cmd);

        let child = cmd
            .spawn()
            .with_context(|| format!("spawn {} failed", cfg.binary.display()))?;

        let base = format!("http://127.0.0.1:{}", cfg.port);
        let mut srv = Self {
            cfg,
            child: Some(child),
            base,
        };

        if let Err(e) = srv.wait_healthy(srv.cfg.boot_timeout) {
            let _ = srv.kill();
            return Err(e);
        }
        Ok(srv)
    }

    /// Construct a Server stub that talks to an already-running
    /// HTTP endpoint (e.g. a test mock). No subprocess is owned;
    /// `shutdown` / `kill` are no-ops.
    pub fn attach_to(base: impl Into<String>) -> Self {
        // Build a ServerConfig that's harmless if read — the only
        // field anything reads off cfg post-attach is boot_timeout
        // (in wait_healthy, which the caller doesn't call).
        let cfg = ServerConfig {
            binary: PathBuf::new(),
            model: PathBuf::new(),
            grammar: None,
            port: 0,
            boot_timeout: Duration::from_secs(0),
        };
        Self {
            cfg,
            child: None,
            base: base.into(),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    /// Optional grammar path the caller supplied — `Diagnose` reads
    /// the file at request time.
    pub fn grammar_path(&self) -> Option<&std::path::Path> {
        self.cfg.grammar.as_deref()
    }

    /// POST a JSON body to a path. Returns the response body bytes.
    /// Errors include HTTP non-2xx (with the body tail attached so
    /// the caller can surface model server errors).
    pub fn post(&self, path: &str, body: &[u8], timeout: Duration) -> Result<Vec<u8>> {
        let url = format!("{}{}", self.base, path);
        let agent = ureq::AgentBuilder::new().timeout(timeout).build();
        let resp = agent
            .post(&url)
            .set("Content-Type", "application/json")
            .send_bytes(body);
        match resp {
            Ok(r) => {
                let mut buf = Vec::new();
                r.into_reader()
                    .read_to_end(&mut buf)
                    .context("read body")?;
                Ok(buf)
            }
            Err(ureq::Error::Status(code, r)) => {
                let mut tail = Vec::new();
                let _ = r.into_reader().take(4096).read_to_end(&mut tail);
                Err(anyhow!(
                    "HTTP {code}: {}",
                    String::from_utf8_lossy(&tail).trim()
                ))
            }
            Err(e) => Err(anyhow!("POST {url}: {e}")),
        }
    }

    /// True iff `/health` returns 200 within a short timeout.
    pub fn healthy(&self) -> bool {
        let url = format!("{}/health", self.base);
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(2))
            .build();
        matches!(agent.get(&url).call(), Ok(r) if r.status() == 200)
    }

    /// Graceful shutdown: POST /shutdown, then wait up to `timeout`.
    /// Force-kill if still alive. No-op when no child is owned (e.g.
    /// servers attached via `attach_to`).
    pub fn shutdown(&mut self, timeout: Duration) -> Result<()> {
        let _ = self.post("/shutdown", b"{}", timeout);
        let deadline = Instant::now() + timeout;
        if let Some(child) = self.child.as_mut() {
            while Instant::now() < deadline {
                match child.try_wait() {
                    Ok(Some(_)) => return Ok(()),
                    Ok(None) => thread::sleep(Duration::from_millis(100)),
                    Err(e) => return Err(anyhow!("try_wait: {e}")),
                }
            }
            // Force kill.
            self.kill()?;
        }
        Ok(())
    }

    fn kill(&mut self) -> Result<()> {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    fn wait_healthy(&self, timeout: Duration) -> Result<()> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.healthy() {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(500));
        }
        Err(anyhow!(
            "llama-server did not become healthy within {:?}",
            timeout
        ))
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}

// Hidden console: Windows-only no-op elsewhere.
//
// CREATE_NO_WINDOW = 0x08000000 — same constant the Go side uses in
// hide_windows.go. We set it via the Windows-specific CommandExt
// from std so we don't pull in `windows-sys`.
#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {
    // POSIX shells don't pop transient consoles per spawned subprocess.
}

use std::io::Read; // brought into scope for `take(...).read_to_end` above

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// In-process HTTP/1.1 server that answers a fixed set of routes.
    /// Keeps serving until the listener is dropped. Threadsafe.
    struct StubServer {
        addr: String,
        request_count: Arc<AtomicUsize>,
        _handle: thread::JoinHandle<()>,
    }

    impl StubServer {
        fn new(routes: Vec<(&'static str, u16, Vec<u8>)>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
            let addr = format!("http://{}", listener.local_addr().unwrap());
            let request_count = Arc::new(AtomicUsize::new(0));
            let counter = request_count.clone();
            let route_map: std::collections::HashMap<String, (u16, Vec<u8>)> = routes
                .into_iter()
                .map(|(p, s, b)| (p.to_string(), (s, b)))
                .collect();
            let handle = thread::spawn(move || loop {
                let (mut stream, _) = match listener.accept() {
                    Ok(p) => p,
                    Err(_) => break,
                };
                counter.fetch_add(1, Ordering::SeqCst);
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                // Drain headers
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0
                        || line == "\r\n"
                        || line == "\n"
                    {
                        break;
                    }
                }
                // Pluck path out of "METHOD /path HTTP/1.1\r\n"
                let path = request_line
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("/")
                    .to_string();
                let (status, body) = route_map
                    .get(&path)
                    .cloned()
                    .unwrap_or((404, b"not found".to_vec()));
                let reason = match status {
                    200 => "OK",
                    404 => "Not Found",
                    500 => "Internal Server Error",
                    _ => "Unknown",
                };
                let head = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n",
                    len = body.len(),
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
                let _ = stream.flush();
            });
            Self {
                addr,
                request_count,
                _handle: handle,
            }
        }

        fn count(&self) -> usize {
            self.request_count.load(Ordering::SeqCst)
        }
    }

    #[test]
    fn attach_to_returns_base_url() {
        let srv = Server::attach_to("http://127.0.0.1:65530");
        assert_eq!(srv.base_url(), "http://127.0.0.1:65530");
    }

    #[test]
    fn healthy_returns_true_on_200() {
        let stub = StubServer::new(vec![("/health", 200, b"ok".to_vec())]);
        let srv = Server::attach_to(&stub.addr);
        assert!(srv.healthy());
        assert_eq!(stub.count(), 1);
    }

    #[test]
    fn healthy_returns_false_on_500() {
        let stub = StubServer::new(vec![("/health", 500, b"down".to_vec())]);
        let srv = Server::attach_to(&stub.addr);
        assert!(!srv.healthy());
    }

    #[test]
    fn healthy_returns_false_when_unreachable() {
        // 127.0.0.1:1 — kernel-reserved port, refuses immediately.
        let srv = Server::attach_to("http://127.0.0.1:1");
        assert!(!srv.healthy());
    }

    #[test]
    fn post_round_trips_body() {
        let stub =
            StubServer::new(vec![("/completion", 200, b"{\"content\":\"ok\"}".to_vec())]);
        let srv = Server::attach_to(&stub.addr);
        let got = srv
            .post("/completion", b"{\"prompt\":\"hi\"}", Duration::from_secs(2))
            .expect("ok");
        assert_eq!(got, b"{\"content\":\"ok\"}".to_vec());
    }

    #[test]
    fn post_propagates_non_2xx_as_error() {
        let stub =
            StubServer::new(vec![("/completion", 500, b"server crashed".to_vec())]);
        let srv = Server::attach_to(&stub.addr);
        let err = srv
            .post("/completion", b"{}", Duration::from_secs(2))
            .unwrap_err();
        let s = err.to_string();
        assert!(s.contains("HTTP 500"), "got: {s}");
        assert!(s.contains("server crashed"), "got: {s}");
    }

    #[test]
    fn shutdown_with_no_child_is_noop() {
        let stub =
            StubServer::new(vec![("/shutdown", 200, b"bye".to_vec())]);
        let mut srv = Server::attach_to(&stub.addr);
        srv.shutdown(Duration::from_millis(200))
            .expect("attached server has no child to kill");
    }
}

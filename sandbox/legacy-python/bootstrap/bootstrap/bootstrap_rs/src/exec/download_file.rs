//! `download_file` — HTTPS download of a single artifact.
//!
//! Port of `bootstrap_go/exec/download_file.go`. Idempotent: if
//! `dest` already exists and matches `sha256` (when given), skip the
//! download. Otherwise overwrite atomically (.part → rename).
//!
//! HTTPS by default. `http://` URLs only resolve when
//! `LOCALLLM_ALLOW_HTTP=1` is set in the environment — same escape
//! hatch the Go side uses for testing against an in-process server.

use anyhow::{anyhow, Context, Result};
use sha2::{Digest, Sha256};
use std::env;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::args::{arg_required, arg_string};
use crate::plan::Step;

/// HTTP fetcher abstraction. Production wires `UreqFetcher`; tests
/// inject `FakeFetcher` to assert URL / status without an in-process
/// HTTP server (though we also have a real-loopback test using
/// `MockHttpServer` further down).
pub trait Fetcher: Send + Sync {
    /// Perform a GET. Returns `(status, body_bytes)`. The
    /// implementation is responsible for any timeouts.
    fn fetch(&self, url: &str) -> Result<(u16, Vec<u8>)>;
}

/// Production fetcher backed by ureq (blocking HTTP, bundled
/// rustls). 30-minute total timeout matches the Go side.
pub struct UreqFetcher;

impl Fetcher for UreqFetcher {
    fn fetch(&self, url: &str) -> Result<(u16, Vec<u8>)> {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(30 * 60))
            .build();
        let resp = match agent.get(url).call() {
            Ok(r) => r,
            // ureq returns specific Error variants for HTTP non-2xx.
            // We want to surface those as (status, body) rather than
            // erroring out, so the caller can write a clean
            // "HTTP <status>" message.
            Err(ureq::Error::Status(code, resp)) => {
                let body = read_body(resp).unwrap_or_default();
                return Ok((code, body));
            }
            Err(e) => return Err(anyhow!("GET {url}: {e}")),
        };
        let status = resp.status();
        let body = read_body(resp).context("read body")?;
        Ok((status, body))
    }
}

fn read_body(resp: ureq::Response) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    resp.into_reader().read_to_end(&mut buf)?;
    Ok(buf)
}

pub struct DownloadFileOpts<'a> {
    pub fetcher: &'a dyn Fetcher,
}

pub fn download_file(opts: &DownloadFileOpts<'_>, step: &Step) -> Result<()> {
    let raw_url = arg_required(&step.args, "url").context("download_file")?;
    let dest_str = arg_required(&step.args, "dest").context("download_file")?;
    let want_hash = arg_string(&step.args, "sha256").unwrap_or_default();
    let dest = PathBuf::from(&dest_str);

    validate_url(&raw_url).context("download_file")?;

    // Idempotence: skip if dest already matches the expected hash.
    if !want_hash.is_empty() && dest.exists() {
        if let Ok(existing) = sha256_file(&dest) {
            if hash_eq_ignore_case(&existing, &want_hash) {
                eprintln!(
                    "  download_file: {} already up-to-date (sha256 match)",
                    dest.display()
                );
                return Ok(());
            }
        }
    }

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("download_file: mkdir {}", parent.display()))?;
    }

    let tmp = with_part_suffix(&dest);

    let (status, body) = opts
        .fetcher
        .fetch(&raw_url)
        .with_context(|| format!("download_file: GET {raw_url}"))?;
    if status != 200 {
        return Err(anyhow!("download_file: GET {raw_url} -> HTTP {status}"));
    }

    // Write atomically: body -> .part, hash check, rename. Match the
    // Go side which removes the .part file on hash mismatch so dest
    // never points at a half-downloaded file.
    {
        let mut f = File::create(&tmp)
            .with_context(|| format!("download_file: create {}", tmp.display()))?;
        f.write_all(&body)
            .with_context(|| format!("download_file: write {}", tmp.display()))?;
    }
    eprintln!(
        "  download_file: wrote {:.1} MB to {}",
        body.len() as f64 / 1e6,
        dest.display()
    );

    if !want_hash.is_empty() {
        let mut hasher = Sha256::new();
        hasher.update(&body);
        let got = hex::encode(hasher.finalize());
        if !hash_eq_ignore_case(&got, &want_hash) {
            // Drop the .part so we don't leave a half-good file
            // behind. Same behavior as the Go defer os.Remove(tmp).
            let _ = fs::remove_file(&tmp);
            return Err(anyhow!(
                "download_file: sha256 mismatch (want {want_hash}, got {got})"
            ));
        }
    }

    fs::rename(&tmp, &dest).with_context(|| {
        format!(
            "download_file: rename {} -> {}",
            tmp.display(),
            dest.display()
        )
    })?;
    Ok(())
}

fn with_part_suffix(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

fn hash_eq_ignore_case(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Refuse non-https URLs unless `LOCALLLM_ALLOW_HTTP=1`. Mirrors
/// `validateURL` from the Go side.
pub fn validate_url(raw: &str) -> Result<()> {
    // Cheap parse: just inspect the scheme prefix. Anything that
    // doesn't look like `scheme://` fails immediately.
    let scheme = raw.find("://").map(|idx| &raw[..idx]);
    let scheme = scheme.ok_or_else(|| anyhow!("invalid url: missing scheme"))?;
    if scheme.is_empty() {
        return Err(anyhow!("invalid url: empty scheme"));
    }
    if !scheme
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
    {
        return Err(anyhow!("invalid url: malformed scheme {scheme:?}"));
    }
    if scheme.eq_ignore_ascii_case("https") {
        return Ok(());
    }
    if scheme.eq_ignore_ascii_case("http")
        && env::var("LOCALLLM_ALLOW_HTTP").as_deref() == Ok("1")
    {
        return Ok(());
    }
    Err(anyhow!(
        "only https URLs are allowed (got {scheme:?})"
    ))
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut f = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use tempfile::tempdir;

    /// Hand-rolled mock HTTP/1.1 server — replaces Go's
    /// `httptest.NewServer`. Spawns a thread that serves a fixed
    /// `(status, body)` for the first request and shuts down. Bind
    /// to 127.0.0.1:0 so the kernel picks a free port.
    struct MockHttpServer {
        addr: String,
        _handle: thread::JoinHandle<()>,
    }

    impl MockHttpServer {
        fn new(status: u16, body: Vec<u8>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
            let addr = listener.local_addr().unwrap();
            let addr_str = format!("http://{addr}/");
            let handle = thread::spawn(move || {
                if let Ok((mut stream, _)) = listener.accept() {
                    // Read + discard request headers up to the blank line.
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 {
                            break;
                        }
                        if line == "\r\n" || line == "\n" {
                            break;
                        }
                    }
                    let reason = match status {
                        200 => "OK",
                        404 => "Not Found",
                        _ => "Unknown",
                    };
                    let head = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n",
                        len = body.len(),
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(&body);
                    let _ = stream.flush();
                }
            });
            Self {
                addr: addr_str,
                _handle: handle,
            }
        }

        fn url(&self) -> &str {
            &self.addr
        }
    }

    /// Test-only fetcher — return a canned `(status, body)` from a
    /// `HashMap<url, response>`. Useful when we don't want to spawn a
    /// real TCP server.
    struct FakeFetcher {
        responses: HashMap<String, (u16, Vec<u8>)>,
        calls: Arc<Mutex<Vec<String>>>,
    }

    impl FakeFetcher {
        fn new(responses: Vec<(&str, u16, Vec<u8>)>) -> Self {
            let map = responses
                .into_iter()
                .map(|(u, s, b)| (u.to_string(), (s, b)))
                .collect();
            Self {
                responses: map,
                calls: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Fetcher for FakeFetcher {
        fn fetch(&self, url: &str) -> Result<(u16, Vec<u8>)> {
            self.calls.lock().unwrap().push(url.to_string());
            self.responses
                .get(url)
                .cloned()
                .ok_or_else(|| anyhow!("FakeFetcher: no canned response for {url}"))
        }
    }

    // EnvGuard sets and later restores an env var so tests that mutate
    // LOCALLLM_ALLOW_HTTP don't leak state into other tests in the
    // suite. Drop runs even if the test panics.
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
    fn allow_http() -> EnvGuard {
        let g = EnvGuard {
            key: "LOCALLLM_ALLOW_HTTP",
            prev: env::var("LOCALLLM_ALLOW_HTTP").ok(),
        };
        env::set_var("LOCALLLM_ALLOW_HTTP", "1");
        g
    }

    #[test]
    fn validate_url_table() {
        assert!(validate_url("https://example.com/x").is_ok());
        // http without LOCALLLM_ALLOW_HTTP is rejected
        env::remove_var("LOCALLLM_ALLOW_HTTP");
        assert!(validate_url("http://example.com/x").is_err());
        assert!(validate_url("ftp://example.com/x").is_err());
        assert!(validate_url(":bad-url").is_err());
        // http allowed when env flag is set
        let _g = allow_http();
        assert!(validate_url("http://example.com/x").is_ok());
    }

    #[test]
    fn happy_path_writes_body_to_dest() {
        let _g = allow_http();
        let body = b"payload".to_vec();
        let tmp = tempdir().unwrap();
        let dest = tmp.path().join("x.bin");

        // Use the fake fetcher so we don't depend on TCP, which makes
        // tests work in sandboxed CI environments too.
        let fake = FakeFetcher::new(vec![("http://test.invalid/x", 200, body.clone())]);
        download_file(
            &DownloadFileOpts { fetcher: &fake },
            &Step::new("download_file").with_args(json!({
                "url": "http://test.invalid/x",
                "dest": dest.to_string_lossy(),
            })),
        )
        .expect("should succeed");
        let got = fs::read(&dest).expect("dest exists");
        assert_eq!(got, body);
        assert_eq!(fake.calls(), vec!["http://test.invalid/x".to_string()]);
    }

    #[test]
    fn hash_match_skips_redownload() {
        let _g = allow_http();
        let body = b"first version".to_vec();
        let mut hasher = Sha256::new();
        hasher.update(&body);
        let hex_hash = hex::encode(hasher.finalize());

        let tmp = tempdir().unwrap();
        let dest = tmp.path().join("y.bin");
        fs::write(&dest, &body).unwrap();

        // Fetcher would return a DIFFERENT body if hit — proves the
        // short-circuit prevented the call. The fetcher's response
        // for the URL is intentionally "wrong" content; if the short-
        // circuit fails, the file gets overwritten and the test
        // catches it.
        let fake = FakeFetcher::new(vec![(
            "http://test.invalid/y",
            200,
            b"DIFFERENT".to_vec(),
        )]);
        download_file(
            &DownloadFileOpts { fetcher: &fake },
            &Step::new("download_file").with_args(json!({
                "url":    "http://test.invalid/y",
                "dest":   dest.to_string_lossy(),
                "sha256": hex_hash,
            })),
        )
        .expect("should succeed");
        // Disk content must still be the original "first version".
        let got = fs::read(&dest).unwrap();
        assert_eq!(got, body);
        // And the fetcher was NOT called.
        assert!(fake.calls().is_empty(), "should have short-circuited");
    }

    #[test]
    fn hash_mismatch_fails_and_removes_part() {
        let _g = allow_http();
        let tmp = tempdir().unwrap();
        let dest = tmp.path().join("z.bin");
        let fake = FakeFetcher::new(vec![(
            "http://test.invalid/z",
            200,
            b"payload".to_vec(),
        )]);
        let err = download_file(
            &DownloadFileOpts { fetcher: &fake },
            &Step::new("download_file").with_args(json!({
                "url":    "http://test.invalid/z",
                "dest":   dest.to_string_lossy(),
                "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
            })),
        )
        .unwrap_err();
        let chain = format!("{err:#}");
        assert!(chain.contains("sha256 mismatch"), "got: {chain}");
        // Dest must NOT exist (we never renamed .part -> dest).
        assert!(!dest.exists(), "dest should not exist after mismatch");
        // .part must also have been cleaned up.
        let part = with_part_suffix(&dest);
        assert!(!part.exists(), ".part should be cleaned up");
    }

    #[test]
    fn http_404_propagates_as_error() {
        let _g = allow_http();
        let tmp = tempdir().unwrap();
        let dest = tmp.path().join("missing.bin");
        let fake = FakeFetcher::new(vec![("http://test.invalid/404", 404, b"nope".to_vec())]);
        let err = download_file(
            &DownloadFileOpts { fetcher: &fake },
            &Step::new("download_file").with_args(json!({
                "url":  "http://test.invalid/404",
                "dest": dest.to_string_lossy(),
            })),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("HTTP 404"),
            "got: {err}"
        );
    }

    // Real-network integration test using the in-process mock server.
    // This validates that UreqFetcher and validate_url + the body
    // pipeline work end-to-end. Marked #[ignore] by default because
    // some sandboxed CI environments block loopback binds.
    #[test]
    #[ignore = "real-loopback test; enable with `cargo test --include-ignored`"]
    fn end_to_end_loopback_http() {
        let _g = allow_http();
        let body = b"loopback works".to_vec();
        let srv = MockHttpServer::new(200, body.clone());
        let tmp = tempdir().unwrap();
        let dest = tmp.path().join("e2e.bin");

        download_file(
            &DownloadFileOpts {
                fetcher: &UreqFetcher,
            },
            &Step::new("download_file").with_args(json!({
                "url":  srv.url(),
                "dest": dest.to_string_lossy(),
            })),
        )
        .expect("loopback download");
        let got = fs::read(&dest).unwrap();
        assert_eq!(got, body);
    }
}

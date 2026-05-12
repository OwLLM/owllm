//! Diagnose — POST the install request to llama-server and parse
//! the resulting plan.
//!
//! Port of `bootstrap_go/plan/plan.go::Diagnose`. The Go side
//! coupled the wire types and the function into one package; the
//! Rust split has `plan.rs` (just the Step type), `plan_parser.rs`
//! (tolerant parser), and this module (orchestration).

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::time::Duration;

use crate::plan::Step;
use crate::plan_parser::parse_steps;
use crate::server::Server;

/// The request body the Go side serializes verbatim; we use a
/// `serde_json::Value` for `hardware` until the hardware probe lands
/// (Phase R5) — that's the part with the platform-specific schema.
#[derive(Debug, Serialize)]
pub struct DiagnoseRequest {
    pub hardware: Value,
    #[serde(rename = "install_goal")]
    pub install_goal: String,
    pub recipes: String,
}

/// Build the llama.cpp `/completion` body and POST it. Parses the
/// resulting `content` field through the tolerant plan parser.
///
/// `grammar_path`, when `Some`, is read once and passed as the
/// `grammar` field of the request so the model's output is GBNF-
/// constrained. The Go side reads this from disk on every call; we
/// expose it as a `&[u8]` to let callers cache.
pub fn diagnose(
    srv: &Server,
    system_prompt: &[u8],
    grammar: Option<&[u8]>,
    req: &DiagnoseRequest,
    timeout: Duration,
) -> Result<Vec<Step>> {
    let user_json = serde_json::to_string_pretty(req).context("diagnose: marshal req")?;
    let system = std::str::from_utf8(system_prompt).context("diagnose: system prompt utf8")?;

    // Gemma chat template — matches what brain.py and the Go side
    // both produce.
    let prompt = format!(
        "<start_of_turn>user\n{system}\n\n{user_json}\n<end_of_turn>\n<start_of_turn>model\n"
    );

    let mut body = json!({
        "prompt": prompt,
        "n_predict": 1024,
        "temperature": 0.1,
        "stop": ["<end_of_turn>", "</s>"],
    });
    if let Some(g) = grammar {
        if !g.is_empty() {
            let g_str = std::str::from_utf8(g).context("diagnose: grammar utf8")?;
            body["grammar"] = Value::String(g_str.to_string());
        }
    }

    let body_bytes = serde_json::to_vec(&body).context("diagnose: marshal body")?;
    let out = srv
        .post("/completion", &body_bytes, timeout)
        .context("/completion failed")?;

    #[derive(serde::Deserialize)]
    struct Envelope {
        content: String,
    }
    let env: Envelope =
        serde_json::from_slice(&out).context("envelope not JSON")?;
    let steps = parse_steps(&env.content)?;
    if steps.is_empty() {
        return Err(anyhow!("model returned no steps"));
    }
    Ok(steps)
}

/// Convenience: read system prompt and grammar files from
/// `<boot_dir>/recipes/` and call [`diagnose`]. Returns `(steps,
/// grammar_bytes_for_reuse)` so callers can cache the grammar across
/// multiple diagnose calls.
pub fn diagnose_with_files(
    srv: &Server,
    recipes_dir: &Path,
    req: &DiagnoseRequest,
    timeout: Duration,
) -> Result<Vec<Step>> {
    let system = fs::read(recipes_dir.join("system_prompt.txt"))
        .context("diagnose: read system_prompt.txt")?;
    let grammar = fs::read(recipes_dir.join("plan.gbnf")).ok();
    diagnose(srv, &system, grammar.as_deref(), req, timeout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::Server;
    use serde_json::json;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;

    /// In-process HTTP/1.1 server that captures the LAST request body
    /// and answers a fixed response. Lets us assert what diagnose()
    /// sent over the wire.
    struct CapturingServer {
        addr: String,
        last_body: Arc<Mutex<Vec<u8>>>,
        request_count: Arc<AtomicUsize>,
        _handle: thread::JoinHandle<()>,
    }

    impl CapturingServer {
        fn new(response_body: Vec<u8>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
            let addr = format!("http://{}", listener.local_addr().unwrap());
            let last_body = Arc::new(Mutex::new(Vec::<u8>::new()));
            let lb = last_body.clone();
            let count = Arc::new(AtomicUsize::new(0));
            let ct = count.clone();
            let handle = thread::spawn(move || loop {
                let (mut stream, _) = match listener.accept() {
                    Ok(p) => p,
                    Err(_) => break,
                };
                ct.fetch_add(1, Ordering::SeqCst);
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                // Read request line + headers until blank line; pluck
                // Content-Length.
                let mut content_length: usize = 0;
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    if line == "\r\n" || line == "\n" {
                        break;
                    }
                    let lower = line.to_ascii_lowercase();
                    if let Some(rest) = lower.strip_prefix("content-length:") {
                        content_length = rest.trim().parse().unwrap_or(0);
                    }
                }
                // Read body.
                let mut body = vec![0u8; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut body);
                }
                *lb.lock().unwrap() = body;
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n",
                    len = response_body.len(),
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&response_body);
                let _ = stream.flush();
            });
            Self {
                addr,
                last_body,
                request_count: count,
                _handle: handle,
            }
        }

        fn last_request_body(&self) -> Vec<u8> {
            self.last_body.lock().unwrap().clone()
        }

        fn count(&self) -> usize {
            self.request_count.load(Ordering::SeqCst)
        }
    }

    #[test]
    fn happy_path_returns_steps() {
        // llama-server envelope shape: {"content": "<plan json>"}
        let llm_envelope = json!({
            "content": r#"{"steps":[{"action":"create_venv","args":{"python_version":"3.11"}}]}"#
        });
        let stub = CapturingServer::new(serde_json::to_vec(&llm_envelope).unwrap());
        let srv = Server::attach_to(&stub.addr);
        let steps = diagnose(
            &srv,
            b"You are a supervisor.",
            None,
            &DiagnoseRequest {
                hardware: json!({}),
                install_goal: "install owllm".into(),
                recipes: "fallback".into(),
            },
            Duration::from_secs(2),
        )
        .expect("diagnose should succeed");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].action, "create_venv");
    }

    #[test]
    fn includes_grammar_when_supplied() {
        let llm_envelope = json!({"content": r#"{"action":"abort","args":{}}"#});
        let stub = CapturingServer::new(serde_json::to_vec(&llm_envelope).unwrap());
        let srv = Server::attach_to(&stub.addr);
        let _ = diagnose(
            &srv,
            b"sys",
            Some(b"root ::= \"plan\""),
            &DiagnoseRequest {
                hardware: json!({}),
                install_goal: "x".into(),
                recipes: "".into(),
            },
            Duration::from_secs(2),
        )
        .expect("ok");
        // Inspect captured request body for the grammar field.
        let body = stub.last_request_body();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["grammar"], "root ::= \"plan\"");
        // Prompt should follow the Gemma chat template.
        assert!(v["prompt"].as_str().unwrap().contains("<start_of_turn>user"));
        assert!(v["prompt"].as_str().unwrap().contains("<end_of_turn>"));
    }

    #[test]
    fn skips_grammar_when_empty_bytes() {
        let llm_envelope = json!({"content": r#"{"action":"abort","args":{}}"#});
        let stub = CapturingServer::new(serde_json::to_vec(&llm_envelope).unwrap());
        let srv = Server::attach_to(&stub.addr);
        let _ = diagnose(
            &srv,
            b"sys",
            Some(b""), // empty -> omit
            &DiagnoseRequest {
                hardware: json!({}),
                install_goal: "x".into(),
                recipes: "".into(),
            },
            Duration::from_secs(2),
        )
        .unwrap();
        let body = stub.last_request_body();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(v.get("grammar").is_none(), "grammar should be absent");
    }

    #[test]
    fn unparseable_content_errors() {
        let llm_envelope = json!({"content": "this is not a plan"});
        let stub = CapturingServer::new(serde_json::to_vec(&llm_envelope).unwrap());
        let srv = Server::attach_to(&stub.addr);
        let err = diagnose(
            &srv,
            b"sys",
            None,
            &DiagnoseRequest {
                hardware: json!({}),
                install_goal: "x".into(),
                recipes: "".into(),
            },
            Duration::from_secs(2),
        )
        .unwrap_err();
        assert!(err.to_string().contains("could not parse plan"));
    }

    #[test]
    fn envelope_not_json_errors() {
        let stub = CapturingServer::new(b"not even an envelope".to_vec());
        let srv = Server::attach_to(&stub.addr);
        let err = diagnose(
            &srv,
            b"sys",
            None,
            &DiagnoseRequest {
                hardware: json!({}),
                install_goal: "x".into(),
                recipes: "".into(),
            },
            Duration::from_secs(2),
        )
        .unwrap_err();
        let chain = format!("{err:#}");
        assert!(chain.contains("envelope not JSON"), "got: {chain}");
    }

    #[test]
    fn server_was_actually_called() {
        let stub = CapturingServer::new(
            serde_json::to_vec(&json!({"content": r#"{"action":"abort","args":{}}"#}))
                .unwrap(),
        );
        let srv = Server::attach_to(&stub.addr);
        let _ = diagnose(
            &srv,
            b"sys",
            None,
            &DiagnoseRequest {
                hardware: json!({}),
                install_goal: "x".into(),
                recipes: "".into(),
            },
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(stub.count(), 1);
    }
}

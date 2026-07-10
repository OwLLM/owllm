// finetuning — spawn LLM/finetune.py against a verified env profile
// and stream its stdout/stderr to the React TrainPage.
//
// Pipeline:
//   1. UI calls `train_start` with a TrainConfig + env profile name.
//   2. Rust looks up the env profile, confirms it's Ready (matching
//      manifest hash), resolves its venv python.exe.
//   3. Spawn `<venv-python> finetune.py --model-name ... --data-path ...` with
//      CUDA_VISIBLE_DEVICES set per the GPU selection. stdout/stderr
//      are line-buffered and re-emitted as TrainEvent::Log + JSON
//      lines matching `{"step": N, "loss": X, "lr": Y}` are also
//      decoded and emitted as TrainEvent::Metric.
//   4. Stop is cooperative: train_stop() writes a sentinel file that
//      finetune.py polls (see `--stop-file` in finetune.py). The
//      trainer commits the in-flight step, saves the partial adapter,
//      and exits cleanly — no SIGKILL needed.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::ipc::Channel;

/// Frontend → backend: every parameter the train CLI accepts. Names
/// match the args in `LLM/finetune.py`. Optional fields fall back
/// to finetune.py's own defaults.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrainConfig {
    /// Env profile slug, from env_profiles.yaml.
    pub env_profile: String,
    /// Base model. Either a HuggingFace model id ("google/gemma-2-2b")
    /// or an absolute path to a local model directory.
    pub base_model: String,
    /// Path to the training dataset (.jsonl) file.
    pub dataset: String,
    /// Where the fine-tuned adapter goes. Will be created if missing.
    pub output_dir: String,
    /// Run name shown in the UI + appended to output_dir for unique
    /// per-run subfolders.
    pub run_name: String,
    pub epochs: u32,
    pub learning_rate: f64,
    pub lora_r: u32,
    pub max_seq_len: u32,
    /// GPU indices to expose to the trainer. Translated to a comma-
    /// separated CUDA_VISIBLE_DEVICES before spawn so finetune.py
    /// doesn't need to know our internal GPU UUID mapping.
    pub gpus: Vec<u32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TrainEvent {
    Started {
        run_name: String,
    },
    Log {
        stream: String,
        line: String,
    },
    /// Parsed from a JSON line on stdout — finetune.py periodically
    /// prints structured progress so the UI can render tiles without
    /// regexing the log.
    Metric {
        step: u64,
        total_steps: Option<u64>,
        loss: Option<f64>,
        learning_rate: Option<f64>,
        samples_per_sec: Option<f64>,
        eta_sec: Option<f64>,
        epoch: Option<f64>,
    },
    Finished {
        output_dir: String,
    },
    Failed {
        error: String,
    },
}

/// Shared mutable state for the singleton training run. We only
/// allow one run at a time — the UI button is disabled while a run
/// is in flight, and the Rust side enforces the same so a stray IPC
/// call can't fork-bomb the system.
#[derive(Default)]
struct TrainState {
    running: bool,
    run_name: Option<String>,
    output_dir: Option<PathBuf>,
    /// Sentinel path that finetune.py polls. Writing any byte to this
    /// file triggers a graceful stop after the next training step.
    stop_file: Option<PathBuf>,
    /// Most recent metric tuple. Used by train_status() so a re-
    /// mounted TrainPage shows the current numbers without replaying
    /// the log.
    last_step: Option<u64>,
    last_total_steps: Option<u64>,
    last_loss: Option<f64>,
    last_lr: Option<f64>,
    last_sps: Option<f64>,
    /// Rolling tail of stdout lines (last 30). Same use case as the
    /// metrics — handy for `train_status` after a tab switch.
    log_tail: Vec<String>,
}

static TRAIN_STATE: Mutex<TrainState> = Mutex::new(TrainState {
    running: false,
    run_name: None,
    output_dir: None,
    stop_file: None,
    last_step: None,
    last_total_steps: None,
    last_loss: None,
    last_lr: None,
    last_sps: None,
    log_tail: Vec::new(),
});

/// Does `p` look like an on-disk model directory (HF transformers or a LoRA
/// adapter)?
fn looks_like_model_dir(p: &std::path::Path) -> bool {
    p.is_dir()
        && (p.join("config.json").is_file()
            || p.join("adapter_config.json").is_file()
            || std::fs::read_dir(p)
                .map(|it| {
                    it.flatten().any(|e| {
                        let n = e.file_name();
                        let n = n.to_string_lossy();
                        n.ends_with(".safetensors") || n.ends_with(".bin")
                    })
                })
                .unwrap_or(false))
}

/// Resolve the base-model value the trainer should receive. A model that is
/// DOWNLOADED on disk is passed as its ABSOLUTE LOCAL PATH so transformers
/// loads the weights directly; otherwise the value passes through as a
/// HuggingFace id for the trainer to fetch.
///
/// Fixes "<name> is not a local folder and is not a valid model identifier"
/// when the picker handed over a bare safe-name (e.g.
/// "unsloth__gemma-2-2b-it-bnb-4bit") for a model that IS downloaded — it lives
/// at <models-root>/<safe-name>/ but was passed as a name, not a path, so the
/// trainer treated it as an (invalid) HF id.
fn resolve_base_model_arg(base: &str) -> String {
    // Already an absolute path to a real model dir.
    let direct = std::path::Path::new(base);
    if direct.is_absolute() && looks_like_model_dir(direct) {
        return base.to_string();
    }
    let safe = base.replace('/', "__");
    for root in crate::paths::models_dirs_read() {
        // Flat safe-name dir: <root>/<owner__model>/.
        let flat = root.join(&safe);
        if looks_like_model_dir(&flat) {
            return flat.to_string_lossy().into_owned();
        }
        // Nested HF layout: <root>/<owner>/<model>/.
        if let Some((owner, model)) = base.split_once('/') {
            let nested = root.join(owner).join(model);
            if looks_like_model_dir(&nested) {
                return nested.to_string_lossy().into_owned();
            }
        }
    }
    // Not found locally → pass through as a HuggingFace id.
    base.to_string()
}

/// Start a training run. Returns once the subprocess has been
/// spawned (or immediately on validation failure). Progress events
/// stream over the Channel for the rest of the run.
#[tauri::command]
pub async fn train_start(config: TrainConfig, channel: Channel<TrainEvent>) -> Result<(), String> {
    // Singleton guard — refuse to start a second run while one is
    // active. The UI button is disabled but a stray double-click on
    // a slow machine should still bounce off here cleanly.
    {
        let st = TRAIN_STATE.lock().map_err(|e| format!("state lock: {e}"))?;
        if st.running {
            return Err("a training run is already in progress".to_string());
        }
    }

    // Cheap up-front validation so the UI surfaces "you forgot the
    // dataset" without ever spawning Python.
    if config.base_model.trim().is_empty() {
        return Err("base_model is required".to_string());
    }
    if config.dataset.trim().is_empty() {
        return Err("dataset is required".to_string());
    }
    if !std::path::Path::new(&config.dataset).is_file() {
        return Err(format!(
            "dataset file not found: {} (give the full path to a .jsonl)",
            config.dataset
        ));
    }
    if config.output_dir.trim().is_empty() {
        return Err("output_dir is required".to_string());
    }

    // Look up the env profile + its installed python.exe. We bounce
    // through env_profile_status so the "Ready" check is the SAME
    // logic the TrainPage uses to enable/disable the Start button.
    let env_state = crate::env_manager::env_profile_status(config.env_profile.clone())
        .await
        .map_err(|e| format!("env_profile_status: {e}"))?;
    let python_exe = match env_state {
        crate::env_manager::EnvProfileState::Ready { python_exe } => python_exe,
        other => {
            return Err(format!(
                "env profile '{}' is not Ready (state: {:?}). Install it on the Train page first.",
                config.env_profile, other
            ));
        }
    };

    // Resolve finetune.py from the legacy LLM tree.
    let script = crate::paths::finetune_script()
        .ok_or_else(|| "LLM/finetune.py not found — legacy tree may be incomplete".to_string())?;

    // Per-run output subdir so concurrent / sequential runs don't
    // overwrite each other's adapters.
    let run_dir = std::path::PathBuf::from(&config.output_dir).join(&config.run_name);
    std::fs::create_dir_all(&run_dir)
        .map_err(|e| format!("create output dir {}: {e}", run_dir.display()))?;
    let stop_file = run_dir.join(".stop");

    // GPU env var — finetune.py reads CUDA_VISIBLE_DEVICES (it
    // explicitly does NOT touch CUDA_DEVICE_ORDER) so we forward
    // user-picked indices verbatim. Empty list → no GPU restriction
    // (torch sees all GPUs).
    let cuda_devices = config
        .gpus
        .iter()
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join(",");

    // Build the argv list — keep this in lockstep with finetune.py's
    // argparse. New flags must land here AND in the Python.
    // Flag names MUST match finetune.py's argparse exactly. They had drifted
    // (--base/--dataset/--run-name/--max-seq-len) and argparse rejected the run
    // with "unrecognized arguments". The script defines --model-name/--data-path/
    // --adapter-name/--max-seq-length; run_name is piped to --adapter-name so the
    // saved LoRA adapter is named after the run instead of a generic timestamp.
    let argv: Vec<String> = vec![
        script.to_string_lossy().into_owned(),
        // Downloaded model → its local path (load from disk); else a HF id.
        "--model-name".into(),
        resolve_base_model_arg(&config.base_model),
        "--data-path".into(),
        config.dataset.clone(),
        "--output-dir".into(),
        run_dir.to_string_lossy().into_owned(),
        "--adapter-name".into(),
        config.run_name.clone(),
        "--epochs".into(),
        config.epochs.to_string(),
        "--learning-rate".into(),
        format!("{}", config.learning_rate),
        "--lora-r".into(),
        config.lora_r.to_string(),
        "--max-seq-length".into(),
        config.max_seq_len.to_string(),
        "--stop-file".into(),
        stop_file.to_string_lossy().into_owned(),
    ];

    let _ = channel.send(TrainEvent::Started {
        run_name: config.run_name.clone(),
    });

    // Record run state BEFORE spawning so a fast train_status() call
    // sees the run is live even if the Python is still importing
    // torch (which can take a few seconds on cold start).
    {
        let mut st = TRAIN_STATE.lock().map_err(|e| format!("state lock: {e}"))?;
        st.running = true;
        st.run_name = Some(config.run_name.clone());
        st.output_dir = Some(run_dir.clone());
        st.stop_file = Some(stop_file.clone());
        st.last_step = None;
        st.last_total_steps = None;
        st.last_loss = None;
        st.last_lr = None;
        st.last_sps = None;
        st.log_tail.clear();
    }

    let channel_for_task = channel.clone();
    let run_dir_for_task = run_dir.clone();

    tokio::spawn(async move {
        let outcome = spawn_trainer(&python_exe, &argv, &cuda_devices, &channel_for_task).await;
        // Always flip running=false on exit, regardless of outcome.
        {
            if let Ok(mut st) = TRAIN_STATE.lock() {
                st.running = false;
                st.stop_file = None;
            }
        }
        match outcome {
            Ok(()) => {
                let _ = channel_for_task.send(TrainEvent::Finished {
                    output_dir: run_dir_for_task.to_string_lossy().into_owned(),
                });
            }
            Err(e) => {
                let _ = channel_for_task.send(TrainEvent::Failed { error: e });
            }
        }
    });

    Ok(())
}

/// Core subprocess driver — spawns finetune.py, pumps stdout/stderr,
/// parses JSON metric lines, returns Ok on exit-0 and Err otherwise.
async fn spawn_trainer(
    python_exe: &str,
    argv: &[String],
    cuda_visible_devices: &str,
    channel: &Channel<TrainEvent>,
) -> Result<(), String> {
    use tokio::io::AsyncBufReadExt;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // On Windows the fine-tuning env lives INSIDE WSL (env_manager hands
    // back a POSIX python path); the trainer must therefore run in-distro,
    // with Windows path args translated to /mnt. build_trainer_command
    // handles that; on native Linux it's a plain local spawn.
    let mut cmd = build_trainer_command(python_exe, argv, cuda_visible_devices)?;
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn python: {e}"))?;
    let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "no stderr".to_string())?;

    let ch_out = channel.clone();
    let stdout_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            on_log_line(&ch_out, "stdout", &line);
        }
    });
    let ch_err = channel.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            on_log_line(&ch_err, "stderr", &line);
        }
    });
    let status = child.wait().await.map_err(|e| format!("wait: {e}"))?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;
    if !status.success() {
        return Err(format!(
            "trainer exited with code {}",
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".into())
        ));
    }
    Ok(())
}

/// Build the trainer subprocess. Native Linux (and a Windows host
/// python, if ever used) → spawn the interpreter directly. Windows with
/// a WSL env (POSIX python path) → run it inside the distro via
/// `wsl.exe -- bash -lc`, exporting CUDA_VISIBLE_DEVICES / PYTHONUNBUFFERED
/// and translating Windows path arguments to their /mnt mounts.
fn build_trainer_command(
    python_exe: &str,
    argv: &[String],
    cuda_visible_devices: &str,
) -> Result<tokio::process::Command, String> {
    use tokio::process::Command;
    #[cfg(windows)]
    if python_exe.starts_with('/') {
        let distro = crate::wsl::best_linux_distro().ok_or_else(|| {
            "fine-tuning env is in WSL but no real Linux distro is available".to_string()
        })?;
        let q = crate::wsl::sh_quote;
        let mut script = String::new();
        if !cuda_visible_devices.is_empty() {
            script.push_str(&format!(
                "export CUDA_VISIBLE_DEVICES={}; ",
                q(cuda_visible_devices)
            ));
        }
        script.push_str("export PYTHONUNBUFFERED=1; exec ");
        script.push_str(&q(python_exe));
        for a in argv {
            script.push(' ');
            script.push_str(&q(&win_arg_to_mnt(a)));
        }
        let mut c = Command::new("wsl.exe");
        c.arg("-d")
            .arg(&distro)
            .arg("--")
            .arg("bash")
            .arg("-lc")
            .arg(&script);
        return Ok(c);
    }
    // Host path: spawn the interpreter directly.
    let mut c = Command::new(python_exe);
    c.args(argv);
    if !cuda_visible_devices.is_empty() {
        c.env("CUDA_VISIBLE_DEVICES", cuda_visible_devices);
    }
    c.env("PYTHONUNBUFFERED", "1");
    Ok(c)
}

/// Translate a Windows absolute path (`C:\a\b`) to its WSL mount
/// (`/mnt/c/a/b`). Anything that isn't a drive-letter path — flags,
/// numbers, already-POSIX paths — is returned unchanged.
#[cfg(windows)]
fn win_arg_to_mnt(s: &str) -> String {
    let b = s.as_bytes();
    if b.len() >= 3
        && (b[0] as char).is_ascii_alphabetic()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/')
    {
        let drive = (b[0] as char).to_ascii_lowercase();
        let rest = s[2..].replace('\\', "/");
        format!("/mnt/{drive}{rest}")
    } else {
        s.to_string()
    }
}

/// Process one log line: always emit as TrainEvent::Log + update the
/// rolling tail; additionally try to decode it as a JSON metric tuple
/// and emit TrainEvent::Metric on success. finetune.py prints metrics
/// as `{"step":N,"loss":X,"learning_rate":Y}` (or any superset — we
/// only read those three fields).
fn on_log_line(ch: &Channel<TrainEvent>, stream: &str, line: &str) {
    let _ = ch.send(TrainEvent::Log {
        stream: stream.to_string(),
        line: line.to_string(),
    });
    // Update rolling state for train_status. We hold the lock briefly
    // — even with a fast trainer producing 100 lines/sec this is well
    // under the contention threshold of a Mutex.
    if let Ok(mut st) = TRAIN_STATE.lock() {
        st.log_tail.push(line.to_string());
        if st.log_tail.len() > 30 {
            let drop = st.log_tail.len() - 30;
            st.log_tail.drain(..drop);
        }
    }
    let trimmed = line.trim();
    // finetune.py prints `DASHBOARD_METRICS: {json}` (prefixed, on purpose, so
    // it's easy to spot and hard to mis-parse). Strip that prefix; also accept
    // a bare `{json}` line for forward-compat. Anything else isn't a metric.
    let json_part = trimmed
        .strip_prefix("DASHBOARD_METRICS:")
        .map(|s| s.trim())
        .unwrap_or(trimmed);
    if !json_part.starts_with('{') {
        return;
    }
    let value: serde_json::Value = match serde_json::from_str(json_part) {
        Ok(v) => v,
        Err(_) => return, // e.g. the single-quoted Python-dict repr — skip
    };
    // `step` is the one field every metric line carries; loss / lr can be null
    // on the warm-up emission, so they're optional. Emit on EVERY metric line
    // (the dashboard needs step / total_steps / speed even before the first loss).
    let Some(step) = value.get("step").and_then(|v| v.as_u64()) else {
        return;
    };
    let total_steps = value.get("total_steps").and_then(|v| v.as_u64());
    let loss = value.get("loss").and_then(|v| v.as_f64());
    let lr = value
        .get("learning_rate")
        .or_else(|| value.get("lr"))
        .and_then(|v| v.as_f64());
    let sps = value.get("samples_per_sec").and_then(|v| v.as_f64());
    let eta = value.get("eta_sec").and_then(|v| v.as_f64());
    let epoch = value.get("epoch").and_then(|v| v.as_f64());
    let _ = ch.send(TrainEvent::Metric {
        step,
        total_steps,
        loss,
        learning_rate: lr,
        samples_per_sec: sps,
        eta_sec: eta,
        epoch,
    });
    if let Ok(mut st) = TRAIN_STATE.lock() {
        st.last_step = Some(step);
        if total_steps.is_some() {
            st.last_total_steps = total_steps;
        }
        if loss.is_some() {
            st.last_loss = loss;
        }
        if lr.is_some() {
            st.last_lr = lr;
        }
        if sps.is_some() {
            st.last_sps = sps;
        }
    }
}

/// Sniff a dataset file: count rows + report a coarse format label.
/// Supports the four shapes the Train page advertises: jsonl, json,
/// csv, parquet. Parquet just reports the byte size since we don't
/// want to pull arrow in for one tooltip.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetSummary {
    pub count: u64,
    pub format: String,
}

// Mirror finetune.py's accepted field names so the Check button flags a
// dataset that will FAIL format detection at train time. Previously Check only
// counted rows, so a prompts-only file showed a green "N examples" and then
// crashed the run with "Could not detect dataset format" — the "crashed
// without a clear reason" report.
const DS_INPUT_KEYS: &[&str] = &[
    "instruction",
    "prompt",
    "input",
    "question",
    "query",
    "text",
    "user",
    "human",
    "customer_message",
    "customer",
    "message",
    "query_text",
];
const DS_OUTPUT_KEYS: &[&str] = &[
    "output",
    "response",
    "completion",
    "answer",
    "reply",
    "assistant",
    "gpt",
    "bot",
    "assistant_response",
    "response_text",
    "answer_text",
];

/// First example object out of a parsed JSON value (array, {"data":[...]}, or
/// a single object).
fn first_json_example(v: &serde_json::Value) -> Option<&serde_json::Value> {
    match v {
        serde_json::Value::Array(a) => a.first(),
        serde_json::Value::Object(m) => m
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|a| a.first())
            .or(Some(v)),
        _ => None,
    }
}

/// `None` if the first example looks trainable (input+output pair or messages
/// format); otherwise a clear warning the Check button can show.
fn dataset_format_note(first: &serde_json::Value) -> Option<String> {
    let obj = first.as_object()?;
    if obj.contains_key("messages") {
        return None;
    }
    let has_in = DS_INPUT_KEYS.iter().any(|k| obj.contains_key(*k));
    let has_out = DS_OUTPUT_KEYS.iter().any(|k| obj.contains_key(*k));
    if has_in && has_out {
        return None;
    }
    let keys = obj.keys().cloned().collect::<Vec<_>>().join(", ");
    if has_in {
        Some(format!(
            "⚠ no response/output field (keys: {keys}). Each example needs a target — \
             add an \"output\" or \"response\" per example, or use the messages format. \
             Training will reject this dataset as-is."
        ))
    } else {
        Some(format!(
            "⚠ no recognized input/output fields (keys: {keys}). Expected an input \
             (instruction/prompt/…) AND an output (output/response/…), or a messages array."
        ))
    }
}

#[tauri::command]
pub async fn dataset_check(path: String) -> Result<DatasetSummary, String> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "jsonl" => {
            let text = std::fs::read_to_string(&p).map_err(|e| format!("read {path}: {e}"))?;
            let count = text.lines().filter(|l| !l.trim().is_empty()).count() as u64;
            let note = text
                .lines()
                .find(|l| !l.trim().is_empty())
                .and_then(|l| serde_json::from_str::<serde_json::Value>(l).ok())
                .as_ref()
                .and_then(dataset_format_note);
            let format = match note {
                Some(n) => format!("jsonl · {n}"),
                None => "jsonl".to_string(),
            };
            Ok(DatasetSummary { count, format })
        }
        "json" => {
            let text = std::fs::read_to_string(&p).map_err(|e| format!("read {path}: {e}"))?;
            let v: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| format!("parse {path}: {e}"))?;
            let count = match &v {
                serde_json::Value::Array(arr) => arr.len() as u64,
                serde_json::Value::Object(map) => {
                    // Datasets-library shape: {"data": [...]}
                    map.get("data")
                        .and_then(|d| d.as_array())
                        .map(|a| a.len() as u64)
                        .unwrap_or(1)
                }
                _ => 1,
            };
            let note = first_json_example(&v).and_then(dataset_format_note);
            let format = match note {
                Some(n) => format!("json · {n}"),
                None => "json".to_string(),
            };
            Ok(DatasetSummary { count, format })
        }
        "csv" => {
            let text = std::fs::read_to_string(&p).map_err(|e| format!("read {path}: {e}"))?;
            // Header + N rows → N examples.
            let total_lines = text.lines().filter(|l| !l.trim().is_empty()).count() as u64;
            let count = total_lines.saturating_sub(1);
            Ok(DatasetSummary {
                count,
                format: "csv".to_string(),
            })
        }
        "parquet" => {
            let bytes = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            Ok(DatasetSummary {
                count: 0,
                format: format!("parquet · {:.1} MB", bytes as f64 / 1024.0 / 1024.0),
            })
        }
        other => Err(format!(
            "unsupported dataset extension '.{other}' — use jsonl, json, csv, or parquet"
        )),
    }
}

// ---------------------------------------------------------------------
// Dataset Builder — turn documents/URLs into training data.
//
// Phase 1 (here): run the bundled, GPU-free dataset_ingest.py to extract clean
// text and chunk it. Phase 2 (LLM generation of {instruction, output} pairs from
// each chunk) lives in the UI, reusing the user's picked model via the normal
// chat dispatch. dataset_save writes the final JSONL.
// ---------------------------------------------------------------------

/// Run dataset_ingest.py over a manifest JSON and return its result JSON (the
/// per-source extracted text + chunk lists). Runs on the bundled host Python
/// (no GPU/torch needed); the script degrades gracefully per source so one bad
/// file/URL can't fail the batch.
#[tauri::command]
pub async fn dataset_ingest(manifest_json: String) -> Result<String, String> {
    use tokio::process::Command;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let script = crate::paths::tools_dir()
        .map(|d| d.join("dataset_ingest.py"))
        .filter(|p| p.is_file())
        .ok_or_else(|| "dataset_ingest.py not found in resources/tools/".to_string())?;
    // Bundled host Python first; fall back to a system interpreter so the builder
    // still works before the heavy runtime is installed (the script is stdlib-only
    // for txt/md/docx/url; PDF wants pypdf and degrades to a per-source error).
    let python = crate::paths::bundled_python_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "python".to_string()
            } else {
                "python3".to_string()
            }
        });

    let dir = std::env::temp_dir();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let manifest_path = dir.join(format!("owllm_ds_manifest_{stamp}.json"));
    let result_path = dir.join(format!("owllm_ds_result_{stamp}.json"));

    // PDF text extraction in RUST (compiled in — no Python 'pypdf' to install, so
    // PDFs work for everyone). We pull the text here and inject it into the
    // manifest as a per-source `text` (success) or `error` (scanned/encrypted),
    // so the Python ingest uses it directly and keeps the original filename for
    // display. Non-PDF sources are untouched (DOCX/TXT/MD/URL already work on the
    // Python standard library).
    let manifest_json = {
        let mut v: serde_json::Value =
            serde_json::from_str(&manifest_json).map_err(|e| format!("parse manifest: {e}"))?;
        if let Some(arr) = v.get_mut("sources").and_then(|s| s.as_array_mut()) {
            for src in arr.iter_mut() {
                let is_file = src.get("type").and_then(|t| t.as_str()).unwrap_or("file") == "file";
                let val = src
                    .get("value")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                if !is_file || !val.to_lowercase().ends_with(".pdf") {
                    continue;
                }
                let extracted =
                    tokio::task::spawn_blocking(move || pdf_extract::extract_text(&val))
                        .await
                        .map_err(|e| format!("pdf task join: {e}"))?;
                if let Some(obj) = src.as_object_mut() {
                    match extracted {
                        Ok(text) if !text.trim().is_empty() => {
                            obj.insert("text".into(), serde_json::Value::String(text));
                        }
                        Ok(_) => {
                            obj.insert("error".into(), serde_json::Value::String(
                                "no extractable text in this PDF — it looks scanned/image-only (OCR isn't supported yet)".into()));
                        }
                        Err(e) => {
                            obj.insert(
                                "error".into(),
                                serde_json::Value::String(format!("couldn't read this PDF: {e}")),
                            );
                        }
                    }
                }
            }
        }
        serde_json::to_string(&v).map_err(|e| format!("serialize manifest: {e}"))?
    };

    std::fs::write(&manifest_path, manifest_json.as_bytes())
        .map_err(|e| format!("write manifest: {e}"))?;

    let mut cmd = Command::new(&python);
    cmd.arg(&script)
        .arg("--input")
        .arg(&manifest_path)
        .arg("--output")
        .arg(&result_path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("spawn python ({python}): {e}"))?;
    let _ = std::fs::remove_file(&manifest_path);
    if !output.status.success() {
        let _ = std::fs::remove_file(&result_path);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        // The script emits {"event":"failed","error":...} on stdout on a clean
        // failure; prefer that, else the stderr tail.
        let msg = stdout
            .lines()
            .rev()
            .find_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| {
                stderr
                    .trim()
                    .lines()
                    .last()
                    .unwrap_or("dataset ingest failed")
                    .to_string()
            });
        return Err(format!("dataset ingest failed: {msg}"));
    }
    let result =
        std::fs::read_to_string(&result_path).map_err(|e| format!("read ingest result: {e}"))?;
    let _ = std::fs::remove_file(&result_path);
    Ok(result)
}

/// Write the generated dataset (JSONL text) to `path`, creating parent dirs.
/// Returns the absolute path written.
#[tauri::command]
pub async fn dataset_save(path: String, content: String) -> Result<String, String> {
    let p = std::path::PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(&p, content.as_bytes()).map_err(|e| format!("write {path}: {e}"))?;
    Ok(p.to_string_lossy().into_owned())
}

/// Default directory for generated datasets (`<llm_root>/datasets`), created on
/// demand so the UI can default its save dialog there and the Train page can
/// find them. Empty string if no root resolves (the UI then just uses a dialog).
#[tauri::command]
pub async fn dataset_default_dir() -> Result<String, String> {
    let Some(root) = crate::paths::llm_root() else {
        return Ok(String::new());
    };
    let dir = root.join("datasets");
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.to_string_lossy().into_owned())
}

/// Ask the running trainer to stop at the next safe boundary.
/// finetune.py polls the stop-file path so we just write the sentinel
/// — the trainer commits the in-flight step and saves the partial
/// adapter before exiting cleanly.
#[tauri::command]
pub async fn train_stop() -> Result<(), String> {
    let stop_path = {
        let st = TRAIN_STATE.lock().map_err(|e| format!("state lock: {e}"))?;
        if !st.running {
            return Err("no training run is currently active".to_string());
        }
        st.stop_file.clone()
    };
    let stop_path = stop_path.ok_or_else(|| "no stop file recorded".to_string())?;
    std::fs::write(&stop_path, b"stop")
        .map_err(|e| format!("write stop file {}: {e}", stop_path.display()))?;
    Ok(())
}

/// Snapshot of the most recent training step seen on stdout. The UI
/// polls this on mount so a re-opened TrainPage shows the latest
/// state without replaying the entire log.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrainStatus {
    pub running: bool,
    /// "idle" / "running" / "done" / "error". React StatusPill uses this
    /// directly, so it must be present.
    pub state: String,
    pub run_name: Option<String>,
    pub step: Option<u64>,
    pub total_steps: Option<u64>,
    pub loss: Option<f64>,
    pub eval_loss: Option<f64>,
    pub learning_rate: Option<f64>,
    pub samples_per_sec: Option<f64>,
    pub vram_used_gb: Option<f64>,
    pub elapsed_sec: Option<u64>,
    pub message: Option<String>,
    pub last_log_tail: Vec<String>,
}

#[tauri::command]
pub async fn train_status() -> Result<TrainStatus, String> {
    let st = TRAIN_STATE.lock().map_err(|e| format!("state lock: {e}"))?;
    Ok(TrainStatus {
        running: st.running,
        state: if st.running {
            "running".into()
        } else {
            "idle".into()
        },
        run_name: st.run_name.clone(),
        step: st.last_step,
        total_steps: st.last_total_steps,
        loss: st.last_loss,
        eval_loss: None,
        learning_rate: st.last_lr,
        samples_per_sec: st.last_sps,
        vram_used_gb: None,
        elapsed_sec: None,
        message: None,
        last_log_tail: st.log_tail.clone(),
    })
}

// ---------------------------------------------------------------------
// Abliteration — FailSpy refusal-direction stripping via tools/abliterate.py
// ---------------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AbliterateConfig {
    /// Transformers-format model directory or HuggingFace id.
    pub model: String,
    /// Where the abliterated model dir gets written. When omitted,
    /// defaults to <llm_root>/fine_tuned/<safe_name>__abliterated/ so
    /// the result auto-surfaces in the Tuned tab next to LoRA adapters.
    pub output_dir: Option<String>,
    /// Env profile slug to source python.exe from. Defaults to the
    /// same tf-cu121 profile the Train page uses.
    pub env_profile: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AbliterateEvent {
    /// Raw JSON line emitted by abliterate.py — UI parses for nicer
    /// rendering but always has the underlying string available.
    Progress {
        stage: String,
        step: Option<u64>,
        total: Option<u64>,
        detail: Option<String>,
    },
    /// Anything that didn't decode as JSON. Forwarded verbatim to a
    /// log tail so import errors surface to the user.
    Log {
        stream: String,
        line: String,
    },
    Finished {
        output_dir: String,
    },
    Failed {
        error: String,
    },
}

#[tauri::command]
pub async fn abliterate_start(
    config: AbliterateConfig,
    channel: Channel<AbliterateEvent>,
) -> Result<(), String> {
    // Resolve a usable Python:
    //   1. If config.env_profile is set, try the registry (env_profiles.yaml).
    //   2. Otherwise (or if the registry doesn't know it), scan
    //      LLM/.envs/* for any venv whose python.exe exists. The legacy
    //      app installed envs under names like 'tf-cu121-t25-base-stable'
    //      that aren't in the registry — without the fallback the user
    //      sees "no env profile named X" and is blocked.
    let mut python_exe: Option<String> = None;
    if let Some(name) = config.env_profile.as_deref() {
        if let Ok(state) = crate::env_manager::env_profile_status(name.to_string()).await {
            if let crate::env_manager::EnvProfileState::Ready { python_exe: p } = state {
                python_exe = Some(p);
            }
        }
    }
    // Fallback 1: ANY ready REGISTERED env profile. On Windows these are WSL
    // venvs (bin/python), so the raw Windows ".venv/Scripts/python.exe" scan
    // below never matched — abliterate reported "No Python environment found"
    // even with both envs installed. Abliteration needs torch + transformers,
    // which both "standard" and "unsloth" provide; prefer "standard" (the full
    // transformers stack) for the cleanest raw model load.
    if python_exe.is_none() {
        if let Ok(profiles) = crate::env_manager::env_profiles_list().await {
            let mut names: Vec<String> = profiles.iter().map(|p| p.name.clone()).collect();
            names.sort_by_key(|n| if n == "standard" { 0 } else { 1 });
            for name in names {
                if let Ok(crate::env_manager::EnvProfileState::Ready { python_exe: p }) =
                    crate::env_manager::env_profile_status(name).await
                {
                    python_exe = Some(p);
                    break;
                }
            }
        }
    }
    // Fallback 2 (legacy): a raw local Windows venv from the old app tree.
    if python_exe.is_none() {
        if let Some(root) = crate::paths::llm_root() {
            let envs_dir = root.join(".envs");
            if let Ok(entries) = std::fs::read_dir(&envs_dir) {
                // Prefer transformers-style envs (tf-*) over llama.cpp-only
                // ones (llamacpp-*) since abliteration needs torch + HF.
                let mut candidates: Vec<std::path::PathBuf> = Vec::new();
                for e in entries.flatten() {
                    let p = e.path();
                    if !p.is_dir() {
                        continue;
                    }
                    let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                    if name.contains("dedicated") {
                        continue;
                    }
                    if name.starts_with("llamacpp") {
                        continue;
                    }
                    let venv_py = p.join(".venv").join("Scripts").join("python.exe");
                    if venv_py.is_file() {
                        candidates.push(venv_py);
                    }
                }
                // Most-recent-name-first heuristic: -stable beats -edge,
                // base beats bnb (we want pip-installed transformers).
                candidates.sort_by(|a, b| b.cmp(a));
                python_exe = candidates.first().map(|p| p.to_string_lossy().into_owned());
            }
        }
    }
    let python_exe = python_exe.ok_or_else(|| {
        "No Python environment with torch + transformers found. Install one via the Train page Environment picker, \
         or ensure an LLM/.envs/<name>/.venv/Scripts/python.exe exists.".to_string()
    })?;
    let script = crate::paths::abliterate_script().ok_or_else(|| {
        "LLM/tools/abliterate.py not found — legacy tree may be incomplete".to_string()
    })?;

    // Output dir — explicit user-provided OR auto-derive into
    // <llm_root>/fine_tuned/ so list_tuned_adapters picks it up
    // automatically and the result appears on the Tuned tab.
    let out_dir = if let Some(d) = config.output_dir.as_deref().filter(|s| !s.is_empty()) {
        std::path::PathBuf::from(d)
    } else {
        let safe = config.model.replace('/', "__").replace(
            |c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-' && c != '.',
            "_",
        );
        let root = crate::paths::llm_root()
            .ok_or_else(|| "could not resolve LLM root for default output_dir".to_string())?;
        root.join("fine_tuned").join(format!("{safe}__abliterated"))
    };
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("mkdir output {}: {e}", out_dir.display()))?;
    let stop_file = out_dir.join(".stop");

    let mut argv: Vec<String> = vec![
        script.to_string_lossy().into_owned(),
        "--model".into(),
        config.model.clone(),
        "--output-dir".into(),
        out_dir.to_string_lossy().into_owned(),
        "--stop-file".into(),
        stop_file.to_string_lossy().into_owned(),
    ];
    // Auto-pick up an external prompt corpus when the user has dropped
    // one next to the script. Filename convention is fixed so SuperGemma /
    // any-abliterated-model output just needs to be saved as
    // `abliterate_corpus.json` to take effect — no CLI tweaking needed.
    if let Some(parent) = std::path::Path::new(&argv[0]).parent() {
        let corpus = parent.join("abliterate_corpus.json");
        if corpus.is_file() {
            argv.push("--corpus".into());
            argv.push(corpus.to_string_lossy().into_owned());
        }
    }

    let channel_for_task = channel.clone();
    let out_dir_for_task = out_dir.clone();
    tokio::spawn(async move {
        let outcome = spawn_abliterator(&python_exe, &argv, &channel_for_task).await;
        match outcome {
            Ok(()) => {
                let _ = channel_for_task.send(AbliterateEvent::Finished {
                    output_dir: out_dir_for_task.to_string_lossy().into_owned(),
                });
            }
            Err(e) => {
                let _ = channel_for_task.send(AbliterateEvent::Failed { error: e });
            }
        }
    });

    Ok(())
}

async fn spawn_abliterator(
    python_exe: &str,
    argv: &[String],
    channel: &Channel<AbliterateEvent>,
) -> Result<(), String> {
    use tokio::io::AsyncBufReadExt;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Reuse the trainer's WSL-aware command builder: on Windows the env's
    // python is a POSIX/WSL path that must run via `wsl.exe -- bash -lc` with
    // /mnt-translated args. Spawning it directly as a Windows process gave
    // "The system cannot find the path specified (os error 3)". Empty CUDA
    // string = no pinning; abliterate uses whatever GPU torch selects.
    let mut cmd = build_trainer_command(python_exe, argv, "")?;
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn python: {e}"))?;
    let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "no stderr".to_string())?;
    let ch_out = channel.clone();
    let stdout_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            on_abliterate_line(&ch_out, "stdout", &line);
        }
    });
    let ch_err = channel.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            on_abliterate_line(&ch_err, "stderr", &line);
        }
    });
    let status = child.wait().await.map_err(|e| format!("wait: {e}"))?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;
    if !status.success() {
        return Err(format!(
            "abliterate exited with code {}",
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".into())
        ));
    }
    Ok(())
}

fn on_abliterate_line(ch: &Channel<AbliterateEvent>, stream: &str, line: &str) {
    let trimmed = line.trim();
    if trimmed.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
            let stage = v
                .get("event")
                .and_then(|e| e.as_str())
                .unwrap_or("?")
                .to_string();
            let step = v.get("step").and_then(|e| e.as_u64());
            let total = v.get("total").and_then(|e| e.as_u64());
            // Compose a short human-readable detail from the rest.
            let detail = v
                .as_object()
                .map(|m| {
                    let mut parts: Vec<String> = Vec::new();
                    for (k, val) in m {
                        if k == "event" || k == "step" || k == "total" {
                            continue;
                        }
                        parts.push(format!("{k}={}", val));
                    }
                    parts.join(" ")
                })
                .filter(|s| !s.is_empty());
            let _ = ch.send(AbliterateEvent::Progress {
                stage,
                step,
                total,
                detail,
            });
            return;
        }
    }
    let _ = ch.send(AbliterateEvent::Log {
        stream: stream.to_string(),
        line: line.to_string(),
    });
}

// ---------------------------------------------------------------------
// GGUF export — runs llama.cpp's convert_hf_to_gguf.py against a
// transformers-format directory (a fine-tuned LoRA-merged checkpoint,
// an abliterated model, or any local HF dir) and writes a .gguf next
// to it. Re-uses the AbliterateEvent shape since the UX is identical:
// streaming progress lines + a final Finished/Failed.
// ---------------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GgufExportConfig {
    /// Transformers-format directory (the source).
    pub source_dir: String,
    /// Optional output .gguf path. When omitted, defaults to
    /// <source_dir>/<basename>-f16.gguf so the user finds it next to
    /// the original weights.
    pub output_path: Option<String>,
    /// Optional output dtype passed to convert_hf_to_gguf.py via
    /// --outtype. Defaults to "f16" — lossless on most architectures.
    pub outtype: Option<String>,
}

#[tauri::command]
pub async fn export_gguf(
    config: GgufExportConfig,
    channel: Channel<AbliterateEvent>,
) -> Result<(), String> {
    // Emit a synthetic Log line immediately so the UI sees activity
    // before the python process even starts (convert_hf_to_gguf.py
    // takes 5-15s to import transformers before its first stderr line,
    // which made the click feel dead).
    let say = |line: &str| {
        let _ = channel.send(AbliterateEvent::Log {
            stream: "stdout".into(),
            line: line.to_string(),
        });
    };
    say(&format!("[export-gguf] source = {}", config.source_dir));
    let src = std::path::PathBuf::from(&config.source_dir);
    if !src.is_dir() {
        let msg = format!("source_dir not a directory: {}", src.display());
        say(&format!("ERROR: {msg}"));
        return Err(msg);
    }
    // Find a llamacpp env python.exe — that's where convert_hf_to_gguf.py
    // ships (bundled with the gguf pip package).
    let root = crate::paths::llm_root().ok_or_else(|| "could not resolve LLM root".to_string())?;
    let envs_dir = root.join(".envs");
    say(&format!(
        "[export-gguf] scanning envs at {}",
        envs_dir.display()
    ));
    let mut python_exe: Option<std::path::PathBuf> = None;
    let mut convert_py: Option<std::path::PathBuf> = None;
    if let Ok(entries) = std::fs::read_dir(&envs_dir) {
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name.contains("dedicated") {
                continue;
            }
            if !name.starts_with("llamacpp") {
                continue;
            }
            let venv_py = p.join(".venv").join("Scripts").join("python.exe");
            if venv_py.is_file() {
                candidates.push(venv_py);
            }
        }
        candidates.sort_by(|a, b| b.cmp(a)); // stable > edge
        say(&format!(
            "[export-gguf] found {} llamacpp env(s)",
            candidates.len()
        ));
        for c in &candidates {
            say(&format!("  candidate: {}", c.display()));
        }
        if let Some(py) = candidates.first() {
            // convert_hf_to_gguf.py lives under .venv/Lib/site-packages/bin/
            let conv = py
                .parent()
                .and_then(|p| p.parent()) // .venv/
                .map(|venv| {
                    venv.join("Lib")
                        .join("site-packages")
                        .join("bin")
                        .join("convert_hf_to_gguf.py")
                });
            if let Some(c) = conv {
                say(&format!("[export-gguf] checking {}", c.display()));
                if c.is_file() {
                    convert_py = Some(c);
                    python_exe = Some(py.clone());
                } else {
                    say(&format!(
                        "ERROR: convert_hf_to_gguf.py not at expected path: {}",
                        c.display()
                    ));
                }
            }
        }
    } else {
        say(&format!("ERROR: could not read {}", envs_dir.display()));
    }
    let python_exe = python_exe.ok_or_else(|| {
        let msg = "No llamacpp env with convert_hf_to_gguf.py found. Install one via Server → Environment.".to_string();
        say(&format!("ERROR: {msg}"));
        msg
    })?;
    let convert_py = convert_py.unwrap();

    let outtype_raw = config.outtype.unwrap_or_else(|| "f16".to_string());
    // convert_hf_to_gguf.py natively writes f32/f16/bf16/q8_0/auto.
    // Everything else (Q*_K_M, IQ*) needs llama-quantize as a
    // post-step: convert to f16 first, then quantize. Decide which
    // path we're on up-front so we can compute the right output
    // filename and the user gets a single final .gguf they can serve.
    let outtype_lower = outtype_raw.to_ascii_lowercase();
    let is_native = matches!(
        outtype_lower.as_str(),
        "f32" | "f16" | "bf16" | "q8_0" | "auto"
    );

    let basename = src
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("model")
        .to_string();
    let final_out_path = if let Some(p) = config.output_path.as_deref().filter(|s| !s.is_empty()) {
        std::path::PathBuf::from(p)
    } else {
        // Use the user-visible quant tag (uppercase) in the filename
        // so the Tuned tab clearly shows what they got — Q4_K_M.gguf
        // is more useful than q4_k_m.gguf.
        src.join(format!("{basename}-{}.gguf", outtype_raw.to_uppercase()))
    };
    // When we're going through the 2-step pipeline (convert → quantize)
    // the convert pass writes an f16 intermediate; llama-quantize
    // then rewrites it into the final K-quant. Keep the intermediate
    // next to the final output for predictability.
    let f16_tmp_path = if is_native {
        final_out_path.clone()
    } else {
        src.join(format!("{basename}-f16.tmp.gguf"))
    };
    let convert_outtype = if is_native {
        outtype_lower.clone()
    } else {
        "f16".to_string()
    };

    let argv: Vec<String> = vec![
        convert_py.to_string_lossy().into_owned(),
        src.to_string_lossy().into_owned(),
        "--outfile".into(),
        f16_tmp_path.to_string_lossy().into_owned(),
        "--outtype".into(),
        convert_outtype.clone(),
    ];
    say(&format!("[export-gguf] python = {}", python_exe.display()));
    say(&format!(
        "[export-gguf] outfile = {}",
        final_out_path.display()
    ));
    say(&format!("[export-gguf] argv = {}", argv.join(" ")));
    if !is_native {
        say(&format!(
            "[export-gguf] 2-step pipeline: convert→f16 then llama-quantize→{}",
            outtype_raw.to_uppercase()
        ));
    }

    let channel_for_task = channel.clone();
    let final_out_for_task = final_out_path.clone();
    let f16_tmp_for_task = f16_tmp_path.clone();
    let python_str = python_exe.to_string_lossy().into_owned();
    let convert_py_str = convert_py.to_string_lossy().into_owned();
    let outtype_for_task = outtype_raw.clone();
    let is_native_task = is_native;
    tokio::spawn(async move {
        // Preflight: run `python <convert_py> --help` first. If it
        // bombs with a gguf-package version mismatch (e.g.
        // "AttributeError: MISTRAL4" because the shipped script
        // expects a newer gguf than is installed), auto-upgrade gguf
        // in this venv and retry once. This makes the env self-heal
        // without the user needing to know about pip.
        if let Err(reason) =
            preflight_convert(&python_str, &convert_py_str, &channel_for_task).await
        {
            let _ = channel_for_task.send(AbliterateEvent::Failed { error: reason });
            return;
        }
        let _ = channel_for_task.send(AbliterateEvent::Log {
            stream: "stdout".into(),
            line: "[export-gguf] spawning convert_hf_to_gguf.py… (transformers import takes 5-15s before first log)".into(),
        });
        let outcome = spawn_gguf_exporter(&python_str, &argv, &channel_for_task).await;
        if let Err(e) = outcome {
            let _ = channel_for_task.send(AbliterateEvent::Failed { error: e });
            return;
        }
        // Native target — convert wrote the final file directly.
        if is_native_task {
            let _ = channel_for_task.send(AbliterateEvent::Finished {
                output_dir: final_out_for_task.to_string_lossy().into_owned(),
            });
            return;
        }
        // K-quant target — run llama-quantize on the f16 intermediate.
        let _ = channel_for_task.send(AbliterateEvent::Log {
            stream: "stdout".into(),
            line: format!(
                "[export-gguf] quantizing f16 → {} via llama-quantize…",
                outtype_for_task.to_uppercase()
            ),
        });
        let q_outcome = spawn_llama_quantize(
            &f16_tmp_for_task,
            &final_out_for_task,
            &outtype_for_task,
            &channel_for_task,
        )
        .await;
        // Best-effort cleanup of the f16 intermediate so the user's
        // disk doesn't gain 28 GB of scratch per export.
        if f16_tmp_for_task != final_out_for_task {
            let _ = std::fs::remove_file(&f16_tmp_for_task);
        }
        match q_outcome {
            Ok(()) => {
                let _ = channel_for_task.send(AbliterateEvent::Finished {
                    output_dir: final_out_for_task.to_string_lossy().into_owned(),
                });
            }
            Err(e) => {
                let _ = channel_for_task.send(AbliterateEvent::Failed { error: e });
            }
        }
    });

    Ok(())
}

/// Run `llama-quantize.exe <input> <output> <type>` and forward its
/// stdout/stderr to the same channel the convert step uses, so the
/// UI's logs panel sees the whole pipeline in one place.
async fn spawn_llama_quantize(
    f16_path: &std::path::Path,
    out_path: &std::path::Path,
    quant_type: &str,
    channel: &Channel<AbliterateEvent>,
) -> Result<(), String> {
    use tokio::io::AsyncBufReadExt;
    use tokio::process::Command;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let exe = crate::paths::llama_quantize_exe()
        .ok_or_else(|| "llama-quantize.exe not found under LLM/runtime/llama.cpp/".to_string())?;
    let _ = channel.send(AbliterateEvent::Log {
        stream: "stdout".into(),
        line: format!(
            "[export-gguf] {} {} {} {}",
            exe.display(),
            f16_path.display(),
            out_path.display(),
            quant_type.to_uppercase()
        ),
    });
    let mut cmd = Command::new(&exe);
    cmd.arg(f16_path)
        .arg(out_path)
        .arg(quant_type.to_uppercase())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn llama-quantize: {e}"))?;
    let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "no stderr".to_string())?;
    let ch_out = channel.clone();
    let stdout_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = ch_out.send(AbliterateEvent::Log {
                stream: "stdout".into(),
                line,
            });
        }
    });
    let ch_err = channel.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = ch_err.send(AbliterateEvent::Log {
                stream: "stderr".into(),
                line,
            });
        }
    });
    let status = child
        .wait()
        .await
        .map_err(|e| format!("wait llama-quantize: {e}"))?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;
    if !status.success() {
        return Err(format!(
            "llama-quantize exited with code {}",
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".into())
        ));
    }
    Ok(())
}

/// Quick disk-walk to estimate a transformers-format model's weight
/// size — used by the React Export-GGUF picker to color quant options
/// by VRAM fit. Returns the sum of all *.safetensors and *.bin file
/// sizes inside the dir (one level deep).
#[tauri::command]
pub async fn hf_dir_weight_bytes(path: String) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || -> Result<u64, String> {
        let p = std::path::PathBuf::from(&path);
        if !p.is_dir() {
            return Err(format!("not a directory: {path}"));
        }
        let mut total: u64 = 0;
        for entry in std::fs::read_dir(&p).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let fp = entry.path();
            if !fp.is_file() {
                continue;
            }
            let name = fp
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if name.ends_with(".safetensors") || name.ends_with(".bin") {
                if let Ok(m) = std::fs::metadata(&fp) {
                    total = total.saturating_add(m.len());
                }
            }
        }
        Ok(total)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Preflight check: convert_hf_to_gguf.py crashes at import time when
/// the installed gguf pip package is older than the script expects
/// (script references gguf.MODEL_ARCH.MISTRAL4, package is 0.18.0
/// which only has up to MISTRAL3, etc). Run `python <convert> --help`
/// to flush imports; if it fails with a MODEL_ARCH AttributeError,
/// `pip install -U gguf` and retry once.
async fn preflight_convert(
    python_exe: &str,
    convert_py: &str,
    channel: &Channel<AbliterateEvent>,
) -> Result<(), String> {
    use tokio::io::AsyncBufReadExt;
    use tokio::process::Command;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let say = |line: &str| {
        let _ = channel.send(AbliterateEvent::Log {
            stream: "stdout".into(),
            line: line.to_string(),
        });
    };
    let warn = |line: &str| {
        let _ = channel.send(AbliterateEvent::Log {
            stream: "stderr".into(),
            line: line.to_string(),
        });
    };

    let run_probe = || async {
        let mut cmd = Command::new(python_exe);
        cmd.arg(convert_py)
            .arg("--help")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::null());
        cmd.env("PYTHONUNBUFFERED", "1");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("preflight spawn: {e}"))?;
        let stderr = child.stderr.take().ok_or_else(|| "no stderr".to_string())?;
        let stderr_task = tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stderr).lines();
            let mut buf = String::new();
            while let Ok(Some(line)) = reader.next_line().await {
                buf.push_str(&line);
                buf.push('\n');
            }
            buf
        });
        let status = child
            .wait()
            .await
            .map_err(|e| format!("preflight wait: {e}"))?;
        let stderr_buf = stderr_task.await.unwrap_or_default();
        Ok::<(bool, String), String>((status.success(), stderr_buf))
    };

    say("[export-gguf] preflight: importing convert_hf_to_gguf.py + gguf …");
    let (ok, stderr_buf) = run_probe().await?;
    if ok {
        say("[export-gguf] preflight ok — gguf package in sync with convert script");
        return Ok(());
    }

    // Look for the specific failure mode we know how to fix.
    let stderr_lc = stderr_buf.to_ascii_lowercase();
    let looks_like_gguf_mismatch = stderr_lc.contains("model_arch")
        || (stderr_lc.contains("gguf") && stderr_lc.contains("attributeerror"));

    for line in stderr_buf.lines() {
        warn(line);
    }

    if !looks_like_gguf_mismatch {
        return Err(format!(
            "preflight failed and the error doesn't look like a gguf version mismatch — see logs above"
        ));
    }

    say("[export-gguf] gguf package is out-of-date relative to convert_hf_to_gguf.py");
    say("[export-gguf] auto-fixing: pip install -U gguf in the llamacpp venv …");

    // pip install -U gguf
    let mut cmd = Command::new(python_exe);
    cmd.args(["-m", "pip", "install", "-U", "gguf"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    cmd.env("PYTHONUNBUFFERED", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("pip install gguf spawn: {e}"))?;
    let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "no stderr".to_string())?;
    let ch_out = channel.clone();
    let stdout_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = ch_out.send(AbliterateEvent::Log {
                stream: "stdout".into(),
                line: format!("  pip: {line}"),
            });
        }
    });
    let ch_err = channel.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = ch_err.send(AbliterateEvent::Log {
                stream: "stderr".into(),
                line: format!("  pip: {line}"),
            });
        }
    });
    let status = child.wait().await.map_err(|e| format!("pip wait: {e}"))?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;
    if !status.success() {
        return Err(format!(
            "auto-upgrade failed (pip exit code {}). Try `pip install -U gguf` manually in {} ",
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".into()),
            python_exe,
        ));
    }
    say("[export-gguf] pip upgrade ok — re-running preflight …");
    let (ok2, stderr_buf2) = run_probe().await?;
    if ok2 {
        say("[export-gguf] preflight ok after upgrade — proceeding");
        return Ok(());
    }
    for line in stderr_buf2.lines() {
        warn(line);
    }
    Err("preflight still fails after gguf upgrade — see logs above".into())
}

async fn spawn_gguf_exporter(
    python_exe: &str,
    argv: &[String],
    channel: &Channel<AbliterateEvent>,
) -> Result<(), String> {
    use tokio::io::AsyncBufReadExt;
    use tokio::process::Command;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut cmd = Command::new(python_exe);
    cmd.args(argv)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    cmd.env("PYTHONUNBUFFERED", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn python: {e}"))?;
    let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "no stderr".to_string())?;
    // convert_hf_to_gguf.py logs to stderr (Python logging default).
    // Forward both as Log events; the script doesn't emit JSON so we
    // can't synthesize Progress here.
    let ch_out = channel.clone();
    let stdout_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = ch_out.send(AbliterateEvent::Log {
                stream: "stdout".into(),
                line,
            });
        }
    });
    let ch_err = channel.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = ch_err.send(AbliterateEvent::Log {
                stream: "stderr".into(),
                line,
            });
        }
    });
    let status = child.wait().await.map_err(|e| format!("wait: {e}"))?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;
    if !status.success() {
        return Err(format!(
            "gguf export exited with code {}",
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".into())
        ));
    }
    Ok(())
}

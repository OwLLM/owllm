// finetuning — spawn LLM/finetune.py against a verified env profile
// and stream its stdout/stderr to the React TrainPage.
//
// Pipeline:
//   1. UI calls `train_start` with a TrainConfig + env profile name.
//   2. Rust looks up the env profile, confirms it's Ready (matching
//      manifest hash), resolves its venv python.exe.
//   3. Spawn `<venv-python> finetune.py --base ... --dataset ...` with
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
    Started { run_name: String },
    Log { stream: String, line: String },
    /// Parsed from a JSON line on stdout — finetune.py periodically
    /// prints structured progress so the UI can render tiles without
    /// regexing the log.
    Metric {
        step: u64,
        loss: f64,
        learning_rate: f64,
    },
    Finished { output_dir: String },
    Failed { error: String },
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
    last_loss: Option<f64>,
    last_lr: Option<f64>,
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
    last_loss: None,
    last_lr: None,
    log_tail: Vec::new(),
});

/// Start a training run. Returns once the subprocess has been
/// spawned (or immediately on validation failure). Progress events
/// stream over the Channel for the rest of the run.
#[tauri::command]
pub async fn train_start(
    config: TrainConfig,
    channel: Channel<TrainEvent>,
) -> Result<(), String> {
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
    let argv: Vec<String> = vec![
        script.to_string_lossy().into_owned(),
        "--base".into(), config.base_model.clone(),
        "--dataset".into(), config.dataset.clone(),
        "--output-dir".into(), run_dir.to_string_lossy().into_owned(),
        "--run-name".into(), config.run_name.clone(),
        "--epochs".into(), config.epochs.to_string(),
        "--learning-rate".into(), format!("{}", config.learning_rate),
        "--lora-r".into(), config.lora_r.to_string(),
        "--max-seq-len".into(), config.max_seq_len.to_string(),
        "--stop-file".into(), stop_file.to_string_lossy().into_owned(),
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
        st.last_loss = None;
        st.last_lr = None;
        st.log_tail.clear();
    }

    let channel_for_task = channel.clone();
    let run_dir_for_task = run_dir.clone();

    tokio::spawn(async move {
        let outcome = spawn_trainer(
            &python_exe,
            &argv,
            &cuda_devices,
            &channel_for_task,
        )
        .await;
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
    use tokio::process::Command;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut cmd = Command::new(python_exe);
    cmd.args(argv)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    if !cuda_visible_devices.is_empty() {
        cmd.env("CUDA_VISIBLE_DEVICES", cuda_visible_devices);
    }
    // Force unbuffered stdout so progress lines appear in real time
    // (Python aggressively buffers when stdout isn't a tty).
    cmd.env("PYTHONUNBUFFERED", "1");
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
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into())
        ));
    }
    Ok(())
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
    if !trimmed.starts_with('{') {
        return;
    }
    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return,
    };
    let step = value.get("step").and_then(|v| v.as_u64());
    let loss = value.get("loss").and_then(|v| v.as_f64());
    let lr = value
        .get("learning_rate")
        .or_else(|| value.get("lr"))
        .and_then(|v| v.as_f64());
    if let (Some(step), Some(loss), Some(lr)) = (step, loss, lr) {
        let _ = ch.send(TrainEvent::Metric {
            step,
            loss,
            learning_rate: lr,
        });
        if let Ok(mut st) = TRAIN_STATE.lock() {
            st.last_step = Some(step);
            st.last_loss = Some(loss);
            st.last_lr = Some(lr);
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
            Ok(DatasetSummary { count, format: "jsonl".to_string() })
        }
        "json" => {
            let text = std::fs::read_to_string(&p).map_err(|e| format!("read {path}: {e}"))?;
            let v: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| format!("parse {path}: {e}"))?;
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
            Ok(DatasetSummary { count, format: "json".to_string() })
        }
        "csv" => {
            let text = std::fs::read_to_string(&p).map_err(|e| format!("read {path}: {e}"))?;
            // Header + N rows → N examples.
            let total_lines = text.lines().filter(|l| !l.trim().is_empty()).count() as u64;
            let count = total_lines.saturating_sub(1);
            Ok(DatasetSummary { count, format: "csv".to_string() })
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
        state: if st.running { "running".into() } else { "idle".into() },
        run_name: st.run_name.clone(),
        step: st.last_step,
        total_steps: None,
        loss: st.last_loss,
        eval_loss: None,
        learning_rate: st.last_lr,
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
    Progress { stage: String, step: Option<u64>, total: Option<u64>, detail: Option<String> },
    /// Anything that didn't decode as JSON. Forwarded verbatim to a
    /// log tail so import errors surface to the user.
    Log { stream: String, line: String },
    Finished { output_dir: String },
    Failed { error: String },
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
    if python_exe.is_none() {
        if let Some(root) = crate::paths::llm_root() {
            let envs_dir = root.join(".envs");
            if let Ok(entries) = std::fs::read_dir(&envs_dir) {
                // Prefer transformers-style envs (tf-*) over llama.cpp-only
                // ones (llamacpp-*) since abliteration needs torch + HF.
                let mut candidates: Vec<std::path::PathBuf> = Vec::new();
                for e in entries.flatten() {
                    let p = e.path();
                    if !p.is_dir() { continue; }
                    let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                    if name.contains("dedicated") { continue; }
                    if name.starts_with("llamacpp") { continue; }
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
    let script = crate::paths::abliterate_script()
        .ok_or_else(|| "LLM/tools/abliterate.py not found — legacy tree may be incomplete".to_string())?;

    // Output dir — explicit user-provided OR auto-derive into
    // <llm_root>/fine_tuned/ so list_tuned_adapters picks it up
    // automatically and the result appears on the Tuned tab.
    let out_dir = if let Some(d) = config.output_dir.as_deref().filter(|s| !s.is_empty()) {
        std::path::PathBuf::from(d)
    } else {
        let safe = config
            .model
            .replace('/', "__")
            .replace(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-' && c != '.', "_");
        let root = crate::paths::llm_root()
            .ok_or_else(|| "could not resolve LLM root for default output_dir".to_string())?;
        root.join("fine_tuned").join(format!("{safe}__abliterated"))
    };
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("mkdir output {}: {e}", out_dir.display()))?;
    let stop_file = out_dir.join(".stop");

    let argv: Vec<String> = vec![
        script.to_string_lossy().into_owned(),
        "--model".into(), config.model.clone(),
        "--output-dir".into(), out_dir.to_string_lossy().into_owned(),
        "--stop-file".into(), stop_file.to_string_lossy().into_owned(),
    ];

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
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into())
        ));
    }
    Ok(())
}

fn on_abliterate_line(ch: &Channel<AbliterateEvent>, stream: &str, line: &str) {
    let trimmed = line.trim();
    if trimmed.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
            let stage = v.get("event").and_then(|e| e.as_str()).unwrap_or("?").to_string();
            let step = v.get("step").and_then(|e| e.as_u64());
            let total = v.get("total").and_then(|e| e.as_u64());
            // Compose a short human-readable detail from the rest.
            let detail = v
                .as_object()
                .map(|m| {
                    let mut parts: Vec<String> = Vec::new();
                    for (k, val) in m {
                        if k == "event" || k == "step" || k == "total" { continue; }
                        parts.push(format!("{k}={}", val));
                    }
                    parts.join(" ")
                })
                .filter(|s| !s.is_empty());
            let _ = ch.send(AbliterateEvent::Progress { stage, step, total, detail });
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
    let src = std::path::PathBuf::from(&config.source_dir);
    if !src.is_dir() {
        return Err(format!("source_dir not a directory: {}", src.display()));
    }
    // Find a llamacpp env python.exe — that's where convert_hf_to_gguf.py
    // ships (bundled with the gguf pip package).
    let root = crate::paths::llm_root()
        .ok_or_else(|| "could not resolve LLM root".to_string())?;
    let envs_dir = root.join(".envs");
    let mut python_exe: Option<std::path::PathBuf> = None;
    let mut convert_py: Option<std::path::PathBuf> = None;
    if let Ok(entries) = std::fs::read_dir(&envs_dir) {
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() { continue; }
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name.contains("dedicated") { continue; }
            if !name.starts_with("llamacpp") { continue; }
            let venv_py = p.join(".venv").join("Scripts").join("python.exe");
            if venv_py.is_file() {
                candidates.push(venv_py);
            }
        }
        candidates.sort_by(|a, b| b.cmp(a)); // stable > edge
        if let Some(py) = candidates.first() {
            // convert_hf_to_gguf.py lives under .venv/Lib/site-packages/bin/
            let conv = py
                .parent().and_then(|p| p.parent()) // .venv/
                .map(|venv| venv.join("Lib").join("site-packages").join("bin").join("convert_hf_to_gguf.py"));
            if let Some(c) = conv {
                if c.is_file() {
                    convert_py = Some(c);
                    python_exe = Some(py.clone());
                }
            }
        }
    }
    let python_exe = python_exe.ok_or_else(|| {
        "No llamacpp env with convert_hf_to_gguf.py found. Install one via Server → Environment.".to_string()
    })?;
    let convert_py = convert_py.unwrap();

    let outtype = config.outtype.unwrap_or_else(|| "f16".to_string());
    let out_path = if let Some(p) = config.output_path.as_deref().filter(|s| !s.is_empty()) {
        std::path::PathBuf::from(p)
    } else {
        let base = src
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("model");
        src.join(format!("{base}-{outtype}.gguf"))
    };

    let argv: Vec<String> = vec![
        convert_py.to_string_lossy().into_owned(),
        src.to_string_lossy().into_owned(),
        "--outfile".into(), out_path.to_string_lossy().into_owned(),
        "--outtype".into(), outtype.clone(),
    ];

    let channel_for_task = channel.clone();
    let out_path_for_task = out_path.clone();
    tokio::spawn(async move {
        let outcome = spawn_gguf_exporter(&python_exe.to_string_lossy(), &argv, &channel_for_task).await;
        match outcome {
            Ok(()) => {
                let _ = channel_for_task.send(AbliterateEvent::Finished {
                    output_dir: out_path_for_task.to_string_lossy().into_owned(),
                });
            }
            Err(e) => {
                let _ = channel_for_task.send(AbliterateEvent::Failed { error: e });
            }
        }
    });

    Ok(())
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
            let _ = ch_out.send(AbliterateEvent::Log { stream: "stdout".into(), line });
        }
    });
    let ch_err = channel.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = ch_err.send(AbliterateEvent::Log { stream: "stderr".into(), line });
        }
    });
    let status = child.wait().await.map_err(|e| format!("wait: {e}"))?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;
    if !status.success() {
        return Err(format!(
            "gguf export exited with code {}",
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into())
        ));
    }
    Ok(())
}

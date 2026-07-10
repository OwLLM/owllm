// Voice-transcription pipeline — hybrid Rust + downloaded whisper.cpp.
//
//   Audio decode: pure-Rust via `symphonia`. Handles mp3 / m4a / wav /
//                 ogg-vorbis / flac. Replaces the old ffmpeg subprocess.
//                 Opus (Telegram voice) is NOT supported by symphonia
//                 0.5; if it ever ships add the companion crate.
//
//   Transcription: spawn the whisper.cpp `main` (a.k.a. `whisper-cli`)
//                  binary downloaded into <runtime_cache>/whisper.cpp/
//                  on first run. Cross-platform via the upstream
//                  GitHub releases ZIP for Windows; Mac/Linux fall
//                  back to PATH detection (brew/apt) until we wire
//                  per-platform binary downloads.
//
//   Model: ggml-base.bin from huggingface.co/ggerganov/whisper.cpp.
//          Single 142 MB file, OS-agnostic.
//
// The two assets (binary + model) install separately. The UI calls
// whisper_runtime_status() to see what's missing, then
// whisper_runtime_install() to fetch both with progress events.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use symphonia::core::audio::{AudioBufferRef, Signal as _};
use symphonia::core::codecs::{CodecRegistry, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::Emitter;
use tokio::process::Command;

/// Combined codec registry — symphonia's defaults (mp3, aac, vorbis,
/// flac, wav, …) PLUS the opus decoder from symphonia-adapter-libopus.
/// Telegram voice messages are opus-in-ogg; without the opus adapter
/// they fail decode init with "unsupported codec".
fn codecs() -> &'static CodecRegistry {
    static REG: once_cell::sync::OnceCell<CodecRegistry> = once_cell::sync::OnceCell::new();
    REG.get_or_init(|| {
        let mut r = CodecRegistry::new();
        // Populate with every enabled symphonia codec (mp3, aac,
        // vorbis, …) then layer the opus adapter on top.
        symphonia::default::register_enabled_codecs(&mut r);
        r.register_all::<symphonia_adapter_libopus::OpusDecoder>();
        r
    })
}

const WHISPER_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
const WHISPER_MODEL_NAME: &str = "ggml-base.bin";
/// Minimum expected size for ggml-base.bin (~142 MB). Anything smaller
/// is treated as a truncated download and ignored.
const WHISPER_MODEL_MIN_BYTES: u64 = 130 * 1024 * 1024;

/// Pinned whisper.cpp release tag. Bumped manually after testing —
/// the API around `-m / -f / -otxt / -of` has been stable for years
/// so version drift is mostly cosmetic. Note: the project moved
/// from `ggerganov/whisper.cpp` to `ggml-org/whisper.cpp` during the
/// 1.7→1.8 transition; the old release tag URLs return 404 so we
/// have to point at the new org.
const WHISPER_CPP_TAG: &str = "v1.8.4";
/// Windows-x64 zip from the upstream release. Contains main.exe +
/// supporting DLLs. About 6 MB. NOTE: this download path is only the
/// fallback for users whose installer didn't ship the bundled
/// runtime (see resources/runtime/whisper.cpp/ in CI). Most users
/// will never hit it because find_whisper_cli() picks up the
/// pre-bundled binary from resources_root() first.
const WHISPER_CPP_WIN_URL: &str =
    "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-bin-x64.zip";

#[derive(Deserialize, Serialize)]
pub struct AudioTranscription {
    pub text: String,
    pub duration_sec: f64,
    pub model: String,
}

#[derive(Serialize)]
pub struct WhisperRuntimeStatus {
    /// True once the model is on disk at the expected path AND passes
    /// the truncated-download size check.
    pub model_installed: bool,
    /// Absolute path the model is (or will be) at.
    pub model_path: String,
    /// Bytes on disk; 0 if the file doesn't exist.
    pub model_bytes: u64,
    /// True once whisper-cli is findable (downloaded bundle, PATH, or
    /// OWLLM_WHISPER_CLI override).
    pub binary_installed: bool,
    /// Resolved path to the whisper-cli binary (empty when missing).
    pub binary_path: String,
    /// True when the running OS has an automated downloader. Mac/Linux
    /// users have to `brew install whisper-cpp` / `apt install
    /// whisper-cpp` for now; the UI surfaces this hint.
    pub binary_auto_install: bool,
}

fn whisper_root() -> Result<PathBuf, String> {
    let runtime_root = crate::paths::runtime_root()
        .ok_or_else(|| "could not resolve runtime cache root".to_string())?;
    let dir = runtime_root.join("whisper.cpp");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Path the installer downloads the model to (writeable cache).
fn model_install_path() -> Result<PathBuf, String> {
    Ok(whisper_root()?.join(WHISPER_MODEL_NAME))
}

/// Path where audio_transcribe_local LOOKS for the model — preferred
/// order: bundled-in-installer → cache → env override.
fn find_model() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_WHISPER_MODEL_PATH") {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Some(path);
        }
    }
    if let Some(res) = crate::paths::resources_root() {
        let p = res
            .join("runtime")
            .join("whisper.cpp")
            .join(WHISPER_MODEL_NAME);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(rt) = whisper_root() {
        let p = rt.join(WHISPER_MODEL_NAME);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

#[tauri::command]
pub fn whisper_runtime_status() -> Result<WhisperRuntimeStatus, String> {
    let resolved = find_model();
    let (model_path, bytes) = match &resolved {
        Some(p) => (
            p.to_string_lossy().to_string(),
            std::fs::metadata(p).map(|m| m.len()).unwrap_or(0),
        ),
        None => {
            // Show the cache target so the user knows where the
            // install-on-click button will drop the file.
            let mp = model_install_path()?;
            (mp.to_string_lossy().to_string(), 0)
        }
    };
    let model_installed = bytes >= WHISPER_MODEL_MIN_BYTES;

    let binary = find_whisper_cli();
    let binary_path = binary
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(WhisperRuntimeStatus {
        model_installed,
        model_path,
        model_bytes: bytes,
        binary_installed: binary.is_some(),
        binary_path,
        binary_auto_install: cfg!(target_os = "windows"),
    })
}

/// Installs both the whisper.cpp binary (Windows only — Mac/Linux
/// users get a clear error pointing at brew/apt) and the ggml-base.bin
/// model file. Emits `owllm:whisper:install:progress` events along the
/// way so the UI can render a progress bar with phase labels.
#[tauri::command]
pub async fn whisper_runtime_install(
    app: tauri::AppHandle,
) -> Result<WhisperRuntimeStatus, String> {
    // 1) Binary — only auto-installable on Windows for now.
    if find_whisper_cli().is_none() {
        if cfg!(target_os = "windows") {
            emit_progress(&app, "binary", 0, 0, false);
            install_whisper_binary_windows(&app).await?;
            emit_progress(&app, "binary", 1, 1, true);
        } else {
            return Err(
                "Whisper binary not detected. Install via your package manager: \
                 macOS → `brew install whisper-cpp ffmpeg`, \
                 Linux → `apt install whisper-cpp ffmpeg` (or the equivalent for your distro)."
                    .into(),
            );
        }
    } else {
        emit_progress(&app, "binary", 1, 1, true);
    }

    // 2) Model — same on every OS. Skip if the bundled installer
    //    already shipped one; otherwise HF download into the cache.
    if let Some(existing) = find_model() {
        let bytes = std::fs::metadata(&existing).map(|m| m.len()).unwrap_or(0);
        emit_progress(&app, "model", bytes, bytes, true);
    } else {
        let mp = model_install_path()?;
        download_model_file(&app, &mp).await?;
    }

    whisper_runtime_status()
}

fn emit_progress(app: &tauri::AppHandle, phase: &str, done: u64, total: u64, finished: bool) {
    let _ = app.emit(
        "owllm:whisper:install:progress",
        serde_json::json!({
            "phase": phase,
            "downloaded": done,
            "total": total,
            "done": finished,
        }),
    );
}

async fn install_whisper_binary_windows(app: &tauri::AppHandle) -> Result<(), String> {
    use futures_util::StreamExt;
    use std::io::Write as _;
    let dir = whisper_root()?;
    let tmp_zip = dir.join("whisper-bin-x64.downloading.zip");
    let _ = std::fs::remove_file(&tmp_zip);
    let client = reqwest::Client::builder()
        .user_agent("OwLLM-Desktop")
        .build()
        .map_err(|e| format!("reqwest: {e}"))?;
    let resp = client
        .get(WHISPER_CPP_WIN_URL)
        .send()
        .await
        .map_err(|e| format!("GET {WHISPER_CPP_WIN_URL}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "GET {WHISPER_CPP_WIN_URL}: HTTP {}",
            resp.status().as_u16()
        ));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();
    let mut file = std::fs::File::create(&tmp_zip)
        .map_err(|e| format!("create {}: {e}", tmp_zip.display()))?;
    let mut last_emit = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download chunk: {e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("write {}: {e}", tmp_zip.display()))?;
        downloaded += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(100) {
            emit_progress(app, "binary", downloaded, total, false);
            last_emit = std::time::Instant::now();
        }
    }
    file.flush()
        .map_err(|e| format!("flush {}: {e}", tmp_zip.display()))?;
    drop(file);

    // Unzip into the whisper.cpp dir, stripping the top-level folder
    // the upstream zip uses (`whisper-bin-x64/` → `whisper.cpp/`).
    let zip_bytes = std::fs::read(&tmp_zip).map_err(|e| format!("read zip: {e}"))?;
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("open zip: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip entry {i}: {e}"))?;
        let entry_path = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue,
        };
        // Strip leading dir component if present.
        let rel = strip_first_component(&entry_path);
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out_path = dir.join(&rel);
        if entry.is_dir() {
            let _ = std::fs::create_dir_all(&out_path);
            continue;
        }
        if let Some(parent) = out_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut out = std::fs::File::create(&out_path)
            .map_err(|e| format!("create {}: {e}", out_path.display()))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("extract {}: {e}", out_path.display()))?;
    }
    let _ = std::fs::remove_file(&tmp_zip);

    if find_whisper_cli().is_none() {
        return Err(format!(
            "Whisper binary downloaded to {} but no main.exe / whisper-cli.exe found in the archive. \
             The upstream layout may have changed — pin a known-good {WHISPER_CPP_TAG} build manually.",
            dir.display()
        ));
    }
    Ok(())
}

fn strip_first_component(p: &Path) -> PathBuf {
    let mut comps = p.components();
    let _ = comps.next();
    comps.as_path().to_path_buf()
}

async fn download_model_file(app: &tauri::AppHandle, dst: &Path) -> Result<(), String> {
    use futures_util::StreamExt;
    use std::io::Write as _;
    let tmp = dst.with_extension("downloading");
    let _ = std::fs::remove_file(&tmp);
    let client = reqwest::Client::builder()
        .user_agent("OwLLM-Desktop")
        .build()
        .map_err(|e| format!("reqwest: {e}"))?;
    let resp = client
        .get(WHISPER_MODEL_URL)
        .send()
        .await
        .map_err(|e| format!("GET {WHISPER_MODEL_URL}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "GET {WHISPER_MODEL_URL}: HTTP {}",
            resp.status().as_u16()
        ));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();
    let mut file =
        std::fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
    let mut last_emit = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download chunk: {e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        downloaded += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(100) {
            emit_progress(app, "model", downloaded, total, false);
            last_emit = std::time::Instant::now();
        }
    }
    file.flush()
        .map_err(|e| format!("flush {}: {e}", tmp.display()))?;
    drop(file);
    let bytes = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    if bytes < WHISPER_MODEL_MIN_BYTES {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "downloaded only {bytes} bytes (need at least {WHISPER_MODEL_MIN_BYTES}) — please retry"
        ));
    }
    std::fs::rename(&tmp, dst)
        .map_err(|e| format!("rename {} -> {}: {e}", tmp.display(), dst.display()))?;
    emit_progress(app, "model", bytes, bytes, true);
    Ok(())
}

#[tauri::command]
pub async fn audio_transcribe_local(
    data_b64: String,
    mime: String,
    filename: Option<String>,
) -> Result<AudioTranscription, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("decode audio base64: {e}"))?;
    if bytes.is_empty() {
        return Err("empty audio attachment".to_string());
    }
    if bytes.len() > 50 * 1024 * 1024 {
        return Err(format!(
            "audio too large: {} bytes (max 50 MB)",
            bytes.len()
        ));
    }

    let model = find_model().ok_or_else(|| {
        "Whisper model not installed yet — open Accounts → \"Install voice runtime\" \
         (or call whisper_runtime_install)."
            .to_string()
    })?;
    let whisper = find_whisper_cli().ok_or_else(|| {
        "Whisper binary not detected. On Windows: open Settings → Voice → \"Install voice runtime\". \
         On macOS: `brew install whisper-cpp`. On Linux: install via your package manager."
            .to_string()
    })?;

    // 1) Decode whatever-the-bot-sent-us into 16 kHz mono f32 samples,
    //    then write as 16-bit PCM WAV so whisper-cli's `-f` can read it.
    let (samples, duration_sec) = tokio::task::spawn_blocking({
        let mime = mime.clone();
        let filename = filename.clone();
        move || decode_to_pcm(&bytes, &mime, filename.as_deref())
    })
    .await
    .map_err(|e| format!("decode task panicked: {e}"))??;

    let work_dir = std::env::temp_dir().join("owllm-audio");
    std::fs::create_dir_all(&work_dir).map_err(|e| format!("mkdir {}: {e}", work_dir.display()))?;
    let wav_path = work_dir.join(format!("voice-{}.wav", uuid::Uuid::new_v4()));
    write_wav_16k_mono(&wav_path, &samples).map_err(|e| format!("write wav: {e}"))?;

    let out_base = work_dir.join(format!("transcript-{}", uuid::Uuid::new_v4()));
    let transcript_path = out_base.with_extension("txt");
    let mut cmd = Command::new(&whisper);
    cmd.arg("-m")
        .arg(&model)
        .arg("-f")
        .arg(&wav_path)
        .arg("-otxt")
        .arg("-of")
        .arg(&out_base)
        .arg("-l")
        .arg("auto")
        .arg("-nt");
    hide_window(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(600), cmd.output())
        .await
        .map_err(|_| "whisper-cli timed out after 10 minutes".to_string())?
        .map_err(|e| format!("spawn {}: {e}", whisper.display()))?;

    let _ = std::fs::remove_file(&wav_path);
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let _ = std::fs::remove_file(&transcript_path);
        return Err(format!(
            "whisper-cli failed via {}: {}",
            whisper.display(),
            err.trim().chars().take(800).collect::<String>()
        ));
    }

    let text = std::fs::read_to_string(&transcript_path)
        .or_else(|_| Ok::<_, std::io::Error>(String::from_utf8_lossy(&out.stdout).into_owned()))
        .map_err(|e| format!("read transcript {}: {e}", transcript_path.display()))?
        .trim()
        .to_string();
    let _ = std::fs::remove_file(&transcript_path);
    Ok(AudioTranscription {
        text,
        duration_sec,
        model: WHISPER_MODEL_NAME.to_string(),
    })
}

/// Decode arbitrary container/codec via symphonia → 16 kHz mono f32.
/// Returns (samples, duration_sec).
fn decode_to_pcm(
    bytes: &[u8],
    mime: &str,
    filename: Option<&str>,
) -> Result<(Vec<f32>, f64), String> {
    let cursor = std::io::Cursor::new(bytes.to_vec());
    let mss = MediaSourceStream::new(Box::new(cursor), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = filename.and_then(|n| n.rsplit('.').next()) {
        hint.with_extension(&ext.to_ascii_lowercase());
    }
    let mt = mime_to_symphonia(mime);
    if !mt.is_empty() {
        hint.mime_type(mt);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("probe (mime={mime}): {e}"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "no audio track in input".to_string())?;
    let track_id = track.id;
    let mut decoder = codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("decoder init: {e}"))?;

    let src_rate = track.codec_params.sample_rate.unwrap_or(16_000) as f32;
    let src_channels = track
        .codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(1)
        .max(1);

    let mut mono: Vec<f32> = Vec::with_capacity(1024 * 1024);
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(e) => return Err(format!("read packet: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buf) => append_mono_samples(buf, src_channels, &mut mono),
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(format!("decode: {e}")),
        }
    }

    let resampled = if (src_rate - 16_000.0).abs() < 1.0 {
        mono
    } else {
        linear_resample(&mono, src_rate, 16_000.0)
    };
    if resampled.is_empty() {
        return Err("decoder produced 0 samples — file likely corrupt".to_string());
    }
    let duration = resampled.len() as f64 / 16_000.0;
    Ok((resampled, duration))
}

fn append_mono_samples(buf: AudioBufferRef<'_>, src_channels: usize, out: &mut Vec<f32>) {
    use symphonia::core::audio::AudioBufferRef::*;
    macro_rules! mix {
        ($buf:expr, $cast:expr) => {{
            let n = $buf.frames();
            for i in 0..n {
                let mut sum = 0f32;
                for ch in 0..src_channels {
                    sum += $cast($buf.chan(ch)[i]);
                }
                out.push(sum / src_channels as f32);
            }
        }};
    }
    match buf {
        F32(b) => mix!(b, |s: f32| s),
        F64(b) => mix!(b, |s: f64| s as f32),
        S8(b) => mix!(b, |s: i8| (s as f32) / (i8::MAX as f32)),
        S16(b) => mix!(b, |s: i16| (s as f32) / (i16::MAX as f32)),
        S24(b) => mix!(b, |s: symphonia::core::sample::i24| (s.0 as f32)
            / 8_388_608.0),
        S32(b) => mix!(b, |s: i32| (s as f32) / (i32::MAX as f32)),
        U8(b) => mix!(b, |s: u8| ((s as i16 - 128) as f32) / 128.0),
        U16(b) => mix!(b, |s: u16| ((s as i32 - 32768) as f32) / 32_768.0),
        U24(b) => mix!(
            b,
            |s: symphonia::core::sample::u24| ((s.0 as i32 - 8_388_608) as f32) / 8_388_608.0
        ),
        U32(b) => mix!(b, |s: u32| ((s as i64 - 2_147_483_648) as f32)
            / 2_147_483_648.0),
    }
}

fn linear_resample(src: &[f32], src_rate: f32, dst_rate: f32) -> Vec<f32> {
    if src.is_empty() || src_rate <= 0.0 || dst_rate <= 0.0 {
        return Vec::new();
    }
    let ratio = src_rate / dst_rate;
    let dst_len = ((src.len() as f32) / ratio) as usize;
    let mut out = Vec::with_capacity(dst_len);
    for i in 0..dst_len {
        let pos = (i as f32) * ratio;
        let i0 = pos.floor() as usize;
        let i1 = (i0 + 1).min(src.len().saturating_sub(1));
        let t = pos - (i0 as f32);
        out.push(src[i0] * (1.0 - t) + src[i1] * t);
    }
    out
}

fn mime_to_symphonia(mime: &str) -> &'static str {
    let m = mime.to_ascii_lowercase();
    if m.contains("mp3") || m.contains("mpeg") {
        "audio/mpeg"
    } else if m.contains("wav") {
        "audio/wav"
    } else if m.contains("ogg") {
        "audio/ogg"
    } else if m.contains("m4a") || m.contains("aac") || m.contains("mp4") {
        "audio/mp4"
    } else if m.contains("flac") {
        "audio/flac"
    } else {
        ""
    }
}

/// Minimal RIFF/WAV writer — 16-bit PCM, 16 kHz, mono. Same shape
/// whisper.cpp's `-f` reader expects so we skip the resample/encode
/// dance the old ffmpeg fallback used to do.
fn write_wav_16k_mono(path: &Path, samples: &[f32]) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut file = std::fs::File::create(path)?;
    let n = samples.len() as u32;
    let byte_rate: u32 = 16_000 * 2;
    let data_size: u32 = n * 2;
    file.write_all(b"RIFF")?;
    file.write_all(&(36 + data_size).to_le_bytes())?;
    file.write_all(b"WAVE")?;
    file.write_all(b"fmt ")?;
    file.write_all(&16u32.to_le_bytes())?; // PCM chunk size
    file.write_all(&1u16.to_le_bytes())?; // audio format = PCM
    file.write_all(&1u16.to_le_bytes())?; // mono
    file.write_all(&16_000u32.to_le_bytes())?; // sample rate
    file.write_all(&byte_rate.to_le_bytes())?; // byte rate
    file.write_all(&2u16.to_le_bytes())?; // block align
    file.write_all(&16u16.to_le_bytes())?; // bits per sample
    file.write_all(b"data")?;
    file.write_all(&data_size.to_le_bytes())?;
    for s in samples {
        let clipped = s.max(-1.0).min(1.0);
        let v = (clipped * 32767.0) as i16;
        file.write_all(&v.to_le_bytes())?;
    }
    Ok(())
}

fn find_whisper_cli() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_WHISPER_CLI") {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Some(path);
        }
    }
    // Search order:
    //   1. <resources>/runtime/whisper.cpp/ — bundled in the installer,
    //      the path most installed users will hit.
    //   2. <runtime_cache>/whisper.cpp/    — downloaded on first run by
    //      whisper_runtime_install (fallback when the installer didn't
    //      ship the runtime, e.g. dev builds, side-loaded artifacts).
    //   3. $PATH                            — covers macOS Homebrew /
    //      Linux distro packages.
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(res) = crate::paths::resources_root() {
        roots.push(res.join("runtime").join("whisper.cpp"));
    }
    if let Ok(rt) = whisper_root() {
        roots.push(rt);
    }
    let names = whisper_cli_names();
    for dir in &roots {
        for name in &names {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
        // Some upstream zips nest under `Release/` or `whisper-bin-x64/`.
        if let Ok(read) = std::fs::read_dir(dir) {
            for entry in read.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    for name in &names {
                        let candidate = p.join(name);
                        if candidate.is_file() {
                            return Some(candidate);
                        }
                    }
                }
            }
        }
    }
    find_on_path(&names)
}

fn find_on_path(names: &[String]) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for name in names {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn whisper_cli_names() -> Vec<String> {
    vec![
        exe_name("whisper-cli"),
        exe_name("main"),
        exe_name("whisper"),
    ]
}

fn exe_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

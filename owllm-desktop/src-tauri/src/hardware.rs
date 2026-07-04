// Hardware probe — native Rust. NO Python. NO console popups.
//
// CPU + RAM come from the `sysinfo` crate (cross-platform). GPU
// discovery is a chain, first hit wins:
//   1. nvidia-smi (Windows + Linux) — real VRAM + stable per-card UUIDs,
//     skips virtual adapters. wmic's AdapterRAM is a 32-bit DWORD that
//     wraps anything > 4 GiB → showed "4 GiB" for a 24 GiB RTX 4090.
//   2. system_profiler (macOS) — Apple Silicon reports UNIFIED memory
//     (the GPU shares system RAM), discrete Macs report VRAM.
//   3. /sys/class/drm sysfs (Linux) — amdgpu/i915 VRAM + GTT (the
//     shared-RAM pool APUs actually run models from).
//   4. wmic (Windows) — filtered fallback for non-NVIDIA rigs.
//
// UNIFIED MEMORY: on Apple Silicon, AMD APUs (Strix Halo / Ryzen AI
// Max) and Intel iGPUs the "VRAM" number is meaningless — the GPU
// addresses system RAM. Those GPUs get `unified: true` and `vram_gb`
// rewritten to the realistic GPU-addressable budget, so every consumer
// (model-fit tags, context sizing, module resolver, UI) is correct
// without special-casing.

use crate::paths;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Default, Serialize, Clone)]
pub struct HardwareInfo {
    pub cpu_name: String,
    pub cpu_cores: u32,           // physical cores
    pub cpu_threads: u32,         // logical cores (incl. SMT)
    pub ram_total_gb: f64,
    pub ram_used_gb: f64,
    pub gpus: Vec<GpuInfo>,
}

#[derive(Default, Serialize, Clone)]
pub struct GpuInfo {
    pub index: u32,
    pub name: String,
    pub vram_gb: f64,             // adapter VRAM in GiB
    /// Stable hardware UUID (e.g. `GPU-12e7cda9-...`). Empty string
    /// when the discovery path can't get one (wmic fallback).
    pub uuid: String,
    /// Whether this GPU is currently selected for use by the runtime.
    /// Persisted to gpu_config.json; mirrors the legacy PySide6 store.
    pub selected: bool,
    /// Unified/shared-memory architecture (Apple Silicon, AMD APU, Intel
    /// iGPU): `vram_gb` is a budget carved from system RAM, not dedicated
    /// VRAM. Additive field — older UI code simply ignores it.
    #[serde(default)]
    pub unified: bool,
}

/// Tauri command: native hardware probe.
///
/// Always returns `Ok(_)` — individual probe failures degrade
/// gracefully (empty GPU list rather than an error). The React UI
/// renders whatever fields are populated; the user never sees a
/// fatal error here.
#[tauri::command]
pub async fn hardware_info() -> Result<HardwareInfo, String> {
    Ok(probe().await)
}

#[derive(Default, Serialize, Clone)]
pub struct VramStatus {
    pub gpus: Vec<VramGpu>,
}

#[derive(Default, Serialize, Clone)]
pub struct VramGpu {
    pub index: u32,
    pub used_mib: u32,
    pub total_mib: u32,
}

/// Tauri command: live VRAM usage via nvidia-smi (no console popup).
/// Called every 2s by the header SysInfo block. Returns an empty GPU
/// list when nvidia-smi is unavailable (non-NVIDIA / no driver) so
/// the UI can degrade gracefully.
#[tauri::command]
pub async fn vram_status() -> Result<VramStatus, String> {
    Ok(VramStatus {
        gpus: vram_via_nvidia_smi().await.unwrap_or_default(),
    })
}

/// nvidia-smi is identical on Windows and Linux; on macOS the binary is
/// absent so `.output()` errors → None and the UI degrades gracefully.
async fn vram_via_nvidia_smi() -> Option<Vec<VramGpu>> {
    use tokio::process::Command;
    let mut cmd = Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=memory.used,memory.total",
        "--format=csv,noheader,nounits",
    ]);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    Some(parse_nvidia_smi(&stdout))
}

/// Max CUDA version the installed NVIDIA driver supports, parsed from the
/// `nvidia-smi` banner line ("... CUDA Version: 12.6 ..."). Returns None
/// when nvidia-smi is missing (no NVIDIA driver). This is the *driver's*
/// CUDA, not a toolkit install — it's what gates which torch wheel the
/// fine-tuning env can use. Used by the Home readiness panel.
pub async fn cuda_driver_version() -> Option<String> {
    use tokio::process::Command;
    let mut cmd = Command::new("nvidia-smi");
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    parse_cuda_banner(&String::from_utf8_lossy(&out.stdout))
}

/// Extract "12.6" from a line containing "CUDA Version: 12.6".
fn parse_cuda_banner(text: &str) -> Option<String> {
    const KEY: &str = "CUDA Version:";
    for line in text.lines() {
        if let Some(idx) = line.find(KEY) {
            let rest = line[idx + KEY.len()..].trim_start();
            let ver: String = rest
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            if !ver.is_empty() {
                return Some(ver);
            }
        }
    }
    None
}

/// Parse the `nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits`
/// output: one line per GPU, comma-separated MiB values, e.g.
///
///   8958, 23027
///   11655, 11513
fn parse_nvidia_smi(text: &str) -> Vec<VramGpu> {
    text.lines()
        .enumerate()
        .filter_map(|(i, raw)| {
            let line = raw.trim();
            if line.is_empty() {
                return None;
            }
            let (u, t) = line.split_once(',')?;
            Some(VramGpu {
                index: i as u32,
                used_mib: u.trim().parse().ok()?,
                total_mib: t.trim().parse().ok()?,
            })
        })
        .collect()
}

async fn probe() -> HardwareInfo {
    let mut info = HardwareInfo::default();

    // sysinfo — CPU + RAM. We need a fresh refresh; sysinfo caches.
    {
        let mut sys = sysinfo::System::new();
        sys.refresh_cpu_all();
        sys.refresh_memory();

        if let Some(cpu) = sys.cpus().first() {
            info.cpu_name = cpu.brand().to_string();
        }
        info.cpu_cores = sys.physical_core_count().unwrap_or(0) as u32;
        info.cpu_threads = sys.cpus().len() as u32;
        info.ram_total_gb = bytes_to_gb(sys.total_memory());
        info.ram_used_gb = bytes_to_gb(sys.used_memory());
    }

    // GPU discovery chain — first probe that finds anything wins.
    // nvidia-smi runs on Windows + Linux; system_profiler only exists on
    // macOS; the drm sysfs scan only finds anything on Linux; wmic is the
    // Windows fallback. Every probe degrades to None off its platform, so
    // the chain is safe to run everywhere. (Known v1 limit: on a Linux
    // hybrid NVIDIA-dGPU + AMD-iGPU box the dGPU wins and the iGPU is
    // not listed — the dGPU is the right inference target anyway.)
    let mut gpus = gpus_via_nvidia_smi().await.unwrap_or_default();
    if gpus.is_empty() {
        gpus = gpus_via_system_profiler().await.unwrap_or_default();
    }
    if gpus.is_empty() {
        gpus = gpus_via_drm_sysfs().unwrap_or_default();
    }
    if gpus.is_empty() {
        gpus = gpus_via_wmic().await.unwrap_or_default();
    }
    info.gpus = gpus;
    for (i, g) in info.gpus.iter_mut().enumerate() {
        g.index = i as u32;
    }
    apply_unified_budgets(&mut info.gpus, info.ram_total_gb);

    // Apply saved selection. When no config exists yet, default to ALL
    // GPUs selected — mirrors the legacy PySide6 behaviour.
    let saved = load_gpu_selection().unwrap_or_default();
    let saved_uuids: std::collections::HashSet<String> =
        saved.selected_gpu_uuids.iter().cloned().collect();
    let has_saved = !saved_uuids.is_empty();
    for g in info.gpus.iter_mut() {
        g.selected = if has_saved {
            saved_uuids.contains(&g.uuid)
        } else {
            true
        };
    }

    info
}

fn bytes_to_gb(b: u64) -> f64 {
    (b as f64) / 1024.0 / 1024.0 / 1024.0
}

/// nvidia-smi GPU discovery — preferred over wmic on NVIDIA rigs
/// because it returns the real total memory (wmic's AdapterRAM is a
/// 32-bit DWORD that wraps to 4 GiB) and skips virtual display
/// adapters. The `uuid` is what we persist in gpu_config.json.
/// nvidia-smi GPU discovery. `nvidia-smi` is identical on Windows and Linux,
/// so this runs on both (and is harmless on macOS — the binary is absent, so
/// `.output()` errors → None, and we fall through to no NVIDIA GPUs). The only
/// platform-specific bit is the Windows CREATE_NO_WINDOW flag (tokio exposes
/// `creation_flags` inherently on Windows).
async fn gpus_via_nvidia_smi() -> Option<Vec<GpuInfo>> {
    use tokio::process::Command;
    let mut cmd = Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=name,memory.total,uuid",
        "--format=csv,noheader,nounits",
    ]);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed = parse_nvidia_smi_gpus(&stdout);
    if parsed.is_empty() { None } else { Some(parsed) }
}

fn parse_nvidia_smi_gpus(text: &str) -> Vec<GpuInfo> {
    text.lines()
        .enumerate()
        .filter_map(|(i, raw)| {
            let line = raw.trim();
            if line.is_empty() { return None; }
            let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
            if parts.len() < 3 { return None; }
            let name = parts[0].to_string();
            let total_mib: u64 = parts[1].parse().ok()?;
            let uuid = parts[2].to_string();
            Some(GpuInfo {
                index: i as u32,
                name,
                vram_gb: (total_mib as f64) / 1024.0,
                uuid,
                selected: true,
                unified: false,
            })
        })
        .collect()
}

#[cfg(windows)]
async fn gpus_via_wmic() -> Option<Vec<GpuInfo>> {
    use tokio::process::Command;

    // CREATE_NO_WINDOW = 0x08000000. tokio::process::Command exposes
    // `creation_flags` directly on Windows builds — no trait import
    // needed. Without this flag the wmic child briefly pops a
    // console window, exactly the misbehavior we eliminated when we
    // wiped the Python supervisor.
    let mut cmd = Command::new("wmic");
    cmd.args([
        "path",
        "Win32_VideoController",
        "get",
        "Name,AdapterRAM",
        "/format:list",
    ]);
    cmd.creation_flags(0x08000000);

    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut all = parse_wmic_list(&stdout);
    // Strip virtual adapters that aren't physical GPUs — Microsoft
    // Remote Display Adapter, Microsoft Basic Display Adapter, etc.
    all.retain(|g| !is_virtual_adapter(&g.name));
    Some(all)
}

/// Recognise virtual / pseudo display adapters that should never
/// count as a real GPU for inference.
fn is_virtual_adapter(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("remote display adapter")
        || n.contains("basic display adapter")
        || n.contains("basic render driver")
        || n.contains("idd hdr device")
        || n.contains("virtual display")
}

#[cfg(not(windows))]
async fn gpus_via_wmic() -> Option<Vec<GpuInfo>> {
    None
}

// ---------------------------------------------------------------------
// macOS — system_profiler. Apple Silicon GPUs have NO vram field (the
// GPU shares system RAM → unified); discrete Macs report spdisplays_vram.
// ---------------------------------------------------------------------

async fn gpus_via_system_profiler() -> Option<Vec<GpuInfo>> {
    use tokio::process::Command;
    let out = Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let parsed = parse_system_profiler_displays(&String::from_utf8_lossy(&out.stdout));
    if parsed.is_empty() { None } else { Some(parsed) }
}

/// Pure parser for `system_profiler SPDisplaysDataType -json`. Kept
/// platform-independent so the Windows CI/test run exercises it.
fn parse_system_profiler_displays(json: &str) -> Vec<GpuInfo> {
    let v: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(cards) = v.get("SPDisplaysDataType").and_then(|c| c.as_array()) else {
        return Vec::new();
    };
    cards
        .iter()
        .enumerate()
        .filter_map(|(i, c)| {
            let name = c
                .get("sppci_model")
                .or_else(|| c.get("_name"))
                .and_then(|n| n.as_str())?
                .to_string();
            // "spdisplays_vram" looks like "8 GB" / "1536 MB" on discrete
            // cards; absent on Apple Silicon (unified — budget applied later).
            let vram_gb = c
                .get("spdisplays_vram")
                .and_then(|s| s.as_str())
                .and_then(parse_mem_size_gb)
                .unwrap_or(0.0);
            let unified = name.to_lowercase().contains("apple");
            Some(GpuInfo {
                index: i as u32,
                name,
                vram_gb,
                uuid: String::new(),
                selected: true,
                unified,
            })
        })
        .collect()
}

/// "8 GB" → 8.0, "1536 MB" → 1.5. None on anything unparseable.
fn parse_mem_size_gb(s: &str) -> Option<f64> {
    let t = s.trim().to_lowercase();
    let (num, unit) = t.split_once(' ')?;
    let n: f64 = num.trim().parse().ok()?;
    match unit.trim() {
        "gb" => Some(n),
        "mb" => Some(n / 1024.0),
        _ => None,
    }
}

// ---------------------------------------------------------------------
// Linux — /sys/class/drm. amdgpu (vendor 0x1002) and i915/xe (0x8086)
// expose mem_info_vram_total + mem_info_gtt_total (the shared-RAM pool
// an APU actually runs models from). NVIDIA is handled by nvidia-smi.
// ---------------------------------------------------------------------

fn gpus_via_drm_sysfs() -> Option<Vec<GpuInfo>> {
    let entries = std::fs::read_dir("/sys/class/drm").ok()?;
    let mut out: Vec<GpuInfo> = Vec::new();
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(String::from))
        // card0, card1… — skip card0-DP-1 connector nodes and renderD nodes.
        .filter(|n| n.starts_with("card") && !n.contains('-'))
        .collect();
    names.sort();
    for n in names {
        let dev = std::path::Path::new("/sys/class/drm").join(&n).join("device");
        let read = |f: &str| std::fs::read_to_string(dev.join(f)).unwrap_or_default();
        let vendor = read("vendor");
        let vendor = vendor.trim();
        let (vendor_name, is_amd_intel) = match vendor {
            "0x1002" => ("AMD GPU", true),
            "0x8086" => ("Intel GPU", true),
            _ => ("", false),
        };
        if !is_amd_intel {
            continue;
        }
        let vram = read("mem_info_vram_total").trim().parse::<u64>().unwrap_or(0);
        let gtt = read("mem_info_gtt_total").trim().parse::<u64>().unwrap_or(0);
        // GTT (shared system RAM) dominating dedicated VRAM = APU/iGPU.
        let unified = gtt > vram;
        let total = if unified { vram + gtt } else { vram };
        if total == 0 {
            continue;
        }
        out.push(GpuInfo {
            index: out.len() as u32,
            name: format!("{vendor_name} ({n})"),
            vram_gb: bytes_to_gb(total),
            uuid: String::new(),
            selected: true,
            unified,
        });
    }
    if out.is_empty() { None } else { Some(out) }
}

// ---------------------------------------------------------------------
// Unified-memory budgets.
// ---------------------------------------------------------------------

/// Integrated-GPU heuristic for probes that only give us a NAME (wmic).
/// These report a tiny dedicated pool while the real budget is shared
/// system RAM — the classic "7B model shows red on a 32 GB Strix Halo".
fn is_integrated_gpu(name: &str) -> bool {
    let n = name.to_lowercase();
    if n.contains("apple") {
        return true;
    }
    // Intel iGPUs. NOT Arc — Arc cards have real dedicated VRAM.
    if n.contains("intel") && (n.contains("uhd") || n.contains("iris") || n.contains("hd graphics")) {
        return true;
    }
    // AMD APUs: "AMD Radeon(TM) Graphics", "Radeon 680M/780M/890M",
    // "Vega 8 Graphics", "Ryzen … with Radeon Graphics". The "RX" line
    // is discrete (incl. mobile "RX 7900M") — never treat it as an APU.
    if n.contains("radeon") && !n.contains(" rx ") {
        if n.contains("(tm) graphics") || n.ends_with("radeon graphics") || n.contains("vega") {
            return true;
        }
        // "…780M" / "…890M Graphics" model numbers are the RDNA APU line.
        if n.split_whitespace().any(|w| {
            w.len() >= 4
                && w.ends_with('m')
                && w[..w.len() - 1].chars().all(|c| c.is_ascii_digit())
        }) {
            return true;
        }
    }
    false
}

/// Rewrite `vram_gb` to a realistic GPU-addressable budget on unified
/// architectures. Fractions are deliberately conservative:
///   * Apple Silicon: ~75 % of RAM — approximates Metal's
///     recommendedMaxWorkingSetSize (llama.cpp queries the exact value
///     at runtime; this is only for fit tags / context sizing).
///   * Windows/other iGPU-by-name: 50 % of RAM — Windows' shared GPU
///     memory pool is capped at half of system RAM.
///   * Linux drm probes already carry real VRAM+GTT totals — untouched.
fn apply_unified_budgets(gpus: &mut [GpuInfo], ram_total_gb: f64) {
    for g in gpus.iter_mut() {
        if g.unified {
            if g.vram_gb <= 0.1 {
                // Apple Silicon via system_profiler (no vram field).
                g.vram_gb = ram_total_gb * 0.75;
            }
        } else if is_integrated_gpu(&g.name) {
            g.unified = true;
            g.vram_gb = g.vram_gb.max(ram_total_gb * 0.5);
        }
    }
}

/// The single GPU-memory number the rest of the app should plan around:
/// the largest effective budget among the user's SELECTED GPUs (all
/// GPUs when nothing is explicitly selected). `unified` tells callers
/// the budget is shared with the OS/CPU so they can reserve more.
pub struct GpuMemoryBudget {
    pub gb: f64,
    pub unified: bool,
}

pub async fn gpu_memory_budget() -> Option<GpuMemoryBudget> {
    let info = probe().await;
    let pool: Vec<&GpuInfo> = {
        let sel: Vec<&GpuInfo> = info.gpus.iter().filter(|g| g.selected).collect();
        if sel.is_empty() { info.gpus.iter().collect() } else { sel }
    };
    let best = pool.into_iter().max_by(|a, b| {
        a.vram_gb.partial_cmp(&b.vram_gb).unwrap_or(std::cmp::Ordering::Equal)
    })?;
    if best.vram_gb <= 0.1 {
        return None;
    }
    Some(GpuMemoryBudget { gb: best.vram_gb, unified: best.unified })
}

// ---------------------------------------------------------------------
// GPU selection persistence.
// File: LLM/data/gpu_config.json   (new path post-restructure)
// Shape: { "selected_gpu_uuids": [...], "selected_gpu_indices": [...] }
// UUIDs are authoritative; indices are a hint kept for backward
// compatibility with code that still reads them.
//
// Migrated from the legacy LLM/desktop_app/config/gpu_config.json
// location when the PySide6 app got sandboxed. Read falls back to the
// old path so an existing user's selection isn't lost.
// ---------------------------------------------------------------------

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct GpuSelection {
    pub selected_gpu_uuids: Vec<String>,
    pub selected_gpu_indices: Vec<u32>,
}

fn gpu_config_path() -> Option<PathBuf> {
    // Phase 2 canonical location: %APPDATA%\OwLLM Desktop\gpu_config.json.
    paths::user_gpu_config_path()
}

/// Read-only legacy fallbacks. Two of them now:
///   1. LLM/data/gpu_config.json — where Phase 4 (post-desktop_app
///      sandbox) put the file before user-data root existed.
///   2. LLM/desktop_app/config/gpu_config.json — where the original
///      PySide6 app wrote it (pre-restructure).
fn legacy_gpu_config_paths() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(root) = paths::llm_root() {
        v.push(root.join("data").join("gpu_config.json"));
        v.push(root.join("desktop_app").join("config").join("gpu_config.json"));
    }
    v
}

fn load_gpu_selection() -> Option<GpuSelection> {
    // Prefer the new %APPDATA% path; fall back to both legacy locations.
    if let Some(path) = gpu_config_path() {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(sel) = serde_json::from_str::<GpuSelection>(&raw) {
                return Some(sel);
            }
        }
    }
    for legacy in legacy_gpu_config_paths() {
        if let Ok(raw) = std::fs::read_to_string(&legacy) {
            if let Ok(sel) = serde_json::from_str::<GpuSelection>(&raw) {
                return Some(sel);
            }
        }
    }
    None
}

/// The GPU UUIDs the user selected in gpu_config.json (authoritative).
/// Empty = no explicit selection → callers should leave the backend's
/// default GPU behaviour untouched. Used by the model-server spawn to pin
/// inference to the chosen GPU(s).
pub fn selected_gpu_uuids() -> Vec<String> {
    load_gpu_selection().map(|s| s.selected_gpu_uuids).unwrap_or_default()
}

/// Map GPU UUIDs to their nvidia-smi device NAMES. Names are the only
/// identifier stable across APIs whose device ORDER disagrees (nvidia-smi
/// vs CUDA vs Vulkan) — the persisted index is NOT safe to reuse as a
/// Vulkan/CUDA index. Synchronous so the server spawn path can call it
/// without an async hop. Returns names in nvidia-smi order for the
/// matching UUIDs; empty when nvidia-smi is unavailable.
pub fn gpu_names_for_uuids(uuids: &[String]) -> Vec<String> {
    let mut cmd = std::process::Command::new("nvidia-smi");
    cmd.args(["--query-gpu=name,memory.total,uuid", "--format=csv,noheader,nounits"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let Ok(out) = cmd.output() else { return Vec::new(); };
    if !out.status.success() { return Vec::new(); }
    let stdout = String::from_utf8_lossy(&out.stdout);
    parse_nvidia_smi_gpus(&stdout)
        .into_iter()
        .filter(|g| uuids.iter().any(|u| u == &g.uuid))
        .map(|g| g.name)
        .collect()
}

fn save_gpu_selection(sel: &GpuSelection) -> Result<(), String> {
    let path = gpu_config_path().ok_or_else(|| "LLM/ tree not found".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let s = serde_json::to_string_pretty(sel).map_err(|e| e.to_string())?;
    std::fs::write(&path, s).map_err(|e| e.to_string())?;
    Ok(())
}

/// Toggle which GPUs the runtime should use. Persists to
/// gpu_config.json + recomputes the `selected_gpu_indices` companion
/// list from the current probe order. Empty `uuids` means "select
/// none" (CPU-only inference).
#[tauri::command]
pub async fn set_gpu_selection(uuids: Vec<String>) -> Result<(), String> {
    // Re-probe so the index list reflects the current discovery order.
    let probed = probe().await;
    let chosen: std::collections::HashSet<&str> = uuids.iter().map(|s| s.as_str()).collect();
    let indices: Vec<u32> = probed
        .gpus
        .iter()
        .filter(|g| chosen.contains(g.uuid.as_str()))
        .map(|g| g.index)
        .collect();
    save_gpu_selection(&GpuSelection {
        selected_gpu_uuids: uuids,
        selected_gpu_indices: indices,
    })
}

/// Parse the `wmic /format:list` output — repeated blocks of:
///
///   AdapterRAM=4294967295
///   Name=NVIDIA GeForce RTX 4090
///
/// separated by blank lines. Robust to extra whitespace, missing
/// fields, and non-numeric AdapterRAM (some virtual adapters report
/// negative as wraparound — we treat those as 0).
fn parse_wmic_list(text: &str) -> Vec<GpuInfo> {
    let mut out: Vec<GpuInfo> = Vec::new();
    let mut cur = GpuInfo::default();
    let mut have_any = false;

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            if have_any && !cur.name.is_empty() {
                out.push(std::mem::take(&mut cur));
            } else {
                cur = GpuInfo::default();
            }
            have_any = false;
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let key = k.trim();
            let val = v.trim();
            have_any = true;
            match key {
                "Name" => cur.name = val.to_string(),
                "AdapterRAM" => {
                    cur.vram_gb = val.parse::<u64>().map(bytes_to_gb).unwrap_or(0.0);
                }
                _ => {}
            }
        }
    }
    if have_any && !cur.name.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wmic_list_format() {
        let sample = "\r\n\r\nAdapterRAM=4294967295\r\nName=NVIDIA GeForce RTX 4090\r\n\r\nAdapterRAM=1073741824\r\nName=Intel UHD Graphics\r\n\r\n";
        let gpus = parse_wmic_list(sample);
        assert_eq!(gpus.len(), 2);
        assert_eq!(gpus[0].name, "NVIDIA GeForce RTX 4090");
        assert!((gpus[0].vram_gb - 4.0).abs() < 0.01);
        assert_eq!(gpus[1].name, "Intel UHD Graphics");
        assert!((gpus[1].vram_gb - 1.0).abs() < 0.01);
    }

    #[test]
    fn parses_empty_input() {
        assert!(parse_wmic_list("").is_empty());
    }

    #[test]
    fn parses_nvidia_smi_dual_gpu() {
        // Real-world sample captured from the rig:
        //   $ nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits
        let sample = "8958, 23027\r\n11655, 11513\r\n";
        let v = parse_nvidia_smi(sample);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].index, 0);
        assert_eq!(v[0].used_mib, 8958);
        assert_eq!(v[0].total_mib, 23027);
        assert_eq!(v[1].used_mib, 11655);
        assert_eq!(v[1].total_mib, 11513);
    }

    #[test]
    fn parses_nvidia_smi_empty() {
        assert!(parse_nvidia_smi("").is_empty());
    }

    #[test]
    fn skips_unnamed_adapters() {
        // Some virtual adapters have no Name. Drop them.
        let sample = "AdapterRAM=1024\r\n\r\nName=Real GPU\r\nAdapterRAM=2048\r\n\r\n";
        let gpus = parse_wmic_list(sample);
        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].name, "Real GPU");
    }

    #[test]
    fn parses_system_profiler_apple_silicon() {
        // Apple Silicon: no vram field → unified, budget applied later.
        let sample = r#"{"SPDisplaysDataType":[{"_name":"Apple M3 Max","sppci_model":"Apple M3 Max","spdisplays_ndrvs":[]}]}"#;
        let gpus = parse_system_profiler_displays(sample);
        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].name, "Apple M3 Max");
        assert!(gpus[0].unified);
        assert!(gpus[0].vram_gb < 0.1);
    }

    #[test]
    fn parses_system_profiler_discrete_mac() {
        let sample = r#"{"SPDisplaysDataType":[{"_name":"Radeon Pro 5500M","sppci_model":"AMD Radeon Pro 5500M","spdisplays_vram":"8 GB"}]}"#;
        let gpus = parse_system_profiler_displays(sample);
        assert_eq!(gpus.len(), 1);
        assert!(!gpus[0].unified);
        assert!((gpus[0].vram_gb - 8.0).abs() < 0.01);
    }

    #[test]
    fn parses_mem_sizes() {
        assert_eq!(parse_mem_size_gb("8 GB"), Some(8.0));
        assert_eq!(parse_mem_size_gb("1536 MB"), Some(1.5));
        assert_eq!(parse_mem_size_gb("garbage"), None);
    }

    #[test]
    fn integrated_gpu_heuristics() {
        // AMD APUs — the Strix Halo / Ryzen AI class this exists for.
        assert!(is_integrated_gpu("AMD Radeon(TM) Graphics"));
        assert!(is_integrated_gpu("AMD Radeon 780M Graphics"));
        assert!(is_integrated_gpu("AMD Radeon(TM) 890M"));
        assert!(is_integrated_gpu("Radeon Vega 8 Graphics"));
        // Intel iGPUs.
        assert!(is_integrated_gpu("Intel(R) UHD Graphics 770"));
        assert!(is_integrated_gpu("Intel(R) Iris(R) Xe Graphics"));
        // Apple.
        assert!(is_integrated_gpu("Apple M2"));
        // Discrete cards must stay discrete.
        assert!(!is_integrated_gpu("NVIDIA GeForce RTX 4090"));
        assert!(!is_integrated_gpu("AMD Radeon RX 7900 XTX"));
        assert!(!is_integrated_gpu("Intel(R) Arc(TM) A770 Graphics"));
    }

    #[test]
    fn unified_budget_rewrites() {
        let mut gpus = vec![
            GpuInfo { index: 0, name: "Apple M3".into(), vram_gb: 0.0, uuid: String::new(), selected: true, unified: true },
            GpuInfo { index: 1, name: "AMD Radeon(TM) Graphics".into(), vram_gb: 2.0, uuid: String::new(), selected: true, unified: false },
            GpuInfo { index: 2, name: "NVIDIA GeForce RTX 4090".into(), vram_gb: 24.0, uuid: "GPU-x".into(), selected: true, unified: false },
        ];
        apply_unified_budgets(&mut gpus, 32.0);
        assert!((gpus[0].vram_gb - 24.0).abs() < 0.01); // 75 % of 32 GB
        assert!(gpus[1].unified);
        assert!((gpus[1].vram_gb - 16.0).abs() < 0.01); // max(2, 50 % of 32)
        assert!(!gpus[2].unified);
        assert!((gpus[2].vram_gb - 24.0).abs() < 0.01); // discrete untouched
    }
}

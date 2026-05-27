// Hardware probe — native Rust. NO Python. NO console popups.
//
// CPU + RAM come from the `sysinfo` crate (cross-platform). GPU
// detection on Windows prefers `nvidia-smi --query-gpu=name,memory.total,uuid`
// because:
//   * it reports the REAL VRAM (wmic's AdapterRAM field is a 32-bit
//     DWORD that wraps anything > 4 GiB → showed "4 GiB" for a 24 GiB
//     RTX 4090),
//   * it skips virtual adapters automatically (Microsoft Remote
//     Display Adapter etc. don't appear in NVML), and
//   * it gives us a stable per-card UUID we can store as the user's
//     selection without depending on the volatile FASTEST_FIRST index.
// Falls back to a filtered wmic probe when nvidia-smi is missing
// (non-NVIDIA / no driver).

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

#[cfg(windows)]
async fn vram_via_nvidia_smi() -> Option<Vec<VramGpu>> {
    use tokio::process::Command;
    let mut cmd = Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=memory.used,memory.total",
        "--format=csv,noheader,nounits",
    ]);
    cmd.creation_flags(0x08000000);
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    Some(parse_nvidia_smi(&stdout))
}

#[cfg(not(windows))]
async fn vram_via_nvidia_smi() -> Option<Vec<VramGpu>> {
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

    // GPU discovery — nvidia-smi first (real VRAM + UUIDs, no virtual
    // adapters). Fall back to a virtual-filtered wmic only if NVML is
    // unavailable on this machine.
    info.gpus = gpus_via_nvidia_smi()
        .await
        .or_else(|| futures_block(gpus_via_wmic()))
        .unwrap_or_default();
    for (i, g) in info.gpus.iter_mut().enumerate() {
        g.index = i as u32;
    }

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

/// Bridge async->sync for the wmic fallback inside the (already async)
/// nvidia-smi `or_else` chain. We can't `.await` inside that closure
/// without restructuring, so we spawn a fresh blocking executor for the
/// few-millisecond fallback. Acceptable because this path is rare.
fn futures_block<F: std::future::Future<Output = Option<Vec<GpuInfo>>>>(fut: F) -> Option<Vec<GpuInfo>> {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(fut))
}

fn bytes_to_gb(b: u64) -> f64 {
    (b as f64) / 1024.0 / 1024.0 / 1024.0
}

/// nvidia-smi GPU discovery — preferred over wmic on NVIDIA rigs
/// because it returns the real total memory (wmic's AdapterRAM is a
/// 32-bit DWORD that wraps to 4 GiB) and skips virtual display
/// adapters. The `uuid` is what we persist in gpu_config.json.
#[cfg(windows)]
async fn gpus_via_nvidia_smi() -> Option<Vec<GpuInfo>> {
    use tokio::process::Command;
    let mut cmd = Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=name,memory.total,uuid",
        "--format=csv,noheader,nounits",
    ]);
    cmd.creation_flags(0x08000000);
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed = parse_nvidia_smi_gpus(&stdout);
    if parsed.is_empty() { None } else { Some(parsed) }
}

#[cfg(not(windows))]
async fn gpus_via_nvidia_smi() -> Option<Vec<GpuInfo>> { None }

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
    // Non-Windows: caller falls back to an empty GPU list. We don't
    // ship this app outside Windows today.
    None
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
}

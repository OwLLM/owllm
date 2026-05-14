// Hardware probe — native Rust. NO Python. NO console popups.
//
// CPU + RAM come from the `sysinfo` crate (cross-platform). GPU
// detection on Windows shells out to `wmic path Win32_VideoController`
// because we deliberately don't depend on NVML yet (nvidia-only, adds
// a build-time DLL requirement). The `wmic` invocation is spawned via
// `tokio::process::Command` with `creation_flags(CREATE_NO_WINDOW)`
// so it does NOT pop a console — the whole reason we wiped the
// Python supervisor in the first place.

use serde::Serialize;

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
    pub vram_gb: f64,             // adapter VRAM as reported by Win32_VideoController
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

    // GPU — Windows wmic, no popup.
    info.gpus = gpus_via_wmic().await.unwrap_or_default();
    for (i, g) in info.gpus.iter_mut().enumerate() {
        g.index = i as u32;
    }

    info
}

fn bytes_to_gb(b: u64) -> f64 {
    (b as f64) / 1024.0 / 1024.0 / 1024.0
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
    Some(parse_wmic_list(&stdout))
}

#[cfg(not(windows))]
async fn gpus_via_wmic() -> Option<Vec<GpuInfo>> {
    // Non-Windows: caller falls back to an empty GPU list. We don't
    // ship this app outside Windows today.
    None
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

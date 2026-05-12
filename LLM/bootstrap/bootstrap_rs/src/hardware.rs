//! Hardware probe — port of `bootstrap_go/hardware/probe.go`.
//!
//! Builds a [`Spec`] by shelling out to platform-specific commands
//! (`wmic` for Windows CPU / RAM, `nvidia-smi` for GPUs). The output
//! schema MUST match the Python supervisor probe at
//! `LLM/core/supervisor/hardware_probe.py` so the model sees a
//! consistent shape regardless of which mode it's being asked from.
//!
//! Never errors hard. Missing tools degrade to "no information about
//! that subsystem" (e.g. `nvidia-smi` absent → empty GPU list, NOT
//! "abort install"). The model decides what to do with partial info.

use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Default, Serialize)]
pub struct Spec {
    pub os: OsInfo,
    pub cpu: CpuInfo,
    #[serde(rename = "ram_gb")]
    pub ram_gb: u64,
    #[serde(rename = "disk_free_gb")]
    pub disk_free_gb: u64,
    /// Always serialize as `[]` not `null` for empty case — matches
    /// the Go side's custom MarshalJSON.
    #[serde(default)]
    pub gpu: Vec<Gpu>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct OsInfo {
    pub name: String,
    pub version: String,
    pub arch: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct CpuInfo {
    pub model: String,
    pub cores: u32,
    pub threads: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Gpu {
    pub vendor: String,
    pub model: String,
    #[serde(rename = "vram_gb")]
    pub vram_gb: u64,
    pub driver: String,
    #[serde(rename = "cuda_runtime")]
    pub cuda_runtime: String,
    #[serde(rename = "compute_capability")]
    pub compute_capability: String,
}

/// Run the probe. Always returns a Spec — never errors.
pub fn probe() -> Spec {
    let mut s = Spec {
        os: OsInfo {
            name: std::env::consts::OS.to_string(),
            version: String::new(),
            arch: std::env::consts::ARCH.to_string(),
        },
        cpu: CpuInfo {
            model: String::new(),
            // `available_parallelism` works on every platform we
            // care about and avoids pulling in `num_cpus`.
            cores: std::thread::available_parallelism()
                .map(|n| n.get() as u32)
                .unwrap_or(1),
            threads: std::thread::available_parallelism()
                .map(|n| n.get() as u32)
                .unwrap_or(1),
        },
        ram_gb: 0,
        disk_free_gb: 0,
        gpu: Vec::new(),
    };

    if cfg!(windows) {
        probe_windows(&mut s);
    }
    probe_nvidia(&mut s);
    s
}

fn probe_windows(s: &mut Spec) {
    if let Some(out) = run_cmd("wmic", &["cpu", "get", "Name", "/value"], 5) {
        if let Some(model) = parse_wmic_value(&out, "Name") {
            s.cpu.model = model;
        }
    }
    if let Some(out) = run_cmd("cmd", &["/c", "ver"], 5) {
        s.os.version = out.trim().to_string();
    }
    if let Some(out) = run_cmd(
        "wmic",
        &["ComputerSystem", "get", "TotalPhysicalMemory", "/value"],
        5,
    ) {
        if let Some(bytes_str) = parse_wmic_value(&out, "TotalPhysicalMemory") {
            if let Ok(n) = bytes_str.parse::<u64>() {
                s.ram_gb = n / (1024 * 1024 * 1024);
            }
        }
    }
}

fn probe_nvidia(s: &mut Spec) {
    let out = run_cmd(
        "nvidia-smi",
        &[
            "--query-gpu=name,memory.total,driver_version,compute_cap",
            "--format=csv,noheader,nounits",
        ],
        5,
    );
    if let Some(stdout) = out {
        s.gpu = parse_nvidia_csv(&stdout);
    }
}

/// Parse one `wmic ... /value` output line set, returning the value
/// after `<key>=`. Exposed for testing — wmic is otherwise
/// shell-bound.
pub fn parse_wmic_value(stdout: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(&prefix) {
            return Some(rest.trim().to_string());
        }
    }
    None
}

/// Parse the CSV output of
/// `nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap
/// --format=csv,noheader,nounits`. Memory is in MiB → converted to GB.
pub fn parse_nvidia_csv(stdout: &str) -> Vec<Gpu> {
    let mut out = Vec::new();
    for line in stdout.trim().lines() {
        let fields: Vec<&str> = line.split(", ").collect();
        if fields.len() < 4 {
            continue;
        }
        let vram_mib: u64 = fields[1].trim().parse().unwrap_or(0);
        out.push(Gpu {
            vendor: "nvidia".into(),
            model: fields[0].trim().into(),
            vram_gb: vram_mib / 1024,
            driver: fields[2].trim().into(),
            cuda_runtime: String::new(),
            compute_capability: fields[3].trim().into(),
        });
    }
    out
}

/// Run a command and return its stdout. Returns None on any failure
/// (binary missing, non-zero exit, IO error). stderr is silenced.
///
/// We deliberately do NOT implement a watchdog timeout: the only
/// commands that go through here are `wmic`, `nvidia-smi`, and
/// `cmd /c ver`, all of which finish in well under 100 ms when
/// they succeed, and not at all when they're absent (immediate
/// "not found"). The Go side used context.WithTimeout to bound
/// hangs; we accept the simpler "wait until done" model because
/// dragging in tokio for ~3 lines of timeout logic isn't worth it.
fn run_cmd(bin: &str, args: &[&str], _unused_timeout_secs: u64) -> Option<String> {
    let output = Command::new(bin)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_wmic_value_finds_key() {
        let stdout = "\r\n\r\nName=Intel(R) Core(TM) i9-13900K\r\n\r\n";
        assert_eq!(
            parse_wmic_value(stdout, "Name"),
            Some("Intel(R) Core(TM) i9-13900K".into())
        );
    }

    #[test]
    fn parse_wmic_value_returns_none_when_missing() {
        let stdout = "Other=value\r\nNotName=x\r\n";
        assert!(parse_wmic_value(stdout, "Name").is_none());
    }

    #[test]
    fn parse_wmic_value_handles_total_physical_memory_format() {
        let stdout = "\r\nTotalPhysicalMemory=68719476736\r\n";
        assert_eq!(
            parse_wmic_value(stdout, "TotalPhysicalMemory"),
            Some("68719476736".into())
        );
    }

    #[test]
    fn parse_nvidia_csv_single_gpu() {
        let stdout = "NVIDIA GeForce RTX 4090, 24576, 537.13, 8.9";
        let gpus = parse_nvidia_csv(stdout);
        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].vendor, "nvidia");
        assert_eq!(gpus[0].model, "NVIDIA GeForce RTX 4090");
        assert_eq!(gpus[0].vram_gb, 24); // 24576 MiB / 1024
        assert_eq!(gpus[0].driver, "537.13");
        assert_eq!(gpus[0].compute_capability, "8.9");
    }

    #[test]
    fn parse_nvidia_csv_multiple_gpus() {
        let stdout = "RTX 4090, 24576, 537.13, 8.9\nRTX 3090, 24576, 537.13, 8.6";
        let gpus = parse_nvidia_csv(stdout);
        assert_eq!(gpus.len(), 2);
        assert_eq!(gpus[0].model, "RTX 4090");
        assert_eq!(gpus[1].compute_capability, "8.6");
    }

    #[test]
    fn parse_nvidia_csv_skips_short_lines() {
        let stdout = "junk line\nRTX 4090, 24576, 537.13, 8.9\nanother junk";
        let gpus = parse_nvidia_csv(stdout);
        assert_eq!(gpus.len(), 1);
    }

    #[test]
    fn parse_nvidia_csv_empty_input() {
        assert_eq!(parse_nvidia_csv("").len(), 0);
        assert_eq!(parse_nvidia_csv("\n\n").len(), 0);
    }

    #[test]
    fn probe_returns_at_least_skeleton() {
        let spec = probe();
        // Whatever happens, OS / CPU skeleton must be filled.
        assert!(!spec.os.name.is_empty());
        assert!(!spec.os.arch.is_empty());
        assert!(spec.cpu.cores >= 1);
    }

    #[test]
    fn spec_serializes_empty_gpu_as_empty_array() {
        let spec = Spec::default();
        let json = serde_json::to_string(&spec).unwrap();
        // Must include "gpu":[] not "gpu":null — matches Go's custom
        // MarshalJSON shape so the model sees the same wire format.
        assert!(json.contains("\"gpu\":[]"), "got: {json}");
    }
}

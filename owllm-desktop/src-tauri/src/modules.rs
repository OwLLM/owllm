//! Module system — manifest types, resolver, ModuleManager + Tauri commands.
//!
//! Spec: `data/modules/SCHEMA.md` at the repo root. The shell ships
//! ~80 MB; everything else (llama-server binaries, Python runtime,
//! fine-tuning env, MCP toolchain, audio STT) is downloaded as a
//! module after install.
//!
//! Storage layout under `app_data_dir()/modules/`:
//!   installed.json                     — what's installed for this user
//!   <variant-id>-<version>/            — extracted module payload
//!   .previous/<variant-id>-<old-ver>/  — N-1 cached for rollback
//!   .staging/<download-id>.zip         — partial downloads
//!   registry.cache.json                — last successful registry fetch

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const SCHEMA_VERSION: u32 = 1;

pub const REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/OwLLM/owllm/main/data/modules/registry.json";

const REGISTRY_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

// ---------- registry.json (upstream, served via raw.githubusercontent) ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Registry {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "registryVersion")]
    pub registry_version: String,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    pub channels: Vec<Channel>,
    pub modules: Vec<Module>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Beta,
    Nightly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Module {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub description: String,
    pub category: Category,
    #[serde(default)]
    pub required: bool,
    #[serde(rename = "uiSlots", default)]
    pub ui_slots: Vec<String>,
    #[serde(rename = "dependsOn", default)]
    pub depends_on: Vec<String>,
    pub variants: Vec<Variant>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Runtime,
    Training,
    Audio,
    Bridge,
    Content,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Variant {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub platform: Platform,
    #[serde(default)]
    pub requires: Requirements,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    pub channels: BTreeMap<Channel, Release>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Platform {
    #[serde(rename = "windows-x86_64")]
    WindowsX86_64,
    #[serde(rename = "windows-aarch64")]
    WindowsAarch64,
    #[serde(rename = "linux-x86_64")]
    LinuxX86_64,
    #[serde(rename = "linux-aarch64")]
    LinuxAarch64,
    #[serde(rename = "macos-aarch64")]
    MacOsAarch64,
    /// Forward-compat catch-all: a platform string this build doesn't know
    /// yet (the registry is fetched live from main, so it can gain new
    /// platforms before every installed app updates). Deserializing it must
    /// not fail the WHOLE registry parse — the unknown variant simply never
    /// matches the host, so it's skipped by the resolver.
    #[serde(other, rename = "unknown")]
    Unknown,
}

impl Platform {
    pub fn host() -> Self {
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        {
            Platform::WindowsX86_64
        }
        // Native Windows-on-ARM builds. (An x64 build running under
        // emulation still reports windows-x86_64 — correct, since it can
        // only launch x64 child binaries anyway.)
        #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
        {
            Platform::WindowsAarch64
        }
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            Platform::LinuxX86_64
        }
        #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
        {
            Platform::LinuxAarch64
        }
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            Platform::MacOsAarch64
        }
        // No silent fallback: claiming another platform makes the resolver
        // hand out binaries that can't run here (an aarch64 build used to
        // masquerade as windows-x86_64 and download Windows llama-server).
        // A new target must be added to the enum + registry explicitly.
        #[cfg(not(any(
            all(target_os = "windows", target_arch = "x86_64"),
            all(target_os = "windows", target_arch = "aarch64"),
            all(target_os = "linux", target_arch = "x86_64"),
            all(target_os = "linux", target_arch = "aarch64"),
            all(target_os = "macos", target_arch = "aarch64"),
        )))]
        {
            compile_error!(
                "unsupported target: add it to modules::Platform and the module registry"
            );
        }
    }

    /// Registry identifier + human arch label, for user-facing messages
    /// ("no build published for linux-aarch64 (ARM64) yet").
    pub fn id(&self) -> &'static str {
        match self {
            Platform::WindowsX86_64 => "windows-x86_64",
            Platform::WindowsAarch64 => "windows-aarch64",
            Platform::LinuxX86_64 => "linux-x86_64",
            Platform::LinuxAarch64 => "linux-aarch64",
            Platform::MacOsAarch64 => "macos-aarch64",
            Platform::Unknown => "unknown",
        }
    }

    pub fn arch_label(&self) -> &'static str {
        match self {
            Platform::WindowsX86_64 | Platform::LinuxX86_64 => "x64",
            Platform::WindowsAarch64 | Platform::LinuxAarch64 | Platform::MacOsAarch64 => "ARM64",
            Platform::Unknown => "unknown arch",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Requirements {
    #[serde(default)]
    pub gpu: Option<GpuVendor>,
    #[serde(rename = "vramGb", default)]
    pub vram_gb: Option<u32>,
    #[serde(rename = "ramGb", default)]
    pub ram_gb: Option<u32>,
    #[serde(rename = "diskGb", default)]
    pub disk_gb: Option<u32>,
    /// Minimum CUDA major version the installed *driver* must support.
    /// Gates CUDA builds so e.g. a JetPack 6 Orin (driver CUDA 12) falls
    /// back to the CPU variant instead of a CUDA-13 binary it can't load.
    #[serde(rename = "cudaMajorMin", default)]
    pub cuda_major_min: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Apple,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Release {
    pub version: String,
    #[serde(rename = "releasedAt")]
    pub released_at: String,
    #[serde(rename = "downloadUrl")]
    pub download_url: String,
    pub sha256: String,
    #[serde(rename = "minShellVersion")]
    pub min_shell_version: String,
    #[serde(default)]
    pub signature: Option<String>,
}

// ---------- installed.json (per-user, in app_data_dir/modules/) ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Installed {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "updateChannel")]
    pub update_channel: Channel,
    pub modules: BTreeMap<String, InstalledModule>,
}

impl Default for Installed {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            update_channel: Channel::Stable,
            modules: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledModule {
    pub variant: String,
    pub version: String,
    #[serde(default)]
    pub channel: Option<Channel>,
    #[serde(rename = "installedAt")]
    pub installed_at: String,
    pub path: String,
    pub sha256: String,
    #[serde(rename = "previousVersion", default)]
    pub previous_version: Option<String>,
}

// ---------- hardware snapshot (built from hardware::HardwareInfo) ----------

#[derive(Debug, Clone, Serialize)]
pub struct HardwareSnapshot {
    pub platform: Platform,
    pub gpu_vendor: Option<GpuVendor>,
    pub vram_gb: u32,
    pub ram_gb: u32,
    pub free_disk_gb: u32,
    /// CUDA major version the installed NVIDIA driver supports (from the
    /// nvidia-smi banner). None when there is no NVIDIA driver.
    pub cuda_major: Option<u32>,
}

impl HardwareSnapshot {
    /// Full async probe — hardware + CUDA driver version. This is what
    /// every install/list path should use so `cudaMajorMin` gating works.
    pub async fn probe() -> Self {
        let hw = crate::hardware::hardware_info().await.unwrap_or_default();
        let cuda_major = crate::hardware::cuda_driver_version()
            .await
            .and_then(|v| v.split('.').next().and_then(|m| m.parse().ok()));
        let mut snap = Self::from_probe(&hw);
        snap.cuda_major = cuda_major;
        snap
    }

    pub fn from_probe(hw: &crate::hardware::HardwareInfo) -> Self {
        let (gpu_vendor, vram_gb) = hw
            .gpus
            .iter()
            .max_by_key(|g| g.vram_gb as u64)
            .map(|g| {
                let name = g.name.to_lowercase();
                let vendor =
                    if name.contains("nvidia") || name.contains("rtx") || name.contains("gtx") {
                        Some(GpuVendor::Nvidia)
                    } else if name.contains("apple") {
                        Some(GpuVendor::Apple)
                    } else if name.contains("amd") || name.contains("radeon") {
                        Some(GpuVendor::Amd)
                    } else if name.contains("intel") || name.contains("arc") {
                        Some(GpuVendor::Intel)
                    } else {
                        None
                    };
                (vendor, g.vram_gb as u32)
            })
            .unwrap_or((None, 0));
        Self {
            platform: Platform::host(),
            gpu_vendor,
            vram_gb,
            ram_gb: hw.ram_total_gb as u32,
            free_disk_gb: probe_free_disk_gb().unwrap_or(50), // generous default
            cuda_major: None,
        }
    }
}

fn probe_free_disk_gb() -> Option<u32> {
    // Cheap approach: ignore. Most install failures here would be obvious
    // (out of disk) and we want to err on the side of showing modules
    // as installable. Tighten later if needed.
    None
}

// ---------- resolver ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum ResolveError {
    NoMatchingPlatform,
    NoSatisfiableVariant { failed: Vec<(String, String)> },
    NoChannelRelease,
}

pub fn resolve_variant<'m>(
    module: &'m Module,
    hardware: &HardwareSnapshot,
    channel: Channel,
) -> Result<(&'m Variant, &'m Release), ResolveError> {
    let on_platform: Vec<&Variant> = module
        .variants
        .iter()
        .filter(|v| v.platform == hardware.platform)
        .collect();
    if on_platform.is_empty() {
        return Err(ResolveError::NoMatchingPlatform);
    }

    let mut failed: Vec<(String, String)> = Vec::new();
    let mut scored: Vec<(u32, &Variant)> = Vec::new();
    for v in on_platform {
        match check_requirements(&v.requires, hardware) {
            Ok(()) => scored.push((score_variant(v), v)),
            Err(reason) => failed.push((v.id.clone(), reason)),
        }
    }
    if scored.is_empty() {
        return Err(ResolveError::NoSatisfiableVariant { failed });
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    let chosen = scored[0].1;
    let release = chosen
        .channels
        .get(&channel)
        .ok_or(ResolveError::NoChannelRelease)?;
    Ok((chosen, release))
}

fn check_requirements(req: &Requirements, hw: &HardwareSnapshot) -> Result<(), String> {
    if let Some(gpu) = req.gpu {
        if hw.gpu_vendor != Some(gpu) {
            return Err(format!("requires {:?} GPU, found {:?}", gpu, hw.gpu_vendor));
        }
    }
    if let Some(min) = req.vram_gb {
        if hw.vram_gb < min {
            return Err(format!("requires {min} GB VRAM, has {}", hw.vram_gb));
        }
    }
    if let Some(min) = req.ram_gb {
        if hw.ram_gb < min {
            return Err(format!("requires {min} GB RAM, has {}", hw.ram_gb));
        }
    }
    if let Some(min) = req.disk_gb {
        if hw.free_disk_gb < min {
            return Err(format!(
                "requires {min} GB free disk, has {}",
                hw.free_disk_gb
            ));
        }
    }
    if let Some(min) = req.cuda_major_min {
        match hw.cuda_major {
            Some(have) if have >= min => {}
            Some(have) => {
                return Err(format!(
                    "requires a CUDA {min}+ driver, this driver supports CUDA {have}"
                ))
            }
            None => return Err(format!("requires a CUDA {min}+ NVIDIA driver, none detected")),
        }
    }
    Ok(())
}

fn score_variant(v: &Variant) -> u32 {
    if v.id.contains("cuda") {
        300
    } else if v.id.contains("vulkan") {
        200
    } else if v.id.contains("cpu") {
        100
    } else {
        50
    }
}

/// Topo-sort dependencies. Returns module ids in install order (deps first).
pub fn topo_install_order<'r>(
    registry: &'r Registry,
    target: &str,
) -> Result<Vec<&'r Module>, String> {
    let by_id: BTreeMap<&str, &Module> = registry
        .modules
        .iter()
        .map(|m| (m.id.as_str(), m))
        .collect();
    let mut visited: std::collections::BTreeSet<String> = Default::default();
    let mut visiting: std::collections::BTreeSet<String> = Default::default();
    let mut out: Vec<&Module> = Vec::new();
    fn visit<'r>(
        id: &str,
        by_id: &BTreeMap<&str, &'r Module>,
        visited: &mut std::collections::BTreeSet<String>,
        visiting: &mut std::collections::BTreeSet<String>,
        out: &mut Vec<&'r Module>,
    ) -> Result<(), String> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id.to_string()) {
            return Err(format!("dependency cycle through {id}"));
        }
        let m = by_id
            .get(id)
            .ok_or_else(|| format!("unknown module: {id}"))?;
        for dep in &m.depends_on {
            visit(dep, by_id, visited, visiting, out)?;
        }
        visiting.remove(id);
        visited.insert(id.to_string());
        out.push(m);
        Ok(())
    }
    visit(target, &by_id, &mut visited, &mut visiting, &mut out)?;
    Ok(out)
}

// ---------- ModuleStatus (joins registry + installed + hardware) ----------

#[derive(Debug, Clone, Serialize)]
pub struct ModuleStatus {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub description: String,
    pub category: Category,
    #[serde(rename = "uiSlots")]
    pub ui_slots: Vec<String>,
    #[serde(rename = "dependsOn")]
    pub depends_on: Vec<String>,
    pub state: ModuleState,
    #[serde(rename = "recommendedVariant")]
    pub recommended_variant: Option<String>,
    #[serde(rename = "recommendedSizeBytes")]
    pub recommended_size_bytes: Option<u64>,
    #[serde(rename = "installedVersion")]
    pub installed_version: Option<String>,
    #[serde(rename = "availableVersion")]
    pub available_version: Option<String>,
    #[serde(rename = "blockReasons")]
    pub block_reasons: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ModuleState {
    NotInstalled,
    Installed,
    UpdateAvailable,
    NotSupported, // hardware can't run any variant
}

// ---------- ModuleManager ----------

pub struct ModuleManager {
    root: PathBuf,
    installed: Mutex<Installed>,
    cached_registry: Mutex<Option<Registry>>,
}

impl ModuleManager {
    pub fn new<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir: {e}"))?;
        let root = app_data.join("modules");
        fs::create_dir_all(&root).map_err(|e| format!("create modules root: {e}"))?;
        fs::create_dir_all(root.join(".staging")).ok();
        fs::create_dir_all(root.join(".previous")).ok();
        let installed = load_installed(&root);
        Ok(Self {
            root,
            installed: Mutex::new(installed),
            cached_registry: Mutex::new(None),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn variant_path(&self, module_id: &str) -> Option<PathBuf> {
        let installed = self.installed.lock().ok()?;
        let im = installed.modules.get(module_id)?;
        Some(self.root.join(&im.path))
    }

    pub fn channel(&self) -> Channel {
        self.installed
            .lock()
            .map(|i| i.update_channel)
            .unwrap_or(Channel::Stable)
    }

    pub async fn fetch_registry(&self) -> Result<Registry, String> {
        let client = reqwest::Client::builder()
            .timeout(REGISTRY_FETCH_TIMEOUT)
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        match client.get(REGISTRY_URL).send().await {
            Ok(resp) if resp.status().is_success() => {
                let text = resp.text().await.map_err(|e| format!("read body: {e}"))?;
                let reg: Registry =
                    serde_json::from_str(&text).map_err(|e| format!("parse registry: {e}"))?;
                // Cache to disk.
                let cache_path = self.root.join("registry.cache.json");
                let _ = fs::write(&cache_path, &text);
                *self.cached_registry.lock().unwrap() = Some(reg.clone());
                Ok(reg)
            }
            _ => {
                // Network or non-2xx — fall back to disk cache.
                let cache_path = self.root.join("registry.cache.json");
                if let Ok(text) = fs::read_to_string(&cache_path) {
                    if let Ok(reg) = serde_json::from_str::<Registry>(&text) {
                        return Ok(reg);
                    }
                }
                // Last-ditch: bundled fallback embedded at compile time.
                let bundled = include_str!("../../../data/modules/registry.json");
                serde_json::from_str(bundled).map_err(|e| format!("bundled registry parse: {e}"))
            }
        }
    }

    pub async fn list(&self, hardware: &HardwareSnapshot) -> Result<Vec<ModuleStatus>, String> {
        let registry = self.fetch_registry().await?;
        let channel = self.channel();
        let installed = self.installed.lock().unwrap().clone();
        let mut out = Vec::with_capacity(registry.modules.len());
        for m in &registry.modules {
            let installed_m = installed.modules.get(&m.id);
            let resolution = resolve_variant(m, hardware, channel);
            let (state, recommended_variant, recommended_size, available_version, block_reasons) =
                match (&resolution, installed_m) {
                    (Ok((v, r)), Some(im)) => {
                        let state = if im.version == r.version {
                            ModuleState::Installed
                        } else {
                            ModuleState::UpdateAvailable
                        };
                        (
                            state,
                            Some(v.id.clone()),
                            Some(v.size_bytes),
                            Some(r.version.clone()),
                            vec![],
                        )
                    }
                    (Ok((v, r)), None) => (
                        ModuleState::NotInstalled,
                        Some(v.id.clone()),
                        Some(v.size_bytes),
                        Some(r.version.clone()),
                        vec![],
                    ),
                    (Err(ResolveError::NoSatisfiableVariant { failed }), _) => {
                        (ModuleState::NotSupported, None, None, None, failed.clone())
                    }
                    (Err(_), _) => (
                        ModuleState::NotSupported,
                        None,
                        None,
                        None,
                        vec![(
                            "platform".into(),
                            format!(
                                "no build published for {} ({}) yet",
                                hardware.platform.id(),
                                hardware.platform.arch_label()
                            ),
                        )],
                    ),
                };
            out.push(ModuleStatus {
                id: m.id.clone(),
                display_name: m.display_name.clone(),
                description: m.description.clone(),
                category: m.category,
                ui_slots: m.ui_slots.clone(),
                depends_on: m.depends_on.clone(),
                state,
                recommended_variant,
                recommended_size_bytes: recommended_size,
                installed_version: installed_m.map(|im| im.version.clone()),
                available_version,
                block_reasons,
            });
        }
        Ok(out)
    }

    pub async fn install<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        module_id: &str,
        hardware: &HardwareSnapshot,
    ) -> Result<InstalledModule, String> {
        let registry = self.fetch_registry().await?;
        let channel = self.channel();
        let chain = topo_install_order(&registry, module_id)?;
        let mut last: Option<InstalledModule> = None;
        for m in chain {
            let (variant, release) = resolve_variant(m, hardware, channel)
                .map_err(|e| format!("resolve {}: {:?}", m.id, e))?;

            // Skip if already at same version.
            {
                let installed = self.installed.lock().unwrap();
                if let Some(im) = installed.modules.get(&m.id) {
                    if im.version == release.version {
                        last = Some(im.clone());
                        emit_progress(
                            app,
                            &m.id,
                            ProgressEvent::Skipped {
                                reason: "already at target version".into(),
                            },
                        );
                        continue;
                    }
                }
            }

            emit_progress(
                app,
                &m.id,
                ProgressEvent::Started {
                    variant: variant.id.clone(),
                    version: release.version.clone(),
                    size_bytes: variant.size_bytes,
                },
            );

            // Download to staging.
            let staging = self
                .root
                .join(".staging")
                .join(format!("{}-{}.zip", variant.id, release.version));
            download_with_progress(
                app,
                &m.id,
                &release.download_url,
                &staging,
                variant.size_bytes,
            )
            .await?;

            // Verify hash.
            emit_progress(app, &m.id, ProgressEvent::Verifying);
            verify_sha256(&staging, &release.sha256)?;

            // Extract to <variant-id>-<version>/.
            let dest_dir_name = format!("{}-{}", variant.id, release.version);
            let dest = self.root.join(&dest_dir_name);

            // Rotate existing → .previous/ for rollback.
            if dest.exists() {
                let prev = self.root.join(".previous").join(&dest_dir_name);
                let _ = fs::remove_dir_all(&prev);
                fs::rename(&dest, &prev).map_err(|e| format!("rotate to previous: {e}"))?;
            }

            emit_progress(app, &m.id, ProgressEvent::Extracting);
            extract_zip(&staging, &dest)?;
            let _ = fs::remove_file(&staging);

            // Record in installed.json.
            let im = InstalledModule {
                variant: variant.id.clone(),
                version: release.version.clone(),
                channel: Some(channel),
                installed_at: chrono::Utc::now().to_rfc3339(),
                path: dest_dir_name.clone(),
                sha256: release.sha256.clone(),
                previous_version: self
                    .installed
                    .lock()
                    .unwrap()
                    .modules
                    .get(&m.id)
                    .map(|p| p.version.clone()),
            };
            {
                let mut installed = self.installed.lock().unwrap();
                installed.modules.insert(m.id.clone(), im.clone());
                save_installed(&self.root, &installed)?;
            }
            emit_progress(app, &m.id, ProgressEvent::Completed);
            last = Some(im);
        }
        last.ok_or_else(|| "no module installed".into())
    }

    pub fn uninstall(&self, module_id: &str) -> Result<(), String> {
        let mut installed = self.installed.lock().unwrap();
        let im = installed
            .modules
            .remove(module_id)
            .ok_or_else(|| format!("not installed: {module_id}"))?;
        let _ = fs::remove_dir_all(self.root.join(&im.path));
        save_installed(&self.root, &installed)?;
        Ok(())
    }

    pub fn set_channel(&self, channel: Channel) -> Result<(), String> {
        let mut installed = self.installed.lock().unwrap();
        installed.update_channel = channel;
        save_installed(&self.root, &installed)
    }
}

// ---------- progress events ----------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "stage", rename_all = "kebab-case")]
pub enum ProgressEvent {
    Started {
        variant: String,
        version: String,
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
    },
    Downloading {
        #[serde(rename = "bytesDone")]
        bytes_done: u64,
        #[serde(rename = "bytesTotal")]
        bytes_total: u64,
    },
    Verifying,
    Extracting,
    Completed,
    Skipped {
        reason: String,
    },
    Failed {
        error: String,
    },
}

#[derive(Debug, Clone, Serialize)]
struct ProgressPayload {
    module: String,
    #[serde(flatten)]
    event: ProgressEvent,
}

fn emit_progress<R: Runtime>(app: &AppHandle<R>, module_id: &str, event: ProgressEvent) {
    let _ = app.emit(
        "module-progress",
        ProgressPayload {
            module: module_id.to_string(),
            event,
        },
    );
}

// ---------- download / verify / extract helpers ----------

async fn download_with_progress<R: Runtime>(
    app: &AppHandle<R>,
    module_id: &str,
    url: &str,
    dest: &Path,
    expected_size: u64,
) -> Result<(), String> {
    use futures_util::StreamExt;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GET {url}: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(expected_size);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).ok();
    }
    let mut file = fs::File::create(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream chunk: {e}"))?;
        file.write_all(&chunk).map_err(|e| format!("write: {e}"))?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emit > 1_000_000 || downloaded == total {
            emit_progress(
                app,
                module_id,
                ProgressEvent::Downloading {
                    bytes_done: downloaded,
                    bytes_total: total,
                },
            );
            last_emit = downloaded;
        }
    }
    Ok(())
}

fn verify_sha256(path: &Path, expected_hex: &str) -> Result<(), String> {
    // Zero-hash sentinel skips verification — used while registry hashes
    // are placeholders during initial publish. Once real hashes land,
    // any tampering or corruption is caught.
    if expected_hex.chars().all(|c| c == '0') {
        return Ok(());
    }
    let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut h = Sha256::new();
    h.update(&bytes);
    let got = h.finalize();
    let got_hex = got.iter().map(|b| format!("{b:02x}")).collect::<String>();
    if got_hex.eq_ignore_ascii_case(expected_hex) {
        Ok(())
    } else {
        Err(format!(
            "sha256 mismatch: expected {expected_hex}, got {got_hex}"
        ))
    }
}

fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    let file = fs::File::open(zip_path).map_err(|e| format!("open {}: {e}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip open: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip entry {i}: {e}"))?;
        let rel = entry
            .enclosed_name()
            .ok_or_else(|| format!("unsafe zip entry: {}", entry.name()))?
            .to_owned();
        let out_path = dest.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).ok();
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).ok();
            }
            let mut out = fs::File::create(&out_path)
                .map_err(|e| format!("create {}: {e}", out_path.display()))?;
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| format!("extract {}: {e}", out_path.display()))?;
            // Restore unix modes so llama-server & friends stay executable.
            // Zips repacked on Windows carry no modes — default those to
            // 0755, which is correct for module payloads (binaries + libs).
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = entry.unix_mode().unwrap_or(0o755);
                let _ = fs::set_permissions(&out_path, fs::Permissions::from_mode(mode));
            }
        }
    }
    Ok(())
}

// ---------- installed.json IO ----------

fn load_installed(root: &Path) -> Installed {
    let path = root.join("installed.json");
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_installed(root: &Path, installed: &Installed) -> Result<(), String> {
    let path = root.join("installed.json");
    let text = serde_json::to_string_pretty(installed)
        .map_err(|e| format!("serialize installed.json: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &text).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename installed.json: {e}"))
}

// ---------- Tauri commands ----------

#[tauri::command]
pub async fn module_list<R: Runtime>(app: AppHandle<R>) -> Result<Vec<ModuleStatus>, String> {
    let manager = app.state::<ModuleManager>();
    let snap = HardwareSnapshot::probe().await;
    manager.list(&snap).await
}

#[tauri::command]
pub async fn module_hardware_snapshot() -> Result<HardwareSnapshot, String> {
    Ok(HardwareSnapshot::probe().await)
}

#[tauri::command]
pub async fn module_install<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<InstalledModule, String> {
    let manager = app.state::<ModuleManager>().inner();
    // Re-fetch hardware so the wizard's earlier snapshot can't go stale.
    let snap = HardwareSnapshot::probe().await;
    let app2 = app.clone();
    let id_clone = id.clone();
    let result = manager.install(&app2, &id, &snap).await;
    if let Err(e) = &result {
        emit_progress(&app, &id_clone, ProgressEvent::Failed { error: e.clone() });
    }
    result
}

#[tauri::command]
pub async fn module_uninstall<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    app.state::<ModuleManager>().uninstall(&id)
}

#[tauri::command]
pub async fn module_set_channel<R: Runtime>(
    app: AppHandle<R>,
    channel: Channel,
) -> Result<(), String> {
    app.state::<ModuleManager>().set_channel(channel)
}

#[tauri::command]
pub async fn module_variant_path<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<Option<String>, String> {
    Ok(app
        .state::<ModuleManager>()
        .variant_path(&id)
        .map(|p| p.to_string_lossy().to_string()))
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn rtx_3090() -> HardwareSnapshot {
        HardwareSnapshot {
            platform: Platform::WindowsX86_64,
            gpu_vendor: Some(GpuVendor::Nvidia),
            vram_gb: 24,
            ram_gb: 64,
            free_disk_gb: 500,
            cuda_major: Some(12),
        }
    }

    fn cpu_only_laptop() -> HardwareSnapshot {
        HardwareSnapshot {
            platform: Platform::WindowsX86_64,
            gpu_vendor: None,
            vram_gb: 0,
            ram_gb: 16,
            free_disk_gb: 100,
            cuda_major: None,
        }
    }

    fn apple_silicon() -> HardwareSnapshot {
        HardwareSnapshot {
            platform: Platform::MacOsAarch64,
            gpu_vendor: Some(GpuVendor::Apple),
            vram_gb: 24, // unified budget (75 % of 32 GB RAM)
            ram_gb: 32,
            free_disk_gb: 200,
            cuda_major: None,
        }
    }

    fn linux_nvidia() -> HardwareSnapshot {
        HardwareSnapshot {
            platform: Platform::LinuxX86_64,
            gpu_vendor: Some(GpuVendor::Nvidia),
            vram_gb: 24,
            ram_gb: 64,
            free_disk_gb: 500,
            cuda_major: Some(12),
        }
    }

    fn linux_headless() -> HardwareSnapshot {
        HardwareSnapshot {
            platform: Platform::LinuxX86_64,
            gpu_vendor: None,
            vram_gb: 0,
            ram_gb: 16,
            free_disk_gb: 100,
            cuda_major: None,
        }
    }

    /// Jetson AGX Thor: JetPack 7, unified memory, driver supports CUDA 13.
    fn jetson_thor() -> HardwareSnapshot {
        HardwareSnapshot {
            platform: Platform::LinuxAarch64,
            gpu_vendor: Some(GpuVendor::Nvidia),
            vram_gb: 92,
            ram_gb: 122,
            free_disk_gb: 800,
            cuda_major: Some(13),
        }
    }

    /// Jetson Orin on JetPack 6: driver only supports CUDA 12, so the
    /// CUDA-13 build must NOT be offered — CPU fallback instead.
    fn jetson_orin_jp6() -> HardwareSnapshot {
        HardwareSnapshot {
            platform: Platform::LinuxAarch64,
            gpu_vendor: Some(GpuVendor::Nvidia),
            vram_gb: 24,
            ram_gb: 32,
            free_disk_gb: 200,
            cuda_major: Some(12),
        }
    }

    /// Non-Jetson ARM64 (Raspberry Pi / ARM server): no NVIDIA driver.
    fn arm64_no_gpu() -> HardwareSnapshot {
        HardwareSnapshot {
            platform: Platform::LinuxAarch64,
            gpu_vendor: None,
            vram_gb: 0,
            ram_gb: 8,
            free_disk_gb: 100,
            cuda_major: None,
        }
    }

    fn parse_registry() -> Registry {
        let raw = include_str!("../../../data/modules/registry.json");
        serde_json::from_str(raw).expect("registry.json parses against types")
    }

    #[test]
    fn registry_parses() {
        let r = parse_registry();
        assert_eq!(r.schema_version, SCHEMA_VERSION);
        for id in [
            "local-inference",
            "audio-stt",
            "python-runtime",
            "finetune",
            "mcp-toolchain",
            "tools-python",
        ] {
            assert!(r.modules.iter().any(|m| m.id == id), "missing module: {id}");
        }
    }

    #[test]
    fn finetune_depends_on_python_runtime() {
        let r = parse_registry();
        let ft = r.modules.iter().find(|m| m.id == "finetune").unwrap();
        assert!(ft.depends_on.iter().any(|d| d == "python-runtime"));
    }

    #[test]
    fn rtx_3090_gets_cuda_inference() {
        let r = parse_registry();
        let m = r
            .modules
            .iter()
            .find(|m| m.id == "local-inference")
            .unwrap();
        let (v, _) = resolve_variant(m, &rtx_3090(), Channel::Stable).unwrap();
        assert_eq!(v.id, "local-inference-cuda");
    }

    #[test]
    fn cpu_laptop_gets_cpu_inference_not_cuda() {
        let r = parse_registry();
        let m = r
            .modules
            .iter()
            .find(|m| m.id == "local-inference")
            .unwrap();
        let (v, _) = resolve_variant(m, &cpu_only_laptop(), Channel::Stable).unwrap();
        assert_eq!(v.id, "local-inference-cpu");
    }

    #[test]
    fn apple_silicon_gets_metal_inference() {
        let r = parse_registry();
        let m = r
            .modules
            .iter()
            .find(|m| m.id == "local-inference")
            .unwrap();
        let (v, _) = resolve_variant(m, &apple_silicon(), Channel::Stable).unwrap();
        assert_eq!(v.id, "local-inference-metal");
    }

    #[test]
    fn linux_gpu_gets_vulkan_inference() {
        let r = parse_registry();
        let m = r
            .modules
            .iter()
            .find(|m| m.id == "local-inference")
            .unwrap();
        let (v, _) = resolve_variant(m, &linux_nvidia(), Channel::Stable).unwrap();
        assert_eq!(v.id, "local-inference-linux-vulkan");
    }

    #[test]
    fn jetson_thor_gets_arm64_cuda_inference() {
        let r = parse_registry();
        let m = r
            .modules
            .iter()
            .find(|m| m.id == "local-inference")
            .unwrap();
        let (v, _) = resolve_variant(m, &jetson_thor(), Channel::Stable).unwrap();
        assert_eq!(v.id, "local-inference-linux-arm64-cuda");
    }

    #[test]
    fn jetson_orin_jp6_falls_back_to_arm64_cpu() {
        let r = parse_registry();
        let m = r
            .modules
            .iter()
            .find(|m| m.id == "local-inference")
            .unwrap();
        let (v, _) = resolve_variant(m, &jetson_orin_jp6(), Channel::Stable).unwrap();
        assert_eq!(v.id, "local-inference-linux-arm64-cpu");
    }

    #[test]
    fn arm64_without_gpu_gets_arm64_cpu() {
        let r = parse_registry();
        let m = r
            .modules
            .iter()
            .find(|m| m.id == "local-inference")
            .unwrap();
        let (v, _) = resolve_variant(m, &arm64_no_gpu(), Channel::Stable).unwrap();
        assert_eq!(v.id, "local-inference-linux-arm64-cpu");
    }

    #[test]
    fn arm64_runtime_modules_resolve() {
        // python-runtime, mcp-toolchain, and audio-stt must all have an
        // installable linux-aarch64 variant (the ARM64 gap this closes).
        let r = parse_registry();
        for (id, expect) in [
            ("python-runtime", "python-3.11-embed-linux-arm64"),
            ("mcp-toolchain", "mcp-toolchain-node-uv-linux-arm64"),
            ("audio-stt", "audio-stt-whisper-cli-linux-arm64"),
        ] {
            let m = r.modules.iter().find(|m| m.id == id).unwrap();
            let (v, _) = resolve_variant(m, &arm64_no_gpu(), Channel::Stable)
                .unwrap_or_else(|e| panic!("{id} unresolvable on linux-aarch64: {e:?}"));
            assert_eq!(v.id, expect);
        }
    }

    #[test]
    fn macos_runtime_modules_resolve() {
        // python-runtime, mcp-toolchain, and audio-stt must all have an
        // installable macos-aarch64 variant (same gap the ARM64 Linux
        // variants closed — the Mac wizard showed everything but
        // local-inference as "no variant for this OS").
        let r = parse_registry();
        for (id, expect) in [
            ("python-runtime", "python-3.11-embed-macos-arm64"),
            ("mcp-toolchain", "mcp-toolchain-node-uv-macos-arm64"),
            ("audio-stt", "audio-stt-whisper-cli-macos-arm64"),
        ] {
            let m = r.modules.iter().find(|m| m.id == id).unwrap();
            let (v, _) = resolve_variant(m, &apple_silicon(), Channel::Stable)
                .unwrap_or_else(|e| panic!("{id} unresolvable on macos-aarch64: {e:?}"));
            assert_eq!(v.id, expect);
        }
    }

    #[test]
    fn windows_arm64_degrades_with_arch_named() {
        // No windows-aarch64 builds are published yet — the resolver must
        // say so (NoMatchingPlatform → the wizard names the arch) rather
        // than hand out an x64 binary.
        let r = parse_registry();
        let win_arm = HardwareSnapshot {
            platform: Platform::WindowsAarch64,
            gpu_vendor: None,
            vram_gb: 0,
            ram_gb: 16,
            free_disk_gb: 100,
            cuda_major: None,
        };
        let m = r
            .modules
            .iter()
            .find(|m| m.id == "local-inference")
            .unwrap();
        assert_eq!(
            resolve_variant(m, &win_arm, Channel::Stable).unwrap_err(),
            ResolveError::NoMatchingPlatform
        );
    }

    #[test]
    fn linux_headless_gets_cpu_inference() {
        let r = parse_registry();
        let m = r
            .modules
            .iter()
            .find(|m| m.id == "local-inference")
            .unwrap();
        let (v, _) = resolve_variant(m, &linux_headless(), Channel::Stable).unwrap();
        assert_eq!(v.id, "local-inference-linux-cpu");
    }

    #[test]
    fn unknown_registry_platform_does_not_break_parsing() {
        // The registry is fetched live from main, so it can gain platforms
        // (e.g. linux-aarch64 module builds) before every installed app
        // updates. An unknown platform string must parse as Unknown and be
        // skipped — never fail the whole registry.
        let raw = r#"{
            "id": "x", "displayName": "x", "platform": "linux-riscv64",
            "sizeBytes": 1, "channels": {}
        }"#;
        let v: Variant = serde_json::from_str(raw).expect("unknown platform parses");
        assert_eq!(v.platform, Platform::Unknown);
        assert_ne!(v.platform, Platform::host());
    }

    #[test]
    fn linux_aarch64_gets_arm64_build_not_windows() {
        // An ARM64 Linux host must resolve its own build — the old
        // Platform::host() fallback claimed windows-x86_64 there, which
        // made the resolver install Windows zips on Jetson-class boxes.
        let hw = HardwareSnapshot {
            platform: Platform::LinuxAarch64,
            gpu_vendor: Some(GpuVendor::Nvidia), // Jetson-class unified SoC
            vram_gb: 48,
            ram_gb: 64,
            free_disk_gb: 100,
            cuda_major: None, // no CUDA-13 driver detected → CPU build
        };
        let r = parse_registry();
        let m = r
            .modules
            .iter()
            .find(|m| m.id == "local-inference")
            .unwrap();
        let (v, _) = resolve_variant(m, &hw, Channel::Stable).unwrap();
        assert_eq!(v.id, "local-inference-linux-arm64-cpu");
    }

    #[test]
    fn cpu_laptop_cannot_finetune() {
        let r = parse_registry();
        let m = r.modules.iter().find(|m| m.id == "finetune").unwrap();
        let err = resolve_variant(m, &cpu_only_laptop(), Channel::Stable).unwrap_err();
        match err {
            ResolveError::NoSatisfiableVariant { failed } => {
                assert!(failed
                    .iter()
                    .any(|(_, why)| why.contains("Nvidia") || why.contains("GPU")));
            }
            other => panic!("expected NoSatisfiableVariant, got {other:?}"),
        }
    }

    #[test]
    fn finetune_topo_includes_python_runtime_first() {
        let r = parse_registry();
        let chain = topo_install_order(&r, "finetune").unwrap();
        assert_eq!(chain[0].id, "python-runtime");
        assert_eq!(chain.last().unwrap().id, "finetune");
    }

    #[test]
    fn mcp_toolchain_topo_includes_python_runtime() {
        let r = parse_registry();
        let chain = topo_install_order(&r, "mcp-toolchain").unwrap();
        let ids: Vec<&str> = chain.iter().map(|m| m.id.as_str()).collect();
        assert!(ids.contains(&"python-runtime"));
        assert!(ids.contains(&"mcp-toolchain"));
    }
}

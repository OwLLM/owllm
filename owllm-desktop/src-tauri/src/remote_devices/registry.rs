// "My OwLLM Devices" — the local metadata store of known devices. This is the
// PUBLIC registry: names, OS, version, capabilities, last-seen. It never holds
// secrets and never carries commands (control flows through the sealed
// transport, not this file). Intended to be fed by a vault sync channel later;
// v1 populates it locally (self + paired peers).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::protocol::{DevicePublic, DeviceRecord};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RegistryFile {
    #[serde(default)]
    devices: Vec<DeviceRecord>,
}

fn registry_path() -> Result<PathBuf, String> {
    crate::paths::user_data_root()
        .map(|r| r.join("remote_devices_registry.json"))
        .ok_or_else(|| "could not resolve app data dir for device registry".to_string())
}

fn load_file() -> RegistryFile {
    // Fail-soft: an unreadable/corrupt registry is treated as empty rather than
    // wedging the page.
    registry_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<RegistryFile>(&t).ok())
        .unwrap_or_default()
}

fn save_file(f: &RegistryFile) -> Result<(), String> {
    let path = registry_path()?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let txt = serde_json::to_string_pretty(f).map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| format!("write device registry: {e}"))
}

/// Insert or update a known device's public metadata. `is_self` marks this
/// machine's own record.
pub fn upsert(public: DevicePublic, is_self: bool) -> Result<(), String> {
    let mut f = load_file();
    match f.devices.iter_mut().find(|d| d.public.device_id == public.device_id) {
        Some(existing) => {
            existing.public = public;
            existing.is_self = is_self;
        }
        None => f.devices.push(DeviceRecord { public, last_seen: None, is_self }),
    }
    save_file(&f)
}

/// Update a device's last-seen to now (called whenever we accept a frame from it).
pub fn touch_last_seen(device_id: &str) -> Result<(), String> {
    let mut f = load_file();
    if let Some(d) = f.devices.iter_mut().find(|d| d.public.device_id == device_id) {
        d.last_seen = Some(crate::remote_devices::now_rfc3339());
        save_file(&f)?;
    }
    Ok(())
}

/// Remove a device from the registry.
pub fn forget(device_id: &str) -> Result<(), String> {
    let mut f = load_file();
    f.devices.retain(|d| d.public.device_id != device_id);
    save_file(&f)
}

/// The full device list with THIS device guaranteed present + marked self.
pub fn list(self_public: &DevicePublic) -> Vec<DeviceRecord> {
    let mut f = load_file();
    if let Some(me) = f.devices.iter_mut().find(|d| d.public.device_id == self_public.device_id) {
        me.public = self_public.clone();
        me.is_self = true;
    } else {
        f.devices.push(DeviceRecord {
            public: self_public.clone(),
            last_seen: None,
            is_self: true,
        });
    }
    f.devices
}

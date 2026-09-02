// "My OwLLM Devices" — the local metadata store of known devices. This is the
// PUBLIC registry: names, OS, version, capabilities, last-seen. It never holds
// secrets and never carries commands (control flows through the sealed
// transport, not this file). Fed locally (self + paired peers) and by the vault
// device sync.
//
// The store is deliberately dumb; every rule about WHICH rows are real lives in
// `canonical.rs`, which is pure and independently executed by `devices-harness`.
// This file only decides when to read, write and prune.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::canonical::{self, Tombstone};
use super::protocol::{DevicePublic, DeviceRecord};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RegistryFile {
    #[serde(default)]
    devices: Vec<DeviceRecord>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TombstoneFile {
    #[serde(default)]
    tombstones: Vec<Tombstone>,
}

fn registry_path() -> Result<PathBuf, String> {
    crate::paths::user_data_root()
        .map(|r| r.join("remote_devices_registry.json"))
        .ok_or_else(|| "could not resolve app data dir for device registry".to_string())
}

fn tombstone_path() -> Result<PathBuf, String> {
    crate::paths::user_data_root()
        .map(|r| r.join("remote_devices_tombstones.json"))
        .ok_or_else(|| "could not resolve app data dir for device tombstones".to_string())
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

/// Every device the user has deleted on ANY of their PCs (the vault sync merges
/// peers' tombstones into this file).
pub fn tombstones() -> Vec<Tombstone> {
    tombstone_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<TombstoneFile>(&t).ok())
        .unwrap_or_default()
        .tombstones
}

fn save_tombstones(list: &[Tombstone]) -> Result<(), String> {
    let path = tombstone_path()?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let txt = serde_json::to_string_pretty(&TombstoneFile {
        tombstones: list.to_vec(),
    })
    .map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| format!("write device tombstones: {e}"))
}

/// Insert or update a known device's public metadata. `is_self` marks this
/// machine's own record.
///
/// A peer record that the canonical rules would immediately discard — a
/// tombstoned device, or a dead identity of a machine we already list — is NOT
/// written. Filtering here rather than at read time is the whole point: the
/// vault keeps one `state/devices/<id>.json` per dead identity forever, so
/// anything that merely prunes the file is undone by the next sync.
/// Returns true when the record was actually stored.
pub fn upsert(public: DevicePublic, is_self: bool) -> Result<bool, String> {
    let mut f = load_file();
    if !is_self {
        // A machine that heartbeats after you deleted it is asking to come
        // back; drop the tombstone so it stops travelling through the vault.
        let mut tombs = tombstones();
        let before = tombs.len();
        tombs.retain(|t| !canonical::clears_tombstone(&public, t));
        if tombs.len() != before {
            save_tombstones(&tombs)?;
        }
        if !canonical::accepts_ingest(&public, &f.devices, &tombs) {
            return Ok(false);
        }
    }
    write_record(&mut f, public, is_self)?;
    Ok(true)
}

/// Store a peer we just completed a pairing handshake with.
///
/// A live handshake is the strongest possible statement that the device is back,
/// so it clears any tombstone rather than being filtered by it — otherwise a
/// device you deleted last month could be re-paired successfully and still never
/// appear, which is the deletion bug in reverse.
pub fn upsert_paired(public: DevicePublic) -> Result<(), String> {
    let mut tombs = tombstones();
    let before = tombs.len();
    tombs.retain(|t| {
        t.device_id != public.device_id
            && match (t.machine_key.as_deref(), canonical::machine_key_of(&public)) {
                (Some(a), Some(b)) => a != b,
                _ => true,
            }
    });
    if tombs.len() != before {
        save_tombstones(&tombs)?;
    }
    let mut f = load_file();
    write_record(&mut f, public, false)
}

fn write_record(f: &mut RegistryFile, public: DevicePublic, is_self: bool) -> Result<(), String> {
    match f
        .devices
        .iter_mut()
        .find(|d| d.public.device_id == public.device_id)
    {
        Some(existing) => {
            existing.public = public;
            existing.is_self = is_self;
        }
        None => f.devices.push(DeviceRecord {
            public,
            last_seen: None,
            is_self,
        }),
    }
    save_file(f)
}

/// Update a device's last-seen to now (called whenever we accept a frame from it).
pub fn touch_last_seen(device_id: &str) -> Result<(), String> {
    let mut f = load_file();
    if let Some(d) = f
        .devices
        .iter_mut()
        .find(|d| d.public.device_id == device_id)
    {
        d.last_seen = Some(crate::remote_devices::now_rfc3339());
        save_file(&f)?;
    }
    Ok(())
}

/// Remove a device and record WHY it is gone.
///
/// Returns the tombstone so the caller can publish it to the vault; without
/// that, deleting a row only lasted until the next sync re-read the dead
/// identity's still-present record file.
pub fn forget(device_id: &str) -> Result<Tombstone, String> {
    let mut f = load_file();
    if f.devices
        .iter()
        .any(|d| d.public.device_id == device_id && d.is_self)
    {
        return Err("this is the machine you are using — it cannot be removed".into());
    }
    let gone = f
        .devices
        .iter()
        .find(|d| d.public.device_id == device_id)
        .map(|d| d.public.clone());
    f.devices.retain(|d| d.public.device_id != device_id);
    save_file(&f)?;

    let tombstone = Tombstone {
        device_id: device_id.to_string(),
        machine_key: gone
            .as_ref()
            .and_then(|p| canonical::machine_key_of(p).map(str::to_string)),
        name: gone.map(|p| p.name).unwrap_or_default(),
        deleted_at: crate::remote_devices::now_rfc3339(),
    };
    let merged = canonical::merge_tombstones(tombstones(), vec![tombstone.clone()]);
    save_tombstones(&merged)?;
    Ok(tombstone)
}

/// Apply deletions made on the user's OTHER machines: merge them into the local
/// tombstone set and drop the rows they cover. Returns true when anything
/// changed locally.
pub fn apply_tombstones(remote: Vec<Tombstone>) -> Result<bool, String> {
    let merged = canonical::merge_tombstones(tombstones(), remote);
    let mut f = load_file();
    let before = f.devices.len();
    f.devices
        .retain(|d| d.is_self || canonical::suppressed_by(&d.public, &merged).is_none());
    let pruned = f.devices.len() != before;
    if pruned {
        save_file(&f)?;
    }
    let changed_tombstones = merged != tombstones();
    if changed_tombstones {
        save_tombstones(&merged)?;
    }
    Ok(pruned || changed_tombstones)
}

/// The canonical device list — one row per machine, with THIS device guaranteed
/// present and marked self. Both "My OwLLM Devices" and the World Map fleet
/// render exactly this collection, so a row can never exist in one view and not
/// the other.
///
/// Also compacts the file when the canonical set is smaller, so a registry that
/// accumulated dead identities under an older build heals on first read instead
/// of needing the user to delete 27 rows by hand.
pub fn list(self_public: &DevicePublic) -> Vec<DeviceRecord> {
    let mut f = load_file();
    if let Some(me) = f
        .devices
        .iter_mut()
        .find(|d| d.public.device_id == self_public.device_id)
    {
        me.public = self_public.clone();
        me.is_self = true;
    } else {
        f.devices.push(DeviceRecord {
            public: self_public.clone(),
            last_seen: None,
            is_self: true,
        });
    }
    // Exactly one self row: an older identity of this machine may still be
    // flagged from a previous install.
    for d in f.devices.iter_mut() {
        d.is_self = d.public.device_id == self_public.device_id;
    }
    let raw = f.devices.len();
    let canonical = canonical::canonicalize(f.devices, &tombstones());
    if canonical.len() < raw {
        let _ = save_file(&RegistryFile {
            devices: canonical.clone(),
        });
    }
    canonical
}

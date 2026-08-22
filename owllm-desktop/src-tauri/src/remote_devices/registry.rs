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
    save_file(&f)
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

/// Remove a device from the registry.
pub fn forget(device_id: &str) -> Result<(), String> {
    let mut f = load_file();
    f.devices.retain(|d| d.public.device_id != device_id);
    save_file(&f)
}

/// Freshness of a record in epoch seconds: the newest of its vault-publish
/// heartbeat and the last frame we actually saw from it. Never-published,
/// never-seen records rank oldest.
fn freshness_epoch(rec: &DeviceRecord) -> i64 {
    let parse = |s: Option<&str>| {
        s.and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.timestamp())
    };
    parse(rec.public.published_at.as_deref())
        .into_iter()
        .chain(parse(rec.last_seen.as_deref()))
        .max()
        .unwrap_or(i64::MIN)
}

/// Self first, then freshest-first. Re-pairing a machine mints a NEW device_id,
/// so one name can accumulate dead identities; every name→device resolution
/// (agent_device_exec and the localTools device_exec/device_screenshot
/// resolvers) takes the FIRST match from this list, so this ordering is what
/// makes a duplicated name resolve to the machine's live identity instead of a
/// stale leftover.
fn order_for_resolution(devices: &mut [DeviceRecord]) {
    devices.sort_by_key(|d| (!d.is_self, std::cmp::Reverse(freshness_epoch(d))));
}

/// The full device list with THIS device guaranteed present + marked self.
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
    order_for_resolution(&mut f.devices);
    f.devices
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(name: &str, id: &str, published: Option<&str>, seen: Option<&str>, is_self: bool) -> DeviceRecord {
        DeviceRecord {
            public: DevicePublic {
                device_id: id.into(),
                name: name.into(),
                published_at: published.map(String::from),
                ..Default::default()
            },
            last_seen: seen.map(String::from),
            is_self,
        }
    }

    #[test]
    fn duplicate_name_resolves_to_freshest_identity() {
        // The zeusthor1 trap: four dead re-pair identities share one name.
        // File order put a dead one first; resolution must see the live one first.
        let mut devs = vec![
            rec("zeusthor1", "dead1", Some("2026-08-09T14:07:41+00:00"), None, false),
            rec("zeusthor1", "dead2", Some("2026-08-09T14:15:43+00:00"), None, false),
            rec("zeusthor1", "live", Some("2026-08-20T02:50:05+00:00"), None, false),
            rec("zeusthor1", "dead3", Some("2026-08-09T14:20:29+00:00"), None, false),
        ];
        order_for_resolution(&mut devs);
        let first = devs
            .iter()
            .find(|d| !d.is_self && d.public.name.eq_ignore_ascii_case("zeusthor1"))
            .unwrap();
        assert_eq!(first.public.device_id, "live");
    }

    #[test]
    fn last_seen_counts_as_freshness() {
        // A record we heard from beats one that only published earlier.
        let mut devs = vec![
            rec("pc", "published-old", Some("2026-08-10T00:00:00+00:00"), None, false),
            rec("pc", "seen-recent", Some("2026-08-01T00:00:00+00:00"), Some("2026-08-19T23:00:13+00:00"), false),
        ];
        order_for_resolution(&mut devs);
        assert_eq!(devs[0].public.device_id, "seen-recent");
    }

    #[test]
    fn self_record_stays_first_and_dateless_records_sink() {
        let mut devs = vec![
            rec("ghost", "no-dates", None, None, false),
            rec("live", "fresh", Some("2026-08-20T12:00:00+00:00"), None, false),
            rec("me", "self", None, None, true),
        ];
        order_for_resolution(&mut devs);
        assert!(devs[0].is_self);
        assert_eq!(devs[1].public.device_id, "fresh");
        assert_eq!(devs[2].public.device_id, "no-dates");
    }
}

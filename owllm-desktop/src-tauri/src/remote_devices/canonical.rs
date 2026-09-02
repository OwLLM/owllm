//! The canonical device collection: at most ONE row per physical machine.
//!
//! `device_id` is `hex(SHA-256(ed25519_pub))` — stable per *keypair*, not per
//! machine. Reinstalling, moving the app-data dir, or losing the identity file
//! mints a brand-new keypair, so one PC accumulates one dead identity per
//! re-pair. Every one of them keeps its own `state/devices/<id>.json` in the
//! account vault, so `vault_sync_devices` faithfully re-ingests the whole
//! graveyard on every beat: deleting a row from the local registry could never
//! stick. On the machine this was written from, 9 real devices were showing as
//! 36 rows (17 of them one Windows PC) in both "My OwLLM Devices" and the World
//! Map "My Fleet" orbit.
//!
//! Two mechanisms fix that, and they are deliberately separate:
//!
//! * `machine_key` — a stable per-MACHINE id (see `identity::machine_key`)
//!   published alongside the keypair id. Records sharing one are the same
//!   machine, full stop, however many times it re-paired.
//! * `Tombstone` — an explicit user deletion, synced through the vault so every
//!   PC applies it, and stamped with `deleted_at` so a *stale* copy of the
//!   record stays dead while a machine that genuinely heartbeats afterwards is
//!   still allowed back.
//!
//! Legacy rows predate `machine_key` and will never gain one (their identity is
//! dead — it cannot publish again), so they are collapsed by `name|os|arch`
//! instead. That heuristic can in principle merge two different PCs that share
//! a hostname, which is why it only ever eats KEYLESS rows: the moment either
//! machine runs a build with `machine_key` it publishes one and is grouped by
//! that instead, so the collapse self-heals rather than hiding a device.
//!
//! Pure module — no Tauri, no filesystem, no clock. `devices-harness` compiles
//! it directly (`#[path]`) so these rules are executed, not just reviewed.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::protocol::{DevicePublic, DeviceRecord};

/// A device the user deleted. Synced through the vault (`state/devices/
/// tombstones/<id>.json`) so the deletion reaches every PC instead of being
/// undone by the next machine that pushes its stale registry.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Tombstone {
    pub device_id: String,
    /// The deleted device's `machine_key`, when it published one. Lets the
    /// deletion also cover a stale record the same machine left behind under a
    /// different keypair id.
    #[serde(default)]
    pub machine_key: Option<String>,
    /// Last known name — for the UI only; matching never uses it.
    #[serde(default)]
    pub name: String,
    /// RFC3339 instant of the deletion. Records that heartbeat AFTER this are
    /// live devices announcing themselves, not the stale copy we removed.
    pub deleted_at: String,
}

/// RFC3339 → epoch seconds.
pub fn epoch(stamp: Option<&str>) -> Option<i64> {
    stamp
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.timestamp())
}

/// Freshness of a record in epoch seconds: the newest of its vault-publish
/// heartbeat and the last frame we actually saw from it. Never-published,
/// never-seen records rank oldest.
pub fn freshness_epoch(rec: &DeviceRecord) -> i64 {
    epoch(rec.public.published_at.as_deref())
        .into_iter()
        .chain(epoch(rec.last_seen.as_deref()))
        .max()
        .unwrap_or(i64::MIN)
}

/// The record's stable machine id, or None when it predates `machine_key`.
pub fn machine_key_of(public: &DevicePublic) -> Option<&str> {
    public
        .machine_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
}

/// Grouping key for KEYLESS legacy records: `name|os|arch`, case-folded. None
/// when there is no name at all — such a record identifies nothing and is never
/// merged into anything.
///
/// `identity::LEGACY_PLACEHOLDER_NAME` ("This OwLLM PC") gets no special case on
/// purpose. It is a poor display name but a perfectly good grouping key for the
/// dead identities stamped with it, and `identity::load_or_create` rewrites it
/// on the first launch of a build that can ask the OS — so no live device keeps
/// it, and any that somehow does is separated by `os|arch` and re-appears under
/// its own `machine_key` the moment it publishes.
pub fn legacy_group(public: &DevicePublic) -> Option<String> {
    let name = public.name.trim().to_lowercase();
    if name.is_empty() {
        return None;
    }
    Some(format!(
        "{name}|{}|{}",
        public.os.trim().to_lowercase(),
        public.arch.trim().to_lowercase()
    ))
}

/// Self first, then freshest-first, then by id so the order is total (two
/// records stamped in the same second must not swap between calls — the
/// resolution winner has to be reproducible).
///
/// Every name→device resolution (`agent_device_exec` and the localTools
/// `device_exec`/`device_screenshot` resolvers) takes the FIRST match from this
/// list, so this ordering is what makes a duplicated name resolve to the
/// machine's live identity instead of a stale leftover.
pub fn order_for_resolution(devices: &mut [DeviceRecord]) {
    devices.sort_by(|a, b| {
        a.is_self
            .cmp(&b.is_self)
            .reverse()
            .then_with(|| freshness_epoch(a).cmp(&freshness_epoch(b)).reverse())
            .then_with(|| a.public.device_id.cmp(&b.public.device_id))
    });
}

/// The tombstone that keeps this record out, if any.
///
/// A tombstone matches on the deleted keypair id, or on the deleted machine's
/// `machine_key`. It only BLOCKS records whose heartbeat is at or before the
/// deletion: that is the whole stale-vs-live distinction. A dead identity's
/// `published_at` is frozen in the past, so its vault file stays suppressed
/// forever; a machine that publishes again after you deleted it is making a new
/// statement about itself and is let back in (`clears_tombstone`).
pub fn suppressed_by<'a>(
    public: &DevicePublic,
    tombstones: &'a [Tombstone],
) -> Option<&'a Tombstone> {
    tombstones.iter().find(|t| {
        let same_identity = t.device_id == public.device_id;
        let same_machine = match (t.machine_key.as_deref(), machine_key_of(public)) {
            (Some(a), Some(b)) => !a.trim().is_empty() && a == b,
            _ => false,
        };
        if !same_identity && !same_machine {
            return false;
        }
        match (
            epoch(public.published_at.as_deref()),
            epoch(Some(&t.deleted_at)),
        ) {
            // Published after the deletion → the device is alive and speaking.
            (Some(published), Some(deleted)) => published <= deleted,
            // No heartbeat at all → it can only be the copy we removed.
            _ => true,
        }
    })
}

/// True when this record supersedes its own tombstone — the machine heartbeat
/// after the deletion. The caller drops the tombstone so it stops travelling
/// through the vault killing a device that is demonstrably back.
pub fn clears_tombstone(public: &DevicePublic, tombstone: &Tombstone) -> bool {
    let matches = tombstone.device_id == public.device_id
        || matches!(
            (tombstone.machine_key.as_deref(), machine_key_of(public)),
            (Some(a), Some(b)) if a == b
        );
    matches
        && match (
            epoch(public.published_at.as_deref()),
            epoch(Some(&tombstone.deleted_at)),
        ) {
            (Some(published), Some(deleted)) => published > deleted,
            _ => false,
        }
}

/// Collapse a raw registry into the canonical collection both the Devices list
/// and the World Map fleet render.
///
/// 1. Tombstoned records are dropped (never `is_self` — you cannot delete the
///    machine you are sitting at, and `registry::list` re-adds it anyway).
/// 2. Records sharing a `machine_key` collapse to the freshest one.
/// 3. A keyless legacy record is dropped when its `name|os|arch` group already
///    holds a keyed record (that machine has migrated — the keyless row is one
///    of its dead identities) or a fresher keyless record.
/// 4. A record with neither a key nor a name is never merged into anything.
///
/// Deterministic: the input is totally ordered first, so the survivor of any
/// group is the same on every call and on every PC.
pub fn canonicalize(records: Vec<DeviceRecord>, tombstones: &[Tombstone]) -> Vec<DeviceRecord> {
    let mut ordered = records;
    order_for_resolution(&mut ordered);

    // Legacy groups that a migrated (keyed) identity already speaks for.
    let migrated: HashSet<String> = ordered
        .iter()
        .filter(|r| r.is_self || machine_key_of(&r.public).is_some())
        .filter_map(|r| legacy_group(&r.public))
        .collect();

    let mut seen_keys: HashSet<&str> = HashSet::new();
    let mut seen_groups: HashSet<String> = HashSet::new();
    let mut kept: Vec<DeviceRecord> = Vec::with_capacity(ordered.len());
    for rec in &ordered {
        if !rec.is_self && suppressed_by(&rec.public, tombstones).is_some() {
            continue;
        }
        match machine_key_of(&rec.public) {
            Some(key) => {
                if !seen_keys.insert(key) {
                    continue;
                }
                if let Some(group) = legacy_group(&rec.public) {
                    seen_groups.insert(group);
                }
            }
            None => {
                if let Some(group) = legacy_group(&rec.public) {
                    let superseded = migrated.contains(&group) || seen_groups.contains(&group);
                    if superseded && !rec.is_self {
                        continue;
                    }
                    seen_groups.insert(group);
                }
            }
        }
        kept.push(rec.clone());
    }
    kept
}

/// Whether a peer record arriving from the vault should be written to the local
/// registry at all.
///
/// This is the door the resurrection came through: pruning the registry is
/// pointless while the next sync happily re-inserts every dead identity's JSON
/// file. A record that `canonicalize` would immediately drop is not stored in
/// the first place.
pub fn accepts_ingest(
    incoming: &DevicePublic,
    existing: &[DeviceRecord],
    tombstones: &[Tombstone],
) -> bool {
    let mut all: Vec<DeviceRecord> = existing
        .iter()
        .filter(|d| d.public.device_id != incoming.device_id)
        .cloned()
        .collect();
    all.push(DeviceRecord {
        public: incoming.clone(),
        last_seen: None,
        is_self: false,
    });
    canonicalize(all, tombstones)
        .iter()
        .any(|d| d.public.device_id == incoming.device_id)
}

/// Merge a pulled tombstone set into the local one: newest deletion per device
/// wins, and a tombstone the live record has already cleared is dropped.
pub fn merge_tombstones(local: Vec<Tombstone>, remote: Vec<Tombstone>) -> Vec<Tombstone> {
    let mut merged: Vec<Tombstone> = Vec::new();
    for candidate in local.into_iter().chain(remote) {
        match merged
            .iter_mut()
            .find(|t| t.device_id == candidate.device_id)
        {
            Some(existing) => {
                if epoch(Some(&candidate.deleted_at)) > epoch(Some(&existing.deleted_at)) {
                    *existing = candidate;
                }
            }
            None => merged.push(candidate),
        }
    }
    merged.sort_by(|a, b| a.device_id.cmp(&b.device_id));
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(
        name: &str,
        id: &str,
        published: Option<&str>,
        seen: Option<&str>,
        is_self: bool,
    ) -> DeviceRecord {
        DeviceRecord {
            public: DevicePublic {
                device_id: id.into(),
                name: name.into(),
                os: "windows".into(),
                arch: "x86_64".into(),
                published_at: published.map(String::from),
                ..Default::default()
            },
            last_seen: seen.map(String::from),
            is_self,
        }
    }

    fn keyed(mut r: DeviceRecord, key: &str) -> DeviceRecord {
        r.public.machine_key = Some(key.into());
        r
    }

    fn ids(records: &[DeviceRecord]) -> Vec<String> {
        records.iter().map(|r| r.public.device_id.clone()).collect()
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
            rec(
                "pc",
                "seen-recent",
                Some("2026-08-01T00:00:00+00:00"),
                Some("2026-08-19T23:00:13+00:00"),
                false,
            ),
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

    #[test]
    fn ordering_is_total_so_the_winner_never_flips() {
        let build = || {
            vec![
                rec("pc", "bbb", Some("2026-08-20T12:00:00+00:00"), None, false),
                rec("pc", "aaa", Some("2026-08-20T12:00:00+00:00"), None, false),
            ]
        };
        let mut one = build();
        let mut two = build();
        two.reverse();
        order_for_resolution(&mut one);
        order_for_resolution(&mut two);
        assert_eq!(ids(&one), ids(&two));
        assert_eq!(one[0].public.device_id, "aaa");
    }

    #[test]
    fn repeated_logins_from_one_machine_collapse_to_one_row() {
        let devs = vec![
            keyed(rec("pc", "login1", Some("2026-08-01T00:00:00+00:00"), None, false), "m1"),
            keyed(rec("pc", "login2", Some("2026-08-02T00:00:00+00:00"), None, false), "m1"),
            keyed(rec("pc", "login3", Some("2026-08-03T00:00:00+00:00"), None, false), "m1"),
        ];
        assert_eq!(ids(&canonicalize(devs, &[])), vec!["login3"]);
    }

    #[test]
    fn a_renamed_machine_is_still_one_row() {
        let devs = vec![
            keyed(rec("old-name", "a", Some("2026-08-01T00:00:00+00:00"), None, false), "m1"),
            keyed(rec("new-name", "b", Some("2026-08-09T00:00:00+00:00"), None, false), "m1"),
        ];
        assert_eq!(ids(&canonicalize(devs, &[])), vec!["b"]);
    }

    #[test]
    fn two_machines_sharing_a_hostname_both_survive_once_keyed() {
        let devs = vec![
            keyed(rec("DESKTOP-X", "a", Some("2026-08-01T00:00:00+00:00"), None, false), "m1"),
            keyed(rec("DESKTOP-X", "b", Some("2026-08-02T00:00:00+00:00"), None, false), "m2"),
        ];
        let out = canonicalize(devs, &[]);
        assert_eq!(out.len(), 2, "distinct machine keys must never be merged");
    }

    #[test]
    fn legacy_keyless_identities_collapse_onto_the_migrated_one() {
        // The live shape: 16 dead pre-machine_key identities + the migrated self.
        let mut devs: Vec<DeviceRecord> = (0..16)
            .map(|i| {
                rec(
                    "DESKTOP-FKSSKS3",
                    &format!("dead{i:02}"),
                    Some("2026-08-27T10:00:00+00:00"),
                    None,
                    false,
                )
            })
            .collect();
        devs.push(keyed(
            rec("DESKTOP-FKSSKS3", "me", None, None, true),
            "m-self",
        ));
        let out = canonicalize(devs, &[]);
        assert_eq!(ids(&out), vec!["me"]);
    }

    #[test]
    fn legacy_group_keeps_the_freshest_when_nothing_migrated_yet() {
        let devs = vec![
            rec("zeusthor1", "d1", Some("2026-08-09T14:07:41+00:00"), None, false),
            rec("zeusthor1", "d2", Some("2026-08-09T14:15:43+00:00"), None, false),
            rec("zeusthor1", "d3", Some("2026-08-09T14:20:29+00:00"), None, false),
        ];
        assert_eq!(ids(&canonicalize(devs, &[])), vec!["d3"]);
    }

    #[test]
    fn a_different_os_is_a_different_machine() {
        let devs = vec![
            rec("This OwLLM PC", "win", Some("2026-08-01T00:00:00+00:00"), None, false),
            {
                let mut r = rec("This OwLLM PC", "linux", Some("2026-08-02T00:00:00+00:00"), None, false);
                r.public.os = "linux".into();
                r
            },
        ];
        assert_eq!(canonicalize(devs, &[]).len(), 2);
    }

    #[test]
    fn a_nameless_keyless_record_is_never_merged() {
        let devs = vec![
            rec("", "ghost-a", Some("2026-08-01T00:00:00+00:00"), None, false),
            rec("", "ghost-b", Some("2026-08-02T00:00:00+00:00"), None, false),
        ];
        assert_eq!(canonicalize(devs, &[]).len(), 2);
    }

    #[test]
    fn deleting_a_device_survives_the_stale_vault_copy() {
        let stale = rec("gone", "g1", Some("2026-08-01T00:00:00+00:00"), None, false);
        let tombs = vec![Tombstone {
            device_id: "g1".into(),
            machine_key: None,
            name: "gone".into(),
            deleted_at: "2026-08-20T00:00:00+00:00".into(),
        }];
        assert!(canonicalize(vec![stale.clone()], &tombs).is_empty());
        assert!(!accepts_ingest(&stale.public, &[], &tombs));
    }

    #[test]
    fn a_tombstone_also_covers_the_machines_other_identity() {
        let tombs = vec![Tombstone {
            device_id: "old-keypair".into(),
            machine_key: Some("m9".into()),
            name: "gone".into(),
            deleted_at: "2026-08-20T00:00:00+00:00".into(),
        }];
        let other = keyed(
            rec("gone", "another-keypair", Some("2026-08-19T00:00:00+00:00"), None, false),
            "m9",
        );
        assert!(canonicalize(vec![other], &tombs).is_empty());
    }

    #[test]
    fn a_device_that_heartbeats_after_deletion_comes_back() {
        let tombs = vec![Tombstone {
            device_id: "g1".into(),
            machine_key: None,
            name: "gone".into(),
            deleted_at: "2026-08-20T00:00:00+00:00".into(),
        }];
        let alive = rec("gone", "g1", Some("2026-08-21T00:00:00+00:00"), None, false);
        assert_eq!(ids(&canonicalize(vec![alive.clone()], &tombs)), vec!["g1"]);
        assert!(clears_tombstone(&alive.public, &tombs[0]));
        assert!(accepts_ingest(&alive.public, &[], &tombs));
    }

    #[test]
    fn deleting_never_removes_the_machine_you_are_sitting_at() {
        let me = rec("me", "self", None, None, true);
        let tombs = vec![Tombstone {
            device_id: "self".into(),
            machine_key: None,
            name: "me".into(),
            deleted_at: "2026-08-20T00:00:00+00:00".into(),
        }];
        assert_eq!(ids(&canonicalize(vec![me], &tombs)), vec!["self"]);
    }

    #[test]
    fn a_stale_client_republishing_an_old_snapshot_does_not_resurrect() {
        // PC B never synced, still holds the deleted device, and pushes its copy
        // back into the vault verbatim — same frozen published_at.
        let tombs = vec![Tombstone {
            device_id: "g1".into(),
            machine_key: None,
            name: "gone".into(),
            deleted_at: "2026-08-20T00:00:00+00:00".into(),
        }];
        let stale = rec("gone", "g1", Some("2026-08-01T00:00:00+00:00"), None, false);
        let existing = vec![rec("keep", "k1", Some("2026-08-25T00:00:00+00:00"), None, false)];
        assert!(!accepts_ingest(&stale.public, &existing, &tombs));
        assert_eq!(ids(&canonicalize(existing, &tombs)), vec!["k1"]);
    }

    #[test]
    fn merging_tombstones_keeps_the_newest_deletion_per_device() {
        let local = vec![Tombstone {
            device_id: "g1".into(),
            machine_key: None,
            name: "gone".into(),
            deleted_at: "2026-08-20T00:00:00+00:00".into(),
        }];
        let remote = vec![
            Tombstone {
                device_id: "g1".into(),
                machine_key: None,
                name: "gone".into(),
                deleted_at: "2026-08-22T00:00:00+00:00".into(),
            },
            Tombstone {
                device_id: "g2".into(),
                machine_key: None,
                name: "other".into(),
                deleted_at: "2026-08-21T00:00:00+00:00".into(),
            },
        ];
        let merged = merge_tombstones(local, remote);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].deleted_at, "2026-08-22T00:00:00+00:00");
    }

    #[test]
    fn canonicalize_is_idempotent_and_order_independent() {
        let build = || {
            vec![
                keyed(rec("pc", "b", Some("2026-08-02T00:00:00+00:00"), None, false), "m1"),
                rec("pc", "legacy", Some("2026-08-01T00:00:00+00:00"), None, false),
                keyed(rec("pc", "a", Some("2026-08-03T00:00:00+00:00"), None, false), "m1"),
            ]
        };
        let once = canonicalize(build(), &[]);
        let twice = canonicalize(once.clone(), &[]);
        assert_eq!(ids(&once), ids(&twice));
        let mut shuffled = build();
        shuffled.reverse();
        assert_eq!(ids(&canonicalize(shuffled, &[])), ids(&once));
        assert_eq!(ids(&once), vec!["a"]);
    }
}

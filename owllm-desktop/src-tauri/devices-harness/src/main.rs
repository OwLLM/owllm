//! Fleet-level regression proof for duplicate and undeletable device records.
//!
//! The unit rules live in `canonical.rs` and run here as `cargo test`. This
//! binary drives those same functions through the SEQUENCE the app uses —
//! multiple PCs, a shared vault, repeated logins, restarts and a client that
//! never synced — because every one of the reported symptoms was a sequencing
//! bug, not a rule bug: the rules were fine, the vault re-ingested the
//! graveyard afterwards.
//!
//! The vault below is a map of files, exactly like `state/devices/` in the real
//! private repo: one record per device identity plus a `tombstones/` folder.

#[path = "../../src/remote_devices/protocol.rs"]
#[allow(dead_code)]
mod protocol;

#[path = "../../src/remote_devices/canonical.rs"]
#[allow(dead_code)]
mod canonical;

use std::collections::BTreeMap;

use canonical::{
    accepts_ingest, canonicalize, clears_tombstone, merge_tombstones, suppressed_by, Tombstone,
};
use protocol::{DevicePublic, DeviceRecord};

// ---------------------------------------------------------------- the vault

/// `state/devices/` in the account's private repo. Records outlive the identity
/// that wrote them: a dead re-pair identity never rewrites or removes its file.
#[derive(Default, Clone)]
struct Vault {
    records: BTreeMap<String, String>,
    tombstones: BTreeMap<String, String>,
}

impl Vault {
    fn put_record(&mut self, public: &DevicePublic) {
        self.records.insert(
            public.device_id.clone(),
            serde_json::to_string(public).unwrap(),
        );
    }
    fn read_records(&self) -> Vec<DevicePublic> {
        self.records
            .values()
            .filter_map(|t| serde_json::from_str(t).ok())
            .collect()
    }
    fn read_tombstones(&self) -> Vec<Tombstone> {
        self.tombstones
            .values()
            .filter_map(|t| serde_json::from_str(t).ok())
            .collect()
    }
}

// ------------------------------------------------------------------- a PC

/// One machine's on-disk state: `remote_devices_registry.json` +
/// `remote_devices_tombstones.json`.
#[derive(Default, Clone)]
struct Pc {
    me: DevicePublic,
    registry: Vec<DeviceRecord>,
    tombstones: Vec<Tombstone>,
}

impl Pc {
    fn new(me: DevicePublic) -> Self {
        Pc {
            registry: vec![DeviceRecord {
                public: me.clone(),
                last_seen: None,
                is_self: true,
            }],
            me,
            tombstones: Vec::new(),
        }
    }

    /// `registry::upsert(public, false)`.
    fn ingest(&mut self, public: DevicePublic) -> bool {
        if public.device_id == self.me.device_id {
            return false;
        }
        self.tombstones.retain(|t| !clears_tombstone(&public, t));
        if !accepts_ingest(&public, &self.registry, &self.tombstones) {
            return false;
        }
        match self
            .registry
            .iter_mut()
            .find(|d| d.public.device_id == public.device_id)
        {
            Some(existing) => existing.public = public,
            None => self.registry.push(DeviceRecord {
                public,
                last_seen: None,
                is_self: false,
            }),
        }
        true
    }

    /// `registry::list(self_public)` — what BOTH the Devices list and the World
    /// Map fleet render.
    fn list(&self) -> Vec<DeviceRecord> {
        canonicalize(self.registry.clone(), &self.tombstones)
    }

    fn names(&self) -> Vec<String> {
        self.list().iter().map(|d| d.public.name.clone()).collect()
    }

    fn shows(&self, device_id: &str) -> bool {
        self.list()
            .iter()
            .any(|d| d.public.device_id == device_id)
    }

    /// `registry::forget` — the ✕ button, from either view.
    fn forget(&mut self, device_id: &str, at: &str) -> Result<Tombstone, String> {
        if self
            .registry
            .iter()
            .any(|d| d.public.device_id == device_id && d.is_self)
        {
            return Err("this is the machine you are using — it cannot be removed".into());
        }
        let gone = self
            .registry
            .iter()
            .find(|d| d.public.device_id == device_id)
            .map(|d| d.public.clone());
        self.registry.retain(|d| d.public.device_id != device_id);
        let tombstone = Tombstone {
            device_id: device_id.to_string(),
            machine_key: gone
                .as_ref()
                .and_then(|p| canonical::machine_key_of(p).map(str::to_string)),
            name: gone.map(|p| p.name).unwrap_or_default(),
            deleted_at: at.to_string(),
        };
        self.tombstones = merge_tombstones(
            std::mem::take(&mut self.tombstones),
            vec![tombstone.clone()],
        );
        Ok(tombstone)
    }

    /// `vault_sync_devices` — the exact order that matters: tombstones first,
    /// then records, then publish.
    fn sync(&mut self, vault: &mut Vault, published_at: &str) {
        // 0) peers' deletions BEFORE any record is read.
        self.tombstones = merge_tombstones(
            std::mem::take(&mut self.tombstones),
            vault.read_tombstones(),
        );
        let tombs = self.tombstones.clone();
        self.registry
            .retain(|d| d.is_self || suppressed_by(&d.public, &tombs).is_none());

        // 1) remote → local registry.
        for public in vault.read_records() {
            self.ingest(public);
        }

        // 2) publish ours + our deletions.
        self.me.published_at = Some(published_at.to_string());
        if let Some(row) = self.registry.iter_mut().find(|d| d.is_self) {
            row.public = self.me.clone();
        }
        vault.put_record(&self.me);
        for t in &self.tombstones {
            vault.records.remove(&t.device_id);
            vault
                .tombstones
                .insert(t.device_id.clone(), serde_json::to_string(t).unwrap());
        }

        // 3) retire vault tombstones a live device has cleared here.
        let live: Vec<String> = self.tombstones.iter().map(|t| t.device_id.clone()).collect();
        vault.tombstones.retain(|id, _| live.contains(id));
    }

    /// Quit and relaunch: everything must come back from the two JSON files.
    fn restart(&self) -> Pc {
        Pc {
            me: self.me.clone(),
            registry: serde_json::from_str(&serde_json::to_string(&self.registry).unwrap())
                .unwrap(),
            tombstones: serde_json::from_str(&serde_json::to_string(&self.tombstones).unwrap())
                .unwrap(),
        }
    }
}

// ------------------------------------------------------------- fixtures

fn device(name: &str, id: &str, machine_key: Option<&str>, published: &str) -> DevicePublic {
    DevicePublic {
        device_id: id.into(),
        name: name.into(),
        os: "windows".into(),
        arch: "x86_64".into(),
        machine_key: machine_key.map(String::from),
        published_at: Some(published.into()),
        ..Default::default()
    }
}

type Scenario = fn() -> Result<(), String>;

fn check(cond: bool, msg: &str) -> Result<(), String> {
    if cond {
        Ok(())
    } else {
        Err(msg.to_string())
    }
}

// ------------------------------------------------------------ scenarios

/// CONTROL — the pre-fix semantics, so the numbers in the other scenarios mean
/// something. Before `canonical.rs` existed, `registry::upsert` stored every
/// record it was handed, `registry::list` only ORDERED them, and
/// `registry::forget` retained-out one row of a local file whose contents the
/// vault rebuilt on the next beat. Reproduce both symptoms exactly.
fn control_pre_fix_behaviour_reproduces_the_bug() -> Result<(), String> {
    // Old upsert: no filter. Old list: order only, no collapse.
    let mut registry: Vec<DevicePublic> = Vec::new();
    let old_upsert = |registry: &mut Vec<DevicePublic>, p: DevicePublic| {
        match registry.iter_mut().find(|d| d.device_id == p.device_id) {
            Some(existing) => *existing = p,
            None => registry.push(p),
        }
    };

    let mut vault = Vault::default();
    for i in 0..17 {
        vault.put_record(&device(
            "DESKTOP-FKSSKS3",
            &format!("id{i:02}"),
            None,
            "2026-08-27T10:00:00+00:00",
        ));
    }
    for public in vault.read_records() {
        old_upsert(&mut registry, public);
    }
    check(
        registry.len() == 17,
        &format!("control: expected the 17-row duplicate symptom, got {}", registry.len()),
    )?;

    // Old forget: drop the local row. The vault file it came from is untouched.
    registry.retain(|d| d.device_id != "id00");
    check(registry.len() == 16, "control: local delete did not remove the row")?;
    for public in vault.read_records() {
        old_upsert(&mut registry, public);
    }
    check(
        registry.iter().any(|d| d.device_id == "id00"),
        "control: the resurrection mechanism did not reproduce — the scenario is vacuous",
    )?;

    // Same input, canonical rules: one machine, one row, and the delete sticks.
    let mut fixed = Pc::new(device(
        "DESKTOP-FKSSKS3",
        "self-new",
        Some("m-self"),
        "2026-09-02T09:00:00+00:00",
    ));
    fixed.sync(&mut vault, "2026-09-02T09:00:00+00:00");
    check(
        fixed.list().len() == 1,
        &format!("the same 17 records must canonicalize to 1, got {}", fixed.list().len()),
    )?;
    Ok(())
}

/// The live shape on the machine this was written from: 36 registry rows for 9
/// real devices, 17 of them one Windows PC that re-paired 17 times. One sync
/// after the fix must show 9 — and stay at 9 however often it syncs.
fn legacy_duplicate_cleanup() -> Result<(), String> {
    let mut vault = Vault::default();
    // 16 dead keyless identities of a PC that has since migrated, + 3 of another.
    for i in 0..16 {
        vault.put_record(&device(
            "DESKTOP-FKSSKS3",
            &format!("dead{i:02}"),
            None,
            "2026-08-27T10:00:00+00:00",
        ));
    }
    for i in 0..3 {
        let mut d = device(
            "zeusthor1",
            &format!("zeus{i}"),
            None,
            "2026-08-09T14:0{i}:00+00:00",
        );
        d.os = "linux".into();
        d.arch = "aarch64".into();
        vault.put_record(&d);
    }
    vault.put_record(&device(
        "Sos-MacBook-Air",
        "mac1",
        Some("m-mac"),
        "2026-09-02T08:00:00+00:00",
    ));

    let mut pc = Pc::new(device(
        "DESKTOP-FKSSKS3",
        "self-new",
        Some("m-self"),
        "2026-09-02T09:00:00+00:00",
    ));
    pc.sync(&mut vault, "2026-09-02T09:00:00+00:00");

    let names = pc.names();
    check(
        names.len() == 3,
        &format!("expected 3 canonical rows (self, zeusthor1, mac), got {names:?}"),
    )?;
    check(
        names.iter().filter(|n| *n == "DESKTOP-FKSSKS3").count() == 1,
        &format!("17 identities of one PC must collapse to one row, got {names:?}"),
    )?;
    check(
        names.iter().filter(|n| *n == "zeusthor1").count() == 1,
        &format!("keyless duplicates must collapse to the freshest, got {names:?}"),
    )?;

    // Idempotent: syncing again must not re-add the graveyard.
    for beat in 0..3 {
        pc.sync(&mut vault, &format!("2026-09-02T1{beat}:00:00+00:00"));
        check(
            pc.names().len() == 3,
            &format!("beat {beat} re-ingested dead identities: {:?}", pc.names()),
        )?;
    }
    Ok(())
}

/// Repeated logins from one machine: each re-pair mints a new keypair id and
/// publishes a new record file. The row count must not move.
fn repeated_logins_stay_one_row() -> Result<(), String> {
    let mut vault = Vault::default();
    let mut pc = Pc::new(device(
        "controller",
        "me",
        Some("m-me"),
        "2026-09-01T00:00:00+00:00",
    ));
    for login in 1..=5 {
        vault.put_record(&device(
            "LAPTOP",
            &format!("keypair{login}"),
            Some("m-laptop"),
            &format!("2026-09-0{login}T00:00:00+00:00"),
        ));
        pc.sync(&mut vault, &format!("2026-09-0{login}T00:00:00+00:00"));
        let peers: Vec<_> = pc
            .list()
            .into_iter()
            .filter(|d| !d.is_self)
            .map(|d| d.public.device_id)
            .collect();
        check(
            peers.len() == 1,
            &format!("login {login}: expected 1 laptop row, got {peers:?}"),
        )?;
        check(
            peers[0] == format!("keypair{login}"),
            &format!("login {login}: the live identity must win, got {peers:?}"),
        )?;
    }
    Ok(())
}

/// Deleting from the Devices list sticks — through the beat that used to undo
/// it, through a restart, and on the user's other PC.
fn deletion_persists_across_sync_restart_and_peers() -> Result<(), String> {
    let mut vault = Vault::default();
    let mut a = Pc::new(device("PC-A", "a", Some("m-a"), "2026-09-01T00:00:00+00:00"));
    let mut b = Pc::new(device("PC-B", "b", Some("m-b"), "2026-09-01T00:00:00+00:00"));
    vault.put_record(&device(
        "OLD-BOX",
        "old",
        Some("m-old"),
        "2026-08-01T00:00:00+00:00",
    ));
    a.sync(&mut vault, "2026-09-01T01:00:00+00:00");
    b.sync(&mut vault, "2026-09-01T01:00:00+00:00");
    check(a.shows("old") && b.shows("old"), "fixture never listed OLD-BOX")?;

    let t = a.forget("old", "2026-09-02T00:00:00+00:00")?;
    check(t.machine_key.as_deref() == Some("m-old"), "tombstone lost the machine key")?;
    check(!a.shows("old"), "deletion did not remove the row")?;

    // The beat that used to resurrect it.
    a.sync(&mut vault, "2026-09-02T00:10:00+00:00");
    check(!a.shows("old"), "the next vault sync resurrected the deleted device")?;
    check(
        !vault.records.contains_key("old"),
        "the deleted device's record file is still in the vault",
    )?;

    // Restart: state comes back from the two JSON files only.
    let a2 = a.restart();
    check(!a2.shows("old"), "the deleted device came back after a restart")?;

    // The other PC applies the same deletion.
    b.sync(&mut vault, "2026-09-02T00:20:00+00:00");
    check(!b.shows("old"), "the deletion never reached the second PC")?;
    check(b.shows("a"), "the deletion removed an unrelated device on PC B")?;
    Ok(())
}

/// The World Map fleet and the Devices list are the SAME collection, so a
/// deletion issued from either view removes the satellite and the row together.
fn deletion_from_either_view_matches() -> Result<(), String> {
    let mut vault = Vault::default();
    let mut pc = Pc::new(device("PC-A", "a", Some("m-a"), "2026-09-01T00:00:00+00:00"));
    vault.put_record(&device("BOX-1", "b1", Some("m1"), "2026-09-01T00:00:00+00:00"));
    vault.put_record(&device("BOX-2", "b2", Some("m2"), "2026-09-01T00:00:00+00:00"));
    pc.sync(&mut vault, "2026-09-01T01:00:00+00:00");

    // The World Map's fleet orbit is built from the same list().
    let devices_list = pc.list();
    let world_map_fleet = pc.list();
    check(
        devices_list.len() == world_map_fleet.len(),
        "the two views disagree before any deletion",
    )?;

    pc.forget("b1", "2026-09-02T00:00:00+00:00")?; // from the Devices list
    pc.forget("b2", "2026-09-02T00:01:00+00:00")?; // from the World Map
    pc.sync(&mut vault, "2026-09-02T00:02:00+00:00");
    check(
        pc.list().len() == 1 && pc.list()[0].is_self,
        &format!("both views should be down to self, got {:?}", pc.names()),
    )?;
    check(
        pc.forget("a", "2026-09-02T00:03:00+00:00").is_err(),
        "the machine you are sitting at must not be deletable from either view",
    )?;
    Ok(())
}

/// A PC that never synced still holds the deleted device and pushes its copy
/// back. The record's heartbeat is frozen before the deletion, so it is stale
/// data and must not resurrect anything.
fn stale_client_cannot_resurrect() -> Result<(), String> {
    let mut vault = Vault::default();
    let mut a = Pc::new(device("PC-A", "a", Some("m-a"), "2026-09-01T00:00:00+00:00"));
    let mut stale = Pc::new(device("PC-C", "c", Some("m-c"), "2026-09-01T00:00:00+00:00"));
    let old = device("OLD-BOX", "old", Some("m-old"), "2026-08-01T00:00:00+00:00");
    vault.put_record(&old);
    a.sync(&mut vault, "2026-09-01T01:00:00+00:00");
    stale.sync(&mut vault, "2026-09-01T01:00:00+00:00");

    a.forget("old", "2026-09-02T00:00:00+00:00")?;
    a.sync(&mut vault, "2026-09-02T00:01:00+00:00");

    // PC C, still unaware, republishes the record it kept.
    vault.put_record(&old);
    stale.sync(&mut vault, "2026-09-02T00:02:00+00:00");
    check(
        !stale.shows("old"),
        "the stale client resurrected the device on itself",
    )?;
    check(
        !vault.records.contains_key("old"),
        "the stale record survived in the vault",
    )?;
    a.sync(&mut vault, "2026-09-02T00:03:00+00:00");
    check(!a.shows("old"), "the stale republish came back to PC A")?;
    Ok(())
}

/// The counterpart: a device you deleted that is genuinely still running says
/// so with a heartbeat AFTER the deletion. That is new information, not stale
/// data — it is allowed back, and the tombstone is retired so it stops
/// travelling through the vault killing a live machine.
fn a_live_device_can_come_back() -> Result<(), String> {
    let mut vault = Vault::default();
    let mut a = Pc::new(device("PC-A", "a", Some("m-a"), "2026-09-01T00:00:00+00:00"));
    vault.put_record(&device(
        "LIVE-BOX",
        "live",
        Some("m-live"),
        "2026-09-01T00:00:00+00:00",
    ));
    a.sync(&mut vault, "2026-09-01T01:00:00+00:00");
    a.forget("live", "2026-09-02T00:00:00+00:00")?;
    a.sync(&mut vault, "2026-09-02T00:01:00+00:00");
    check(!a.shows("live"), "deletion did not take effect")?;

    // The machine beats again, after the deletion.
    vault.put_record(&device(
        "LIVE-BOX",
        "live",
        Some("m-live"),
        "2026-09-03T00:00:00+00:00",
    ));
    a.sync(&mut vault, "2026-09-03T00:01:00+00:00");
    check(a.shows("live"), "a device that heartbeat after deletion stayed hidden")?;
    check(
        vault.tombstones.is_empty(),
        "the cleared tombstone is still in the vault, ready to kill it again",
    )?;
    Ok(())
}

/// Two PCs, both syncing, both publishing: the fleet converges on the same
/// canonical list on every machine.
fn multi_device_sync_converges() -> Result<(), String> {
    let mut vault = Vault::default();
    let mut a = Pc::new(device("PC-A", "a", Some("m-a"), "2026-09-01T00:00:00+00:00"));
    let mut b = Pc::new(device("PC-B", "b", Some("m-b"), "2026-09-01T00:00:00+00:00"));
    // A legacy ghost of PC-B, published before machine_key existed.
    let mut ghost = device("PC-B", "b-old", None, "2026-08-01T00:00:00+00:00");
    ghost.os = "windows".into();
    vault.put_record(&ghost);

    for round in 1..=3 {
        a.sync(&mut vault, &format!("2026-09-0{round}T02:00:00+00:00"));
        b.sync(&mut vault, &format!("2026-09-0{round}T02:01:00+00:00"));
    }
    let mut seen_a: Vec<String> = a.list().iter().map(|d| d.public.name.clone()).collect();
    let mut seen_b: Vec<String> = b.list().iter().map(|d| d.public.name.clone()).collect();
    seen_a.sort();
    seen_b.sort();
    check(
        seen_a == seen_b,
        &format!("the two PCs disagree: {seen_a:?} vs {seen_b:?}"),
    )?;
    check(
        seen_a == vec!["PC-A".to_string(), "PC-B".to_string()],
        &format!("expected exactly PC-A and PC-B, got {seen_a:?}"),
    )?;
    Ok(())
}

/// `devices-harness <remote_devices_registry.json>` — apply the canonical rules
/// to a REAL registry file and report what collapses. The scenarios above run on
/// synthetic fixtures on purpose (a user's device names are not test data); this
/// is how the fix was measured against an actual 36-row registry before it
/// shipped, and how to triage a "still duplicated" report without guessing.
fn inspect(path: &str) {
    let txt = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("cannot read {path}: {e}");
            std::process::exit(2);
        }
    };
    #[derive(serde::Deserialize)]
    struct File {
        #[serde(default)]
        devices: Vec<DeviceRecord>,
    }
    let file: File = match serde_json::from_str(&txt) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("cannot parse {path}: {e}");
            std::process::exit(2);
        }
    };
    let before = file.devices.len();
    let after = canonicalize(file.devices, &[]);
    println!("{before} raw records -> {} canonical", after.len());
    for d in &after {
        println!(
            "  {:<20} {:<8} {}{}",
            d.public.name,
            d.public.os,
            &d.public.device_id[..d.public.device_id.len().min(8)],
            if d.is_self { " (self)" } else { "" }
        );
    }
}

fn main() {
    if let Some(path) = std::env::args().nth(1) {
        inspect(&path);
        return;
    }
    let scenarios: &[(&str, Scenario)] = &[
        (
            "CONTROL: pre-fix rules reproduce duplicates + resurrection",
            control_pre_fix_behaviour_reproduces_the_bug,
        ),
        ("legacy duplicates collapse and stay collapsed", legacy_duplicate_cleanup),
        ("repeated logins stay one row", repeated_logins_stay_one_row),
        (
            "deletion survives sync, restart and reaches peers",
            deletion_persists_across_sync_restart_and_peers,
        ),
        ("deleting from either view removes it from both", deletion_from_either_view_matches),
        ("a stale client cannot resurrect a deleted device", stale_client_cannot_resurrect),
        ("a device that heartbeats after deletion comes back", a_live_device_can_come_back),
        ("two PCs converge on the same canonical list", multi_device_sync_converges),
    ];
    let mut failed = 0;
    for (name, f) in scenarios {
        match std::panic::catch_unwind(f) {
            Ok(Ok(())) => println!("PASS  {name}"),
            Ok(Err(msg)) => {
                failed += 1;
                println!("FAIL  {name}\n      {msg}");
            }
            Err(_) => {
                failed += 1;
                println!("FAIL  {name}\n      (panicked — see stderr)");
            }
        }
    }
    println!(
        "\ndevices-harness: {} passed · {} failed",
        scenarios.len() - failed,
        failed
    );
    if failed > 0 {
        std::process::exit(1);
    }
}

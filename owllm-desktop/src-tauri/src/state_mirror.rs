// State mirror — SQLite backup of the durable localStorage keys (Coding
// pages/sessions, notebook blobs, fine-tuning chat state). History-bearing
// UI state used to live ONLY in the WebView profile's Local Storage, so any
// profile change (the v0.8.97 isolation move, an updater relaunch onto a
// stale profile, a reinstall, a WebView data reset) made the app look wiped
// even though nothing else was lost. The 2026-07-19 forensics proved the
// class: three profile generations in two days, each swap presenting as
// "my history disappeared".
//
// The mirror lives in the same owllm_state.db `kv` table the legacy app
// created (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT) under an
// `ls:` key prefix. The UI half (runtime/stateMirror.ts) restores missing
// keys at boot BEFORE React renders and mirrors changes back on a slow
// cadence. Restore never overwrites a key that exists in localStorage —
// the live profile is always the source of truth; the mirror is disaster
// recovery only.

use crate::paths;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone)]
pub struct MirrorEntry {
    pub key: String,
    pub value: String,
    #[serde(default)]
    pub pending_recovery: bool,
}

#[derive(Deserialize)]
pub struct MirrorSaveInput {
    #[serde(default)]
    pub sets: Vec<MirrorEntry>,
    #[serde(default)]
    pub deletes: Vec<String>,
}

fn db_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_PROJECT_DB") {
        return Some(PathBuf::from(p));
    }
    paths::state_db_path()
}

const LS_PREFIX: &str = "ls:";
const RECOVERY_PREFIX: &str = "ls-pending:";
// v1 could mark itself complete after opening only the new, nearly-empty
// isolated profile while an older WebView profile still held the user's Code
// page catalog and transcripts. v2 deliberately performs one more full scan;
// recovered history wins only when it is missing or substantively larger.
const LEGACY_IMPORT_MARKER: &str = "migration:legacy-webview-leveldb-v2";

// The legacy Python app created `kv` without IF NOT EXISTS semantics we can
// rely on; recreate lazily with the exact same shape so a fresh DB works.
fn ensure_kv(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS kv (\
            key TEXT PRIMARY KEY,\
            value TEXT,\
            updated_at TEXT NOT NULL\
        )",
        [],
    )
    .map_err(|e| format!("create kv: {e}"))?;
    Ok(())
}

fn now_iso() -> String {
    // Same second-resolution ISO style as projects.rs / directives.rs; both
    // keep their formatter private, so this module carries its own copy
    // (only ordering matters for updated_at).
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    iso_from_epoch(secs)
}

fn iso_from_epoch(epoch_secs: u64) -> String {
    let days: i64 = (epoch_secs / 86400) as i64;
    let secs_today = epoch_secs % 86400;
    let (hour, minute, sec) = (secs_today / 3600, (secs_today % 3600) / 60, secs_today % 60);
    let mut year = 1970i64;
    let mut day = days;
    loop {
        let yr = if is_leap(year) { 366 } else { 365 };
        if day < yr {
            break;
        }
        day -= yr;
        year += 1;
    }
    let mdays: [i64; 12] = if is_leap(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut month = 0;
    for (i, md) in mdays.iter().enumerate() {
        if day < *md {
            month = i;
            break;
        }
        day -= *md;
    }
    format!(
        "{year:04}-{:02}-{:02}T{hour:02}:{minute:02}:{sec:02}Z",
        month + 1,
        day + 1
    )
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn load_sync(path: &std::path::Path) -> Result<Vec<MirrorEntry>, String> {
    let conn =
        rusqlite::Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    ensure_kv(&conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT k.key, k.value, EXISTS(\
                SELECT 1 FROM kv p \
                WHERE p.key = 'ls-pending:' || substr(k.key, 4)\
             ) \
             FROM kv k \
             WHERE k.key LIKE 'ls:%' AND k.key NOT LIKE 'ls-pending:%'",
        )
        .map_err(|e| format!("prepare: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(MirrorEntry {
                key: r.get::<_, String>(0)?,
                value: r.get::<_, String>(1).unwrap_or_default(),
                pending_recovery: r.get::<_, i64>(2).unwrap_or(0) != 0,
            })
        })
        .map_err(|e| format!("query: {e}"))?;
    let mut out = Vec::new();
    for row in rows.flatten() {
        out.push(MirrorEntry {
            key: row.key[LS_PREFIX.len()..].to_string(),
            value: row.value,
            pending_recovery: row.pending_recovery,
        });
    }
    Ok(out)
}

fn save_sync(path: &std::path::Path, input: MirrorSaveInput) -> Result<(), String> {
    let mut conn =
        rusqlite::Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    ensure_kv(&conn)?;
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    let now = now_iso();
    for entry in &input.sets {
        tx.execute(
            "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3",
            rusqlite::params![format!("{LS_PREFIX}{}", entry.key), entry.value, now],
        )
        .map_err(|e| format!("upsert {}: {e}", entry.key))?;
    }
    for key in &input.deletes {
        tx.execute(
            "DELETE FROM kv WHERE key = ?1",
            rusqlite::params![format!("{LS_PREFIX}{key}")],
        )
        .map_err(|e| format!("delete {key}: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit: {e}"))?;
    Ok(())
}

/// All mirrored localStorage entries (key → value, `ls:` prefix stripped).
fn acknowledge_recovery_sync(path: &std::path::Path, keys: &[String]) -> Result<(), String> {
    if keys.is_empty() {
        return Ok(());
    }
    let mut conn =
        rusqlite::Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    ensure_kv(&conn)?;
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    for key in keys {
        tx.execute(
            "DELETE FROM kv WHERE key = ?1",
            rusqlite::params![format!("{RECOVERY_PREFIX}{key}")],
        )
        .map_err(|e| format!("ack recovery {key}: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit recovery ack: {e}"))
}

fn decode_chromium_value(raw: &[u8]) -> Option<String> {
    match raw.first().copied()? {
        1 => String::from_utf8(raw[1..].to_vec()).ok(),
        0 if (raw.len() - 1) % 2 == 0 => {
            let words = raw[1..]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect::<Vec<_>>();
            String::from_utf16(&words).ok()
        }
        _ => None,
    }
}

fn chromium_local_storage_key(raw: &[u8]) -> Option<String> {
    let split = raw.windows(2).position(|w| w == [0, 1])?;
    let key = std::str::from_utf8(&raw[split + 2..]).ok()?;
    key.starts_with("owllm:").then(|| key.to_string())
}

fn history_bearing_key(key: &str) -> bool {
    key.starts_with("owllm:code:")
        || key.starts_with("owllm:agents:notebook")
        || key.starts_with("owllm:agents:brainstorm")
        || key.starts_with("owllm:agents:goal")
}

#[cfg(windows)]
fn leveldb_dirs(root: &std::path::Path) -> Vec<PathBuf> {
    fn walk(dir: &std::path::Path, depth: usize, out: &mut Vec<PathBuf>) {
        if depth > 9 {
            return;
        }
        if dir.file_name().and_then(|x| x.to_str()) == Some("leveldb")
            && dir
                .parent()
                .and_then(|x| x.file_name())
                .and_then(|x| x.to_str())
                == Some("Local Storage")
            && dir.join("CURRENT").is_file()
        {
            out.push(dir.to_path_buf());
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                walk(&entry.path(), depth + 1, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, 0, &mut out);
    out.sort_by_key(|dir| {
        std::cmp::Reverse(
            std::fs::metadata(dir)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH),
        )
    });
    out
}

#[cfg(windows)]
fn copy_leveldb(source: &std::path::Path, target: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() || entry.file_name() == "LOCK" {
            continue;
        }
        std::fs::copy(entry.path(), target.join(entry.file_name()))?;
    }
    Ok(())
}

#[cfg(windows)]
fn read_legacy_leveldb(
    source: &std::path::Path,
    scratch: &std::path::Path,
    recovered: &mut HashMap<String, String>,
) -> Result<(), String> {
    use rusty_leveldb::{LdbIterator, Options, DB};

    copy_leveldb(source, scratch).map_err(|e| format!("copy {}: {e}", source.display()))?;
    let mut options = Options::default();
    options.create_if_missing = false;
    let mut db = DB::open(scratch, options)
        .map_err(|e| format!("open copied LevelDB {}: {e}", source.display()))?;
    let mut iter = db
        .new_iter()
        .map_err(|e| format!("iterate {}: {e}", source.display()))?;
    while let Some((raw_key, raw_value)) = iter.next() {
        let Some(key) = chromium_local_storage_key(&raw_key) else {
            continue;
        };
        let Some(value) = decode_chromium_value(&raw_value) else {
            continue;
        };
        match recovered.get_mut(&key) {
            None => {
                recovered.insert(key, value);
            }
            Some(current) if history_bearing_key(&key) && value.len() > current.len() => {
                *current = value;
            }
            _ => {}
        }
    }
    Ok(())
}

/// Shipped upgrade migration: recover abandoned WebView2 localStorage origins
/// into SQLite before the browser locks those LevelDB stores.
#[cfg(windows)]
pub fn import_legacy_webview_state_once() {
    let Some(db) = db_path() else { return };
    if let Some(parent) = db.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(mut conn) = rusqlite::Connection::open(&db) else {
        return;
    };
    if ensure_kv(&conn).is_err() {
        return;
    }
    if conn
        .query_row(
            "SELECT 1 FROM kv WHERE key = ?1",
            rusqlite::params![LEGACY_IMPORT_MARKER],
            |_| Ok(()),
        )
        .is_ok()
    {
        return;
    }
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let root = PathBuf::from(local).join("com.localllm.owllm-desktop");
    let dirs = leveldb_dirs(&root);
    let scratch_root = std::env::temp_dir().join(format!(
        "owllm-legacy-state-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let mut recovered = HashMap::new();
    let mut opened = 0usize;
    for (index, source) in dirs.iter().enumerate() {
        match read_legacy_leveldb(
            source,
            &scratch_root.join(index.to_string()),
            &mut recovered,
        ) {
            Ok(()) => opened += 1,
            Err(e) => eprintln!("[state-mirror] legacy profile skipped: {e}"),
        }
    }
    let _ = std::fs::remove_dir_all(&scratch_root);
    if !dirs.is_empty() && opened == 0 {
        return;
    }

    let Ok(tx) = conn.transaction() else { return };
    let now = now_iso();
    let mut changed = 0usize;
    for (key, value) in recovered {
        let mirror_key = format!("{LS_PREFIX}{key}");
        let existing: Option<String> = tx
            .query_row(
                "SELECT value FROM kv WHERE key = ?1",
                rusqlite::params![mirror_key],
                |r| r.get(0),
            )
            .ok();
        let should_recover = existing
            .as_ref()
            .map(|old| history_bearing_key(&key) && value.len() > old.len())
            .unwrap_or(true);
        if !should_recover {
            continue;
        }
        if tx
            .execute(
                "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3",
                rusqlite::params![mirror_key, value, now],
            )
            .is_err()
        {
            return;
        }
        let _ = tx.execute(
            "INSERT INTO kv (key, value, updated_at) VALUES (?1, '1', ?2) \
             ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = ?2",
            rusqlite::params![format!("{RECOVERY_PREFIX}{key}"), now],
        );
        changed += 1;
    }
    let _ = tx.execute(
        "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![LEGACY_IMPORT_MARKER, changed.to_string(), now],
    );
    if tx.commit().is_ok() {
        eprintln!("[state-mirror] legacy upgrade imported {changed} keys from {opened} profiles");
    }
}

#[cfg(not(windows))]
pub fn import_legacy_webview_state_once() {}

#[tauri::command]
pub async fn state_mirror_load() -> Result<Vec<MirrorEntry>, String> {
    let path = db_path().ok_or("no state db path")?;
    tokio::task::spawn_blocking(move || load_sync(&path))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Upsert changed keys / drop deleted keys. One transaction per call.
#[tauri::command]
pub async fn state_mirror_save(input: MirrorSaveInput) -> Result<(), String> {
    let path = db_path().ok_or("no state db path")?;
    tokio::task::spawn_blocking(move || save_sync(&path, input))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub async fn state_mirror_ack_recovery(keys: Vec<String>) -> Result<(), String> {
    let path = db_path().ok_or("no state db path")?;
    tokio::task::spawn_blocking(move || acknowledge_recovery_sync(&path, &keys))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "owllm-mirror-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("state.db")
    }

    #[test]
    fn round_trips_sets_and_deletes() {
        let db = temp_db();
        save_sync(
            &db,
            MirrorSaveInput {
                sets: vec![
                    MirrorEntry {
                        key: "owllm:code:pages".into(),
                        value: "[1]".into(),
                        pending_recovery: false,
                    },
                    MirrorEntry {
                        key: "owllm:agents:notebook:p1".into(),
                        value: "{}".into(),
                        pending_recovery: false,
                    },
                ],
                deletes: vec![],
            },
        )
        .unwrap();
        let mut loaded = load_sync(&db).unwrap();
        loaded.sort_by(|a, b| a.key.cmp(&b.key));
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].key, "owllm:agents:notebook:p1");
        assert_eq!(loaded[1].key, "owllm:code:pages");
        assert_eq!(loaded[1].value, "[1]");

        save_sync(
            &db,
            MirrorSaveInput {
                sets: vec![MirrorEntry {
                    key: "owllm:code:pages".into(),
                    value: "[2]".into(),
                    pending_recovery: false,
                }],
                deletes: vec!["owllm:agents:notebook:p1".into()],
            },
        )
        .unwrap();
        let loaded = load_sync(&db).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].value, "[2]");
        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }

    #[test]
    fn tolerates_legacy_rows_without_prefix() {
        let db = temp_db();
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            ensure_kv(&conn).unwrap();
            conn.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES ('hf_stats:x', '{}', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }
        let loaded = load_sync(&db).unwrap();
        assert!(
            loaded.is_empty(),
            "non-ls rows must not leak into the mirror"
        );
        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }

    #[test]
    fn decodes_chromium_local_storage_records() {
        assert_eq!(
            chromium_local_storage_key(b"_http://tauri.localhost\0\x01owllm:code:pages"),
            Some("owllm:code:pages".into())
        );
        assert_eq!(decode_chromium_value(b"\x01hello"), Some("hello".into()));
        assert_eq!(
            decode_chromium_value(&[0, b'h', 0, b'i', 0]),
            Some("hi".into())
        );
    }

    #[test]
    fn pending_recovery_requires_explicit_ack() {
        let db = temp_db();
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            ensure_kv(&conn).unwrap();
            conn.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES \
                 ('ls:owllm:code:pages', '[1]', 'x'), \
                 ('ls-pending:owllm:code:pages', '1', 'x')",
                [],
            )
            .unwrap();
        }
        let loaded = load_sync(&db).unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(loaded[0].pending_recovery);
        acknowledge_recovery_sync(&db, &["owllm:code:pages".into()]).unwrap();
        assert!(!load_sync(&db).unwrap()[0].pending_recovery);
        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }
}

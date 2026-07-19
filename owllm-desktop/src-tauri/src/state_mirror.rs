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
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone)]
pub struct MirrorEntry {
    pub key: String,
    pub value: String,
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
        .prepare("SELECT key, value FROM kv WHERE key LIKE 'ls:%'")
        .map_err(|e| format!("prepare: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(MirrorEntry {
                key: r.get::<_, String>(0)?,
                value: r.get::<_, String>(1).unwrap_or_default(),
            })
        })
        .map_err(|e| format!("query: {e}"))?;
    let mut out = Vec::new();
    for row in rows.flatten() {
        out.push(MirrorEntry {
            key: row.key[LS_PREFIX.len()..].to_string(),
            value: row.value,
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
                    MirrorEntry { key: "owllm:code:pages".into(), value: "[1]".into() },
                    MirrorEntry { key: "owllm:agents:notebook:p1".into(), value: "{}".into() },
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
                sets: vec![MirrorEntry { key: "owllm:code:pages".into(), value: "[2]".into() }],
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
        assert!(loaded.is_empty(), "non-ls rows must not leak into the mirror");
        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }
}

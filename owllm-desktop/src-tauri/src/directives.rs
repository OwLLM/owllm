// Directives — project-scoped natural-language rules ("never mock data",
// "keep modules under 500 lines", "always production-ready") that get
// prepended to every agent's system prompt. The user curates the list
// manually via the SuperUserCard's Directives panel; later slices may
// add auto-extraction-from-feedback, but for v1 nothing writes here
// except explicit user gestures.
//
// Stored in the same legacy SQLite (`LLM/data/owllm_state.db`) as
// agent_projects so a project and its rules round-trip together.
// Table created lazily — opening a fresh DB before the user adds the
// first directive is a no-op.

use crate::paths;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Clone)]
pub struct Directive {
    pub id: String,
    pub project_id: String,
    /// must | prefer | avoid — drives display color + the framing the
    /// critic uses ("you MUST …" vs "you SHOULD prefer …" vs "you MUST
    /// avoid …").
    pub kind: String,
    pub text: String,
    /// "user_typed" for v1. "extracted_from_feedback" reserved for the
    /// auto-extraction slice.
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

fn db_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_PROJECT_DB") {
        return Some(PathBuf::from(p));
    }
    // Prefer the new %APPDATA%-based location; falls back to the
    // legacy LLM/data/ path via paths::state_db_path().
    paths::state_db_path()
}

fn now_iso() -> String {
    // Reuse the same lightweight formatter as projects.rs. We can't
    // import it directly (private), so re-implement the wrapper here.
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    iso_from_epoch(secs)
}

fn iso_from_epoch(epoch_secs: u64) -> String {
    let days: i64 = (epoch_secs / 86400) as i64;
    let secs_today = epoch_secs % 86400;
    let hour = secs_today / 3600;
    let minute = (secs_today % 3600) / 60;
    let sec = secs_today % 60;
    let mut year = 1970i64;
    let mut day = days;
    loop {
        let yr = if is_leap(year) { 366 } else { 365 };
        if day < yr { break; }
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
        if day < *md { month = i; break; }
        day -= *md;
    }
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month + 1, day + 1, hour, minute, sec)
}
fn is_leap(y: i64) -> bool { (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 }

fn new_id() -> String {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let rand = nanos as u64;
    format!("{:x}{:x}", ms, rand & 0xffff_ffff_ffff)
}

fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS agent_directives (\
            id TEXT PRIMARY KEY,\
            project_id TEXT NOT NULL,\
            kind TEXT NOT NULL DEFAULT 'must',\
            text TEXT NOT NULL,\
            source TEXT NOT NULL DEFAULT 'user_typed',\
            created_at TEXT NOT NULL,\
            updated_at TEXT NOT NULL\
        )",
        [],
    ).map_err(|e| format!("create agent_directives: {e}"))?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_directives_project ON agent_directives(project_id)",
        [],
    ).map_err(|e| format!("create idx_directives_project: {e}"))?;
    // Add director_mode column to agent_projects so the toggle on the
    // SuperUserCard persists. Idempotent ALTER (swallow duplicate-column
    // error) — same pattern as projects.rs:97-104 for chat_json.
    let _ = conn.execute(
        "ALTER TABLE agent_projects ADD COLUMN director_mode INTEGER NOT NULL DEFAULT 0",
        [],
    );
    // One-time "have we seeded this project's native best-practice rules?" flag.
    // Lives on agent_projects so that deleting every rule never RE-seeds — the
    // user's deletions stick. (Same idempotent-ALTER pattern.)
    let _ = conn.execute(
        "ALTER TABLE agent_projects ADD COLUMN directives_seeded INTEGER NOT NULL DEFAULT 0",
        [],
    );
    Ok(())
}

/// Native best-practice rules every project starts with, so nobody writes a rule
/// list from zero. They are NORMAL directives (the user can edit or delete any of
/// them) — only the `source` is 'builtin' so the UI can mark them. They flow into
/// every agent AND the Critic exactly like user-typed rules (buildCriticPrompt /
/// buildSpecialistPrompt both inject the project directives). Worded as general,
/// production-quality engineering guidance — distilled from the user's own
/// standing principles (verify, reuse, root-cause, no fabrication, build for all).
pub(crate) const DEFAULT_DIRECTIVES: &[(&str, &str)] = &[
    ("must", "Verify every change actually works — run it, test it, or probe it — before calling it done."),
    ("must", "Make the smallest change that fully solves the task; don't rewrite working code you weren't asked to touch."),
    ("must", "Match the existing code's style, naming, structure, and patterns."),
    ("must", "Find the root cause before reaching for a workaround."),
    ("must", "Ask before anything destructive or irreversible (deleting files or data, force-pushing, overwriting)."),
    ("must", "Design for every target user and environment, not just the current machine."),
    ("prefer", "Reuse existing functions, components, and tools instead of writing parallel new ones."),
    ("prefer", "Clear, descriptive names and straightforward code over cleverness."),
    ("prefer", "Handle errors explicitly and surface them — never fail silently."),
    ("prefer", "Check the shared team memory before re-deriving or re-asking something already known."),
    ("avoid", "Fabricating data, file paths, results, or citations — never invent what you didn't verify."),
    ("avoid", "Hardcoding machine-specific paths, credentials, or environment assumptions."),
    ("avoid", "Mixing unrelated refactors into a single focused change."),
    ("avoid", "Leaving debug prints, dead code, or vague TODOs behind."),
];

/// Insert the built-in rules for a project. When `skip_existing_by_text` is set,
/// a default already present (matched by text) is skipped — used by the explicit
/// "restore best-practices" action so it never duplicates surviving rules.
/// Returns how many rows were inserted.
fn insert_defaults(
    conn: &rusqlite::Connection,
    project_id: &str,
    skip_existing_by_text: bool,
) -> Result<usize, String> {
    let now = now_iso();
    let mut added = 0usize;
    for (kind, text) in DEFAULT_DIRECTIVES {
        if skip_existing_by_text {
            let dup: i64 = conn
                .query_row(
                    "SELECT count(*) FROM agent_directives WHERE project_id = ?1 AND text = ?2",
                    rusqlite::params![project_id, text],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if dup > 0 {
                continue;
            }
        }
        conn.execute(
            "INSERT INTO agent_directives (id, project_id, kind, text, source, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, 'builtin', ?5, ?5)",
            rusqlite::params![new_id(), project_id, kind, text, now],
        )
        .map_err(|e| format!("seed insert: {e}"))?;
        added += 1;
    }
    Ok(added)
}

/// Seed the native rules ONCE per project (gated by the directives_seeded flag),
/// so a brand-new project — or an existing one opened for the first time after
/// this ships — starts with the best-practice set instead of an empty list.
fn seed_defaults_if_needed(conn: &rusqlite::Connection, project_id: &str) -> Result<(), String> {
    let seeded: i64 = conn
        .query_row(
            "SELECT COALESCE(directives_seeded, 0) FROM agent_projects WHERE id = ?1",
            rusqlite::params![project_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if seeded != 0 {
        return Ok(());
    }
    insert_defaults(conn, project_id, false)?;
    // Mark seeded even if the project row is absent yet (no-op then) — the next
    // call re-checks. We swallow the error so listing never fails on the flag.
    let _ = conn.execute(
        "UPDATE agent_projects SET directives_seeded = 1 WHERE id = ?1",
        rusqlite::params![project_id],
    );
    Ok(())
}

fn open_conn() -> Result<rusqlite::Connection, String> {
    let path = db_path().ok_or_else(|| "LLM/ tree not found".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let conn = rusqlite::Connection::open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    ensure_schema(&conn)?;
    Ok(conn)
}

#[tauri::command]
pub async fn directives_list(project_id: String) -> Result<Vec<Directive>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_conn()?;
        // Auto-seed native best-practice rules the first time a project is listed,
        // so the rules panel is never empty and the user never starts from zero.
        seed_defaults_if_needed(&conn, &project_id)?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, kind, text, source, created_at, updated_at \
             FROM agent_directives WHERE project_id = ?1 \
             ORDER BY kind, created_at"
        ).map_err(|e| format!("prepare: {e}"))?;
        let rows = stmt.query_map([&project_id], |r| {
            Ok(Directive {
                id: r.get(0)?, project_id: r.get(1)?, kind: r.get(2)?,
                text: r.get(3)?, source: r.get(4)?,
                created_at: r.get(5)?, updated_at: r.get(6)?,
            })
        }).map_err(|e| format!("query: {e}"))?;
        let out: Result<Vec<_>, _> = rows.collect();
        out.map_err(|e| format!("row decode: {e}"))
    }).await.map_err(|e| format!("join error: {e}"))?
}

// JS sends `projectId` (camelCase) per Tauri's argument convention;
// serde defaults to literal field names so without rename_all the
// project_id field deserializes empty, the INSERT runs against
// project_id="", and `directives_list` (which filters by the real
// project's id) never sees the row — the rule "disappeared" silently.
// Bug repro 2026-05-20: SuperUserCard / DirectivesPanel adds did
// nothing user-visible until this was added.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddDirectiveInput {
    pub project_id: String,
    pub kind: String,
    pub text: String,
}

#[tauri::command]
pub async fn directives_add(input: AddDirectiveInput) -> Result<Directive, String> {
    tokio::task::spawn_blocking(move || {
        let kind = normalize_kind(&input.kind);
        let text = input.text.trim().to_string();
        if text.is_empty() {
            return Err("directive text cannot be empty".to_string());
        }
        let conn = open_conn()?;
        let id = new_id();
        let now = now_iso();
        conn.execute(
            "INSERT INTO agent_directives (id, project_id, kind, text, source, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, 'user_typed', ?5, ?5)",
            rusqlite::params![id, input.project_id, kind, text, now],
        ).map_err(|e| format!("insert: {e}"))?;
        Ok(Directive {
            id, project_id: input.project_id, kind, text,
            source: "user_typed".into(),
            created_at: now.clone(), updated_at: now,
        })
    }).await.map_err(|e| format!("join error: {e}"))?
}

#[derive(Deserialize)]
pub struct UpdateDirectiveInput {
    pub id: String,
    pub kind: Option<String>,
    pub text: Option<String>,
}

#[tauri::command]
pub async fn directives_update(input: UpdateDirectiveInput) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_conn()?;
        let mut sets: Vec<&'static str> = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(k) = input.kind {
            sets.push("kind = ?");
            params.push(Box::new(normalize_kind(&k)));
        }
        if let Some(t) = input.text {
            let t = t.trim().to_string();
            if t.is_empty() {
                return Err("directive text cannot be empty".to_string());
            }
            sets.push("text = ?");
            params.push(Box::new(t));
        }
        if sets.is_empty() { return Ok(()); }
        sets.push("updated_at = ?");
        params.push(Box::new(now_iso()));
        params.push(Box::new(input.id));
        let sql = format!("UPDATE agent_directives SET {} WHERE id = ?", sets.join(", "));
        let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
        conn.execute(&sql, refs.as_slice()).map_err(|e| format!("update: {e}"))?;
        Ok(())
    }).await.map_err(|e| format!("join error: {e}"))?
}

/// Re-add any built-in best-practice rules the user has deleted (matched by
/// text), without duplicating ones still present. Backs the "Restore
/// best-practices" button. Returns how many were restored.
#[tauri::command]
pub async fn directives_restore_defaults(project_id: String) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_conn()?;
        let added = insert_defaults(&conn, &project_id, true)?;
        let _ = conn.execute(
            "UPDATE agent_projects SET directives_seeded = 1 WHERE id = ?1",
            rusqlite::params![project_id],
        );
        Ok(added)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub async fn directives_delete(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_conn()?;
        conn.execute("DELETE FROM agent_directives WHERE id = ?1", rusqlite::params![id])
            .map_err(|e| format!("delete: {e}"))?;
        Ok(())
    }).await.map_err(|e| format!("join error: {e}"))?
}

/// Set the per-project director_mode flag (the SuperUserCard toggle).
/// Lives here instead of projects.rs because it's part of the same
/// feature surface as directives — both serve the critic / director
/// loop and ship in the same slice.
#[tauri::command]
pub async fn project_set_director_mode(project_id: String, enabled: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_conn()?;
        conn.execute(
            "UPDATE agent_projects SET director_mode = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![enabled as i64, now_iso(), project_id],
        ).map_err(|e| format!("update director_mode: {e}"))?;
        Ok(())
    }).await.map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub async fn project_get_director_mode(project_id: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_conn()?;
        let v: i64 = conn.query_row(
            "SELECT director_mode FROM agent_projects WHERE id = ?1",
            rusqlite::params![project_id],
            |r| r.get(0),
        ).unwrap_or(0);
        Ok(v != 0)
    }).await.map_err(|e| format!("join error: {e}"))?
}

fn normalize_kind(k: &str) -> String {
    match k.trim().to_ascii_lowercase().as_str() {
        "must" | "prefer" | "avoid" => k.trim().to_ascii_lowercase(),
        _ => "must".to_string(),
    }
}

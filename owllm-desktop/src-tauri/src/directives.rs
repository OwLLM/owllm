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
    // Add critic_super_user: when ON, the Critical Thinker is appointed Super
    // User and decides in the user's place (answers/approves/gates the run).
    // OFF (default) it stays advisory and can NEVER block the team — the
    // Red-Team safety guarantee. Idempotent ALTER (swallow duplicate-column).
    let _ = conn.execute(
        "ALTER TABLE agent_projects ADD COLUMN critic_super_user INTEGER NOT NULL DEFAULT 0",
        [],
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

/// Set the per-project critic_super_user flag. ON = the Critical Thinker is
/// appointed Super User and decides in the user's place (answers the
/// orchestrator's questions, approves/rejects the plan + final, gets more
/// rounds to gate). OFF (default) = advisory only; bounded review loops that
/// can NEVER block the team — so a non-abliterated critic cannot stall a
/// sanctioned Red-Team / abliterate run.
#[tauri::command]
pub async fn project_set_critic_super(project_id: String, enabled: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_conn()?;
        conn.execute(
            "UPDATE agent_projects SET critic_super_user = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![enabled as i64, now_iso(), project_id],
        ).map_err(|e| format!("update critic_super_user: {e}"))?;
        Ok(())
    }).await.map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub async fn project_get_critic_super(project_id: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_conn()?;
        let v: i64 = conn.query_row(
            "SELECT critic_super_user FROM agent_projects WHERE id = ?1",
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

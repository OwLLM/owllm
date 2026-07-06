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

pub(crate) fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
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
    // Last time the user CHANGED this project's rule set (add/edit/delete/restore).
    // Drives cross-PC sync: the rule set is synced as a unit, last-writer-wins by
    // this stamp. Empty '' = seed-only / never user-touched, so a freshly-seeded
    // machine never overwrites a curated one (any real edit's ISO stamp beats '').
    let _ = conn.execute(
        "ALTER TABLE agent_projects ADD COLUMN directives_updated_at TEXT NOT NULL DEFAULT ''",
        [],
    );
    // Seed-version marks that work for ANY scope id. The agent_projects stamp
    // only sticks for real agent projects — Code-page scopes ("code:<path>")
    // have no agent_projects row, so their UPDATE hit 0 rows and every
    // directives_list RE-SEEDED the full default set (observed: 11x duplicate
    // rules injected into every prompt). This table is the stamp that always
    // sticks; agent_projects.directives_seeded is kept for back-compat/sync.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS directives_seed_marks (\
            project_id TEXT PRIMARY KEY,\
            version INTEGER NOT NULL\
        )",
        [],
    ).map_err(|e| format!("create directives_seed_marks: {e}"))?;
    Ok(())
}

/// Stamp "the user just changed this project's rules" so the cross-PC sync knows
/// this machine holds the newer set. Called by add/update/delete/restore — NOT by
/// seeding (seed leaves the stamp '' so defaults never beat a curated remote).
fn touch_directives(conn: &rusqlite::Connection, project_id: &str) {
    let _ = conn.execute(
        "UPDATE agent_projects SET directives_updated_at = ?2 WHERE id = ?1",
        rusqlite::params![project_id, now_iso()],
    );
}

/// Bump when DEFAULT_DIRECTIVES changes so already-seeded projects upgrade to the
/// new native set. `directives_seeded` doubles as the seed VERSION (0 = never).
/// On upgrade we replace only untouched builtins — a rule the user edited is
/// promoted to source='user_typed' (see directives_update) and is kept.
pub(crate) const CURRENT_SEED_VERSION: i64 = 2;

/// Native best-practice rules every project starts with, so nobody writes a rule
/// list from zero. They are NORMAL directives (the user can edit or delete any of
/// them) — `source` is 'builtin' until the user edits one (then 'user_typed').
/// They flow into every agent AND the Critic exactly like user-typed rules. This
/// is the canonical "Agent Team Rules" Must/Prefer/Avoid set (the Operating
/// Priority, Definition of Done, and Handoff Format live in the prompt-level
/// TEAM_OPERATING_CONTRACT, since they are structure, not tunable rules).
pub(crate) const DEFAULT_DIRECTIVES: &[(&str, &str)] = &[
    ("must", "Verify every change before calling it done. Run, test, inspect, or otherwise validate the result. If verification is not possible, state exactly what could not be verified and why."),
    ("must", "Never fabricate anything: data, paths, outputs, logs, test results, metrics, citations, screenshots, or completion status. Clearly label assumptions and estimates."),
    ("must", "Fix the root cause. Use workarounds only when necessary, clearly mark them as temporary, and explain the remaining risk."),
    ("must", "Make the smallest change that fully resolves the problem at its root."),
    ("must", "Match the existing style, naming, structure, architecture, and conventions."),
    ("must", "Stop and ask when blocked, when ambiguity would materially affect the solution (implementation, safety, data, API, or user-facing behavior), or before any destructive or irreversible action (deleting files, user data, production data, database records, force-pushes, history rewrites, overwriting user content, credential changes, schema migrations, API contract changes, or production-impacting actions)."),
    ("must", "Design for the intended users, deployment environments, and edge cases, not only the current machine or dataset."),
    ("prefer", "Reuse existing functions, components, tools, and patterns before introducing new ones."),
    ("prefer", "Choose clear names and straightforward implementations over clever or complex solutions."),
    ("prefer", "Surface errors with actionable diagnostics. Never fail silently."),
    ("prefer", "Check shared memory, project documentation, previous decisions, and open issues before re-asking questions or re-deriving conclusions."),
    ("prefer", "Coordinate with other agents: own one task at a time, communicate state clearly, and avoid overwriting another agent's work."),
    ("prefer", "Improve nearby code only when directly related to the task or necessary to safely implement the change."),
    ("avoid", "Expanding scope beyond the requested task."),
    ("avoid", "Mixing unrelated refactors into focused bug fixes or features."),
    ("avoid", "Hardcoding paths, secrets, credentials, ports, hostnames, or environment-specific assumptions."),
    ("avoid", "Leaving debug prints, dead code, commented-out experiments, temporary hacks, or vague TODOs."),
    ("avoid", "Changing public behavior, APIs, schemas, file formats, or user workflows unless required and explicitly disclosed."),
    ("avoid", "Adding dependencies, services, frameworks, or infrastructure without clear justification."),
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

/// Seed (or version-upgrade) the native rules for a project. `directives_seeded`
/// holds the seed VERSION: 0 = never seeded, N = seeded with version N.
///   - Never seeded → insert the current set.
///   - Seeded at an older version → REPLACE only the untouched builtins (delete
///     source='builtin' rows, re-insert the new set) and keep every 'user_typed'
///     rule — including builtins the user edited, which directives_update promotes
///     to 'user_typed'. So upgrades refresh the defaults without losing user work.
/// Idempotent once at CURRENT_SEED_VERSION.
fn seed_defaults_if_needed(conn: &rusqlite::Connection, project_id: &str) -> Result<(), String> {
    // Effective seed version = max of the two stamps. agent_projects only has a
    // row for real agent projects; Code-page scopes ("code:<path>") rely on the
    // marks table (see ensure_schema for the duplicate-seeding bug this fixes).
    let seeded_proj: i64 = conn
        .query_row(
            "SELECT COALESCE(directives_seeded, 0) FROM agent_projects WHERE id = ?1",
            rusqlite::params![project_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let seeded_mark: i64 = conn
        .query_row(
            "SELECT version FROM directives_seed_marks WHERE project_id = ?1",
            rusqlite::params![project_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let seeded = seeded_proj.max(seeded_mark);
    if seeded >= CURRENT_SEED_VERSION {
        return Ok(());
    }
    // Heal duplicates from the broken-stamp era: keep the oldest copy of each
    // built-in per (kind, text), drop the rest. User-typed rows are untouched.
    let _ = conn.execute(
        "DELETE FROM agent_directives WHERE project_id = ?1 AND source = 'builtin' \
         AND rowid NOT IN (SELECT MIN(rowid) FROM agent_directives \
                           WHERE project_id = ?1 AND source = 'builtin' \
                           GROUP BY kind, text)",
        rusqlite::params![project_id],
    );
    if seeded > 0 {
        // Upgrade: drop the previous version's untouched built-ins before re-seeding.
        let _ = conn.execute(
            "DELETE FROM agent_directives WHERE project_id = ?1 AND source = 'builtin'",
            rusqlite::params![project_id],
        );
    }
    // skip_existing_by_text: seeding is idempotent by construction — a surviving
    // (healed) rule set is never duplicated even if the stamp write failed.
    insert_defaults(conn, project_id, true)?;
    // Stamp the current seed version in BOTH places: the marks row always
    // sticks (any scope id); the agent_projects column is kept for sync/back-compat.
    let _ = conn.execute(
        "INSERT OR REPLACE INTO directives_seed_marks (project_id, version) VALUES (?1, ?2)",
        rusqlite::params![project_id, CURRENT_SEED_VERSION],
    );
    let _ = conn.execute(
        "UPDATE agent_projects SET directives_seeded = ?2 WHERE id = ?1",
        rusqlite::params![project_id, CURRENT_SEED_VERSION],
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
        touch_directives(&conn, &input.project_id);
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
        // Editing a rule makes it the user's own — promote it to 'user_typed' so a
        // future native-set version bump won't delete it as an untouched builtin.
        sets.push("source = 'user_typed'");
        params.push(Box::new(input.id.clone()));
        let sql = format!("UPDATE agent_directives SET {} WHERE id = ?", sets.join(", "));
        let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
        conn.execute(&sql, refs.as_slice()).map_err(|e| format!("update: {e}"))?;
        // Stamp the owning project so the edit syncs as the newer rule set.
        if let Ok(pid) = conn.query_row(
            "SELECT project_id FROM agent_directives WHERE id = ?1",
            rusqlite::params![input.id],
            |r| r.get::<_, String>(0),
        ) {
            touch_directives(&conn, &pid);
        }
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
            "INSERT OR REPLACE INTO directives_seed_marks (project_id, version) VALUES (?1, ?2)",
            rusqlite::params![project_id, CURRENT_SEED_VERSION],
        );
        let _ = conn.execute(
            "UPDATE agent_projects SET directives_seeded = ?2 WHERE id = ?1",
            rusqlite::params![project_id, CURRENT_SEED_VERSION],
        );
        // Restoring is a deliberate user action — stamp it so it syncs.
        touch_directives(&conn, &project_id);
        Ok(added)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub async fn directives_delete(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_conn()?;
        // Look up the owning project BEFORE deleting so we can stamp it (a delete
        // must sync, or the rule resurrects from another PC).
        let pid: Option<String> = conn
            .query_row(
                "SELECT project_id FROM agent_directives WHERE id = ?1",
                rusqlite::params![id],
                |r| r.get::<_, String>(0),
            )
            .ok();
        conn.execute("DELETE FROM agent_directives WHERE id = ?1", rusqlite::params![id])
            .map_err(|e| format!("delete: {e}"))?;
        if let Some(pid) = pid {
            touch_directives(&conn, &pid);
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        ensure_schema(&conn).expect("schema");
        conn
    }

    fn count_rules(conn: &rusqlite::Connection, pid: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM agent_directives WHERE project_id = ?1",
            rusqlite::params![pid],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The Code-page scope bug: "code:<path>" ids have no agent_projects row,
    /// so the old stamp never stuck and EVERY directives_list re-seeded the
    /// full default set (observed 11x duplicates → 11x rules in every prompt).
    /// Seeding must now be idempotent for such scopes.
    #[test]
    fn seeding_code_scope_twice_does_not_duplicate() {
        let conn = mem_conn();
        let pid = r"code:c:\some\folder";
        seed_defaults_if_needed(&conn, pid).unwrap();
        assert_eq!(count_rules(&conn, pid), DEFAULT_DIRECTIVES.len() as i64);
        // Second, third call — the marks-table stamp must hold.
        seed_defaults_if_needed(&conn, pid).unwrap();
        seed_defaults_if_needed(&conn, pid).unwrap();
        assert_eq!(count_rules(&conn, pid), DEFAULT_DIRECTIVES.len() as i64);
    }

    /// A DB already poisoned by the broken-stamp era (N copies of every
    /// builtin) must heal down to one copy on the next seed pass.
    #[test]
    fn seeding_heals_duplicates_from_broken_stamp_era() {
        let conn = mem_conn();
        let pid = r"code:c:\1_git\locallm";
        // Simulate the old behaviour: three raw re-seeds with no dedup.
        insert_defaults(&conn, pid, false).unwrap();
        insert_defaults(&conn, pid, false).unwrap();
        insert_defaults(&conn, pid, false).unwrap();
        assert_eq!(count_rules(&conn, pid), 3 * DEFAULT_DIRECTIVES.len() as i64);
        seed_defaults_if_needed(&conn, pid).unwrap();
        assert_eq!(count_rules(&conn, pid), DEFAULT_DIRECTIVES.len() as i64);
        // And it stays healed.
        seed_defaults_if_needed(&conn, pid).unwrap();
        assert_eq!(count_rules(&conn, pid), DEFAULT_DIRECTIVES.len() as i64);
    }

    /// User deletions must survive: once seeded, deleting a builtin and
    /// re-listing must NOT bring it back (the stamp keeps re-seed away).
    #[test]
    fn deleted_builtin_stays_deleted_after_reseed_check() {
        let conn = mem_conn();
        let pid = r"code:c:\proj";
        seed_defaults_if_needed(&conn, pid).unwrap();
        conn.execute(
            "DELETE FROM agent_directives WHERE project_id = ?1 AND kind = 'avoid'",
            rusqlite::params![pid],
        )
        .unwrap();
        let after_delete = count_rules(&conn, pid);
        seed_defaults_if_needed(&conn, pid).unwrap();
        assert_eq!(count_rules(&conn, pid), after_delete);
    }
}

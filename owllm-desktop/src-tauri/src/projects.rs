// Project CRUD against the legacy SQLite at `LLM/data/owllm_state.db`.
// We share the same database the PySide6 app's ProjectStore uses so a
// project created here shows up in the legacy app and vice versa.
//
// Schema (mirrors LLM/core/agents/projects.py:140-200):
//   CREATE TABLE agent_projects (
//     id TEXT PRIMARY KEY,
//     name TEXT NOT NULL,
//     description TEXT NOT NULL DEFAULT '',
//     location TEXT NOT NULL DEFAULT '',
//     trust_writes INTEGER NOT NULL DEFAULT 0,
//     workdir_hint_sent_for TEXT NOT NULL DEFAULT '',
//     auto_approve_all INTEGER NOT NULL DEFAULT 0,
//     team_json TEXT NOT NULL DEFAULT '[]',
//     model_overrides_json TEXT NOT NULL DEFAULT '{}',
//     graph_json TEXT NOT NULL DEFAULT '',
//     created_at TEXT NOT NULL,
//     updated_at TEXT NOT NULL,
//     team_default_model_id TEXT NOT NULL DEFAULT ''
//   )

use crate::paths;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Default, Serialize, Clone)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub location: String,
    pub trust_writes: bool,
    pub auto_approve_all: bool,
    pub team: Vec<String>,
    pub team_default_model_id: String,
    /// Routing graph as JSON — `{"edges": [{"source": "...", "target": "..."}, ...]}`.
    /// Empty string = use the team template's default routing.
    pub graph_json: String,
    /// Super User chat transcript as JSON — array of GoalMsg objects
    /// (`[{"role":"you","color":"#...","text":"..."}, ...]`). Empty
    /// string = no saved chat (fresh project).
    pub chat_json: String,
    /// Per-agent transcripts as JSON — object keyed by agent name
    /// (`{"orchestrator":[GoalMsg,...], "coder":[GoalMsg,...]}`). Empty
    /// string = no saved logs.
    pub agent_logs_json: String,
    pub updated_at: String,
}

#[tauri::command]
pub async fn list_projects() -> Result<Vec<ProjectRow>, String> {
    let Some(path) = project_db_path() else { return Ok(Vec::new()) };
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let path2 = path.clone();
    tokio::task::spawn_blocking(move || read_projects(&path2))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn project_db_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_PROJECT_DB") {
        return Some(PathBuf::from(p));
    }
    // %APPDATA%\OwLLM Desktop\owllm_state.db, with the legacy
    // LLM/data/owllm_state.db as the fallback during the migration
    // window. Lives in paths::state_db_path().
    paths::state_db_path()
}

fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    // Idempotent CREATE TABLE so opening a fresh database doesn't fail
    // when the user creates their first project before the legacy
    // Python app has touched the file.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS agent_projects (\
            id TEXT PRIMARY KEY,\
            name TEXT NOT NULL,\
            description TEXT NOT NULL DEFAULT '',\
            location TEXT NOT NULL DEFAULT '',\
            trust_writes INTEGER NOT NULL DEFAULT 0,\
            workdir_hint_sent_for TEXT NOT NULL DEFAULT '',\
            auto_approve_all INTEGER NOT NULL DEFAULT 0,\
            team_json TEXT NOT NULL DEFAULT '[]',\
            model_overrides_json TEXT NOT NULL DEFAULT '{}',\
            graph_json TEXT NOT NULL DEFAULT '',\
            created_at TEXT NOT NULL,\
            updated_at TEXT NOT NULL,\
            team_default_model_id TEXT NOT NULL DEFAULT ''\
        )",
        [],
    )
    .map_err(|e| format!("create table: {e}"))?;
    // Migrate older databases that pre-date the chat / per-agent log
    // columns. ALTER TABLE … ADD COLUMN on SQLite has no `IF NOT
    // EXISTS`, so we just attempt it and swallow the "duplicate column
    // name" error path. Both fields hold JSON strings; '' = absent.
    let _ = conn.execute(
        "ALTER TABLE agent_projects ADD COLUMN chat_json TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE agent_projects ADD COLUMN agent_logs_json TEXT NOT NULL DEFAULT ''",
        [],
    );
    Ok(())
}

fn read_projects(path: &std::path::Path) -> Result<Vec<ProjectRow>, String> {
    // Open read-write so we can run the idempotent migration that
    // adds chat_json / agent_logs_json to pre-existing databases.
    // Without that, this read would fail on older DBs the moment we
    // SELECT the new columns.
    let conn = rusqlite::Connection::open(path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;

    let exists: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='agent_projects'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("schema probe: {e}"))?;
    if exists == 0 {
        return Ok(Vec::new());
    }
    ensure_schema(&conn)?;

    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, location, trust_writes, \
             auto_approve_all, team_json, team_default_model_id, graph_json, \
             chat_json, agent_logs_json, updated_at \
             FROM agent_projects ORDER BY updated_at DESC",
        )
        .map_err(|e| format!("prepare: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            let team_json: String = r.get(6)?;
            let team: Vec<String> = serde_json::from_str(&team_json).unwrap_or_default();
            Ok(ProjectRow {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get::<_, String>(2).unwrap_or_default(),
                location: r.get::<_, String>(3).unwrap_or_default(),
                trust_writes: r.get::<_, i64>(4).unwrap_or(0) != 0,
                auto_approve_all: r.get::<_, i64>(5).unwrap_or(0) != 0,
                team,
                team_default_model_id: r.get::<_, String>(7).unwrap_or_default(),
                graph_json: r.get::<_, String>(8).unwrap_or_default(),
                chat_json: r.get::<_, String>(9).unwrap_or_default(),
                agent_logs_json: r.get::<_, String>(10).unwrap_or_default(),
                updated_at: r.get::<_, String>(11).unwrap_or_default(),
            })
        })
        .map_err(|e| format!("query: {e}"))?;
    let out: Result<Vec<_>, _> = rows.collect();
    out.map_err(|e| format!("row decode: {e}"))
}

// ---------- Write API ----------

#[derive(Deserialize)]
pub struct CreateProjectInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub location: String,
    /// List of agent names (matches `agent_projects.team_json`).
    #[serde(default)]
    pub team: Vec<String>,
    /// Routing graph JSON. Empty = default star topology from
    /// orchestrator on dispatch.
    #[serde(default)]
    pub graph_json: String,
    #[serde(default)]
    pub team_default_model_id: String,
    #[serde(default)]
    pub trust_writes: bool,
    #[serde(default)]
    pub auto_approve_all: bool,
}

fn now_iso() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // RFC3339-ish using a single chrono-free Z timestamp. The Python
    // side stores ISO-8601 strings; both formats sort correctly so
    // this is round-trip safe.
    let dt = httpdate_like(secs);
    dt
}

fn httpdate_like(epoch_secs: u64) -> String {
    // Very lightweight ISO-8601 formatter. We don't depend on chrono
    // for one timestamp; the simple algorithm is good enough for an
    // updated_at column where only ordering matters.
    use std::convert::TryInto;
    let days_since_epoch: i64 = (epoch_secs / 86400).try_into().unwrap_or(0);
    let secs_today = epoch_secs % 86400;
    let hour = secs_today / 3600;
    let minute = (secs_today % 3600) / 60;
    let sec = secs_today % 60;
    // Days to date (proleptic Gregorian; works from 1970-01-01).
    let mut year = 1970i64;
    let mut day = days_since_epoch;
    loop {
        let yr_days = if is_leap(year) { 366 } else { 365 };
        if day < yr_days {
            break;
        }
        day -= yr_days;
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
    let dom = day + 1;
    let mo = month + 1;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, mo, dom, hour, minute, sec
    )
}
fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn new_id() -> String {
    // ULID-ish: 13-hex epoch ms + 16-hex random. No external crate.
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let mut rand_bytes = [0u8; 8];
    getrand_unsafe(&mut rand_bytes);
    let rand_hex = rand_bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>();
    format!("{:x}_{}", ms, rand_hex)
}

// Pull 8 random bytes from the platform RNG without a crate dep.
// rand_chacha would be cleaner but adds dep mass.
fn getrand_unsafe(buf: &mut [u8]) {
    use std::time::Instant;
    let mut seed = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    // Mix in a couple of clock samples — gives us enough entropy for
    // a per-record id collision-resistant against the few-projects-
    // per-second worst case.
    seed ^= Instant::now().elapsed().as_nanos();
    for b in buf.iter_mut() {
        seed = seed.wrapping_mul(6364136223846793005u128).wrapping_add(1442695040888963407u128);
        *b = (seed >> 96) as u8;
    }
}

#[tauri::command]
pub async fn create_project(input: CreateProjectInput) -> Result<ProjectRow, String> {
    let Some(path) = project_db_path() else { return Err("LLM/ tree not found".into()) };
    let path2 = path.clone();
    tokio::task::spawn_blocking(move || {
        if let Some(parent) = path2.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let conn = rusqlite::Connection::open(&path2)
            .map_err(|e| format!("open {}: {e}", path2.display()))?;
        ensure_schema(&conn)?;

        let id = new_id();
        let now = now_iso();
        let team_json = serde_json::to_string(&input.team).unwrap_or("[]".into());

        conn.execute(
            "INSERT INTO agent_projects (id, name, description, location, trust_writes, auto_approve_all, \
             team_json, model_overrides_json, graph_json, created_at, updated_at, team_default_model_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '{}', ?8, ?9, ?9, ?10)",
            rusqlite::params![
                id,
                input.name,
                input.description,
                input.location,
                input.trust_writes as i64,
                input.auto_approve_all as i64,
                team_json,
                input.graph_json,
                now,
                input.team_default_model_id,
            ],
        )
        .map_err(|e| format!("insert: {e}"))?;

        Ok(ProjectRow {
            id,
            name: input.name,
            description: input.description,
            location: input.location,
            trust_writes: input.trust_writes,
            auto_approve_all: input.auto_approve_all,
            team: input.team,
            team_default_model_id: input.team_default_model_id,
            graph_json: input.graph_json,
            chat_json: String::new(),
            agent_logs_json: String::new(),
            updated_at: now,
        })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[derive(Deserialize)]
pub struct UpdateProjectInput {
    pub id: String,
    /// All fields optional — only Some(_) values get written. None =
    /// leave the column alone.
    pub name: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    pub trust_writes: Option<bool>,
    pub auto_approve_all: Option<bool>,
    pub team: Option<Vec<String>>,
    pub graph_json: Option<String>,
    pub team_default_model_id: Option<String>,
    /// JSON-encoded array of Super User chat messages.
    pub chat_json: Option<String>,
    /// JSON-encoded object mapping agent name → array of messages.
    pub agent_logs_json: Option<String>,
}

#[tauri::command]
pub async fn update_project(input: UpdateProjectInput) -> Result<(), String> {
    let Some(path) = project_db_path() else { return Err("LLM/ tree not found".into()) };
    let path2 = path.clone();
    tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&path2)
            .map_err(|e| format!("open {}: {e}", path2.display()))?;
        ensure_schema(&conn)?;

        let now = now_iso();
        // Build dynamic UPDATE so we only touch the columns the caller
        // actually wants to change. Each field appends a `, col = ?`
        // and pushes a boxed param.
        let mut sets: Vec<&'static str> = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(v) = input.name {
            sets.push("name = ?");
            params.push(Box::new(v));
        }
        if let Some(v) = input.description {
            sets.push("description = ?");
            params.push(Box::new(v));
        }
        if let Some(v) = input.location {
            sets.push("location = ?");
            params.push(Box::new(v));
        }
        if let Some(v) = input.trust_writes {
            sets.push("trust_writes = ?");
            params.push(Box::new(v as i64));
        }
        if let Some(v) = input.auto_approve_all {
            sets.push("auto_approve_all = ?");
            params.push(Box::new(v as i64));
        }
        if let Some(v) = input.team {
            sets.push("team_json = ?");
            params.push(Box::new(serde_json::to_string(&v).unwrap_or("[]".into())));
        }
        if let Some(v) = input.graph_json {
            sets.push("graph_json = ?");
            params.push(Box::new(v));
        }
        if let Some(v) = input.team_default_model_id {
            sets.push("team_default_model_id = ?");
            params.push(Box::new(v));
        }
        if let Some(v) = input.chat_json {
            sets.push("chat_json = ?");
            params.push(Box::new(v));
        }
        if let Some(v) = input.agent_logs_json {
            sets.push("agent_logs_json = ?");
            params.push(Box::new(v));
        }
        if sets.is_empty() {
            return Ok(()); // nothing to do
        }
        sets.push("updated_at = ?");
        params.push(Box::new(now));
        params.push(Box::new(input.id));

        let sql = format!(
            "UPDATE agent_projects SET {} WHERE id = ?",
            sets.join(", ")
        );
        let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
        conn.execute(&sql, refs.as_slice())
            .map_err(|e| format!("update: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub async fn delete_project(id: String) -> Result<(), String> {
    let Some(path) = project_db_path() else { return Err("LLM/ tree not found".into()) };
    let path2 = path.clone();
    // Read the location BEFORE deleting so we can auto-clean a sandbox copy.
    let location = tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        let conn = rusqlite::Connection::open(&path2)
            .map_err(|e| format!("open {}: {e}", path2.display()))?;
        ensure_schema(&conn)?;
        let loc: Option<String> = match conn.query_row(
            "SELECT location FROM agent_projects WHERE id = ?",
            rusqlite::params![id],
            |r| r.get::<_, String>(0),
        ) {
            Ok(s) => Some(s),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(format!("read location: {e}")),
        };
        conn.execute("DELETE FROM agent_projects WHERE id = ?", rusqlite::params![id])
            .map_err(|e| format!("delete: {e}"))?;
        Ok(loc)
    })
    .await
    .map_err(|e| format!("join error: {e}"))??;

    // Auto-clean on delete: remove the OwLLM-managed sandbox COPY (~/owllm/<name>)
    // if this project was one. Never touches the user's real Windows/host folder
    // (is_managed_sandbox_copy guards that). Best-effort — runs off-thread so a
    // slow WSL call doesn't block the UI, and a failure can't fail the delete.
    if let Some(loc) = location {
        tokio::task::spawn_blocking(move || crate::sandbox::cleanup_deleted_project(&loc));
    }
    Ok(())
}

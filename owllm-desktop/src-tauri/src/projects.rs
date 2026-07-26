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
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Default, Serialize, Clone)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub location: String,
    /// Shared portable identity. Unlike `location`, this follows the project
    /// across devices and is the only safe way to materialize it on a new PC.
    pub repo_url: String,
    /// Stable origin metadata for the UI. Folder bindings remain per-device.
    pub created_device_id: String,
    pub created_device_name: String,
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
    let Some(path) = project_db_path() else {
        return Ok(Vec::new());
    };
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let path2 = path.clone();
    tokio::task::spawn_blocking(move || read_projects(&path2))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

pub(crate) fn project_db_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_PROJECT_DB") {
        return Some(PathBuf::from(p));
    }
    // %APPDATA%\OwLLM Desktop\owllm_state.db, with the legacy
    // LLM/data/owllm_state.db as the fallback during the migration
    // window. Lives in paths::state_db_path().
    paths::state_db_path()
}

pub(crate) fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
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
            team_default_model_id TEXT NOT NULL DEFAULT '',\
            location_device_id TEXT NOT NULL DEFAULT ''\
            ,repo_url TEXT NOT NULL DEFAULT ''\
            ,created_device_id TEXT NOT NULL DEFAULT ''\
            ,created_device_name TEXT NOT NULL DEFAULT ''\
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
    let _ = conn.execute(
        "ALTER TABLE agent_projects ADD COLUMN location_device_id TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE agent_projects ADD COLUMN repo_url TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE agent_projects ADD COLUMN created_device_id TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE agent_projects ADD COLUMN created_device_name TEXT NOT NULL DEFAULT ''",
        [],
    );
    // Migrate the old global location column into a binding owned by THIS
    // computer. Previous sync releases copied foreign absolute paths into every
    // DB and then stamped them into each device's vault map. A path that does
    // not exist here is therefore not a usable local binding: ghost it once.
    if let Some(self_id) = crate::remote_devices::self_device_id() {
        migrate_location_ownership(conn, &self_id)?;
    }
    Ok(())
}

fn migrate_location_ownership(conn: &rusqlite::Connection, self_id: &str) -> Result<(), String> {
    let mut legacy = conn
        .prepare(
            "SELECT id, location FROM agent_projects \
             WHERE COALESCE(location_device_id, '') = ''",
        )
        .map_err(|e| format!("prepare location migration: {e}"))?;
    let rows = legacy
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| format!("query location migration: {e}"))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    drop(legacy);
    for (id, location) in rows {
        let valid = !location.trim().is_empty() && std::path::Path::new(&location).is_dir();
        conn.execute(
            "UPDATE agent_projects SET location = ?2, location_device_id = ?3 WHERE id = ?1",
            rusqlite::params![id, if valid { location } else { String::new() }, self_id],
        )
        .map_err(|e| format!("migrate project location: {e}"))?;
    }
    Ok(())
}

fn normalize_path_key(p: &str) -> String {
    p.trim()
        .trim_end_matches(['/', '\\'])
        .replace('/', "\\")
        .to_lowercase()
}

pub(crate) fn normalize_repo_url(input: &str) -> String {
    let mut s = input.trim().to_string();
    if s.is_empty() {
        return String::new();
    }
    if let Some(rest) = s.strip_prefix("git@github.com:") {
        s = format!("https://github.com/{rest}");
    }
    if let Some(rest) = s.strip_prefix("ssh://git@github.com/") {
        s = format!("https://github.com/{rest}");
    }
    if let Some((scheme_user, rest)) = s.split_once('@') {
        if scheme_user.starts_with("https://") && rest.starts_with("github.com/") {
            s = format!("https://{rest}");
        }
    }
    s = s.trim_end_matches('/').trim_end_matches(".git").to_string();
    s.to_lowercase()
}

fn git_origin_url(location: &str) -> String {
    let host = crate::agent_tools::host_cwd(location);
    let dir = Path::new(&host);
    if !dir.is_dir() {
        return String::new();
    }
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(["remote", "get-url", "origin"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    match cmd.output() {
        Ok(out) if out.status.success() => {
            normalize_repo_url(&String::from_utf8_lossy(&out.stdout))
        }
        _ => String::new(),
    }
}

fn read_projects(path: &std::path::Path) -> Result<Vec<ProjectRow>, String> {
    // Open read-write so we can run the idempotent migration that
    // adds chat_json / agent_logs_json to pre-existing databases.
    // Without that, this read would fail on older DBs the moment we
    // SELECT the new columns.
    let conn =
        rusqlite::Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;

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

    let self_id = crate::remote_devices::self_device_id().unwrap_or_default();
    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, \
             CASE WHEN location_device_id = ?1 THEN location ELSE '' END, \
             COALESCE(repo_url, ''), COALESCE(created_device_id, ''), \
             COALESCE(created_device_name, ''), trust_writes, \
             auto_approve_all, team_json, team_default_model_id, graph_json, \
             chat_json, agent_logs_json, updated_at, COALESCE(repo_url, '') \
             FROM agent_projects ORDER BY updated_at DESC",
        )
        .map_err(|e| format!("prepare: {e}"))?;
    let rows = stmt
        .query_map(rusqlite::params![self_id], |r| {
            let team_json: String = r.get(9)?;
            let team: Vec<String> = serde_json::from_str(&team_json).unwrap_or_default();
            Ok(ProjectRow {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get::<_, String>(2).unwrap_or_default(),
                location: r.get::<_, String>(3).unwrap_or_default(),
                repo_url: r.get::<_, String>(4).unwrap_or_default(),
                created_device_id: r.get::<_, String>(5).unwrap_or_default(),
                created_device_name: r.get::<_, String>(6).unwrap_or_default(),
                trust_writes: r.get::<_, i64>(7).unwrap_or(0) != 0,
                auto_approve_all: r.get::<_, i64>(8).unwrap_or(0) != 0,
                team,
                team_default_model_id: r.get::<_, String>(10).unwrap_or_default(),
                graph_json: r.get::<_, String>(11).unwrap_or_default(),
                chat_json: r.get::<_, String>(12).unwrap_or_default(),
                agent_logs_json: r.get::<_, String>(13).unwrap_or_default(),
                updated_at: r.get::<_, String>(14).unwrap_or_default(),
            })
        })
        .map_err(|e| format!("query: {e}"))?;
    let out: Result<Vec<_>, _> = rows.collect();
    let mut out = out.map_err(|e| format!("row decode: {e}"))?;
    drop(stmt);
    // Upgrade existing local repositories lazily. This makes GitHub the shared
    // identity without asking users to re-create projects that already have an
    // origin remote.
    for project in &mut out {
        if project.repo_url.is_empty() && !project.location.trim().is_empty() {
            if let Some(url) = git_origin(&project.location) {
                let _ = conn.execute(
                    "UPDATE agent_projects SET repo_url = ?2 WHERE id = ?1",
                    rusqlite::params![project.id, url],
                );
                project.repo_url = url;
            }
        }
    }
    Ok(out)
}

fn git_origin(location: &str) -> Option<String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C")
        .arg(location)
        .args(["remote", "get-url", "origin"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!url.is_empty() && url.contains("github.com")).then_some(url)
}

#[derive(Deserialize)]
pub struct ResolveProjectInput {
    pub location: String,
    #[serde(default)]
    pub name: Option<String>,
}

fn row_by_id(conn: &rusqlite::Connection, id: &str) -> Result<ProjectRow, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, location, COALESCE(repo_url, ''), \
             COALESCE(created_device_id, ''), COALESCE(created_device_name, ''), \
             trust_writes, auto_approve_all, team_json, team_default_model_id, graph_json, \
             chat_json, agent_logs_json, updated_at \
             FROM agent_projects WHERE id = ?1",
        )
        .map_err(|e| format!("prepare project row: {e}"))?;
    stmt.query_row(rusqlite::params![id], |r| {
        let team_json: String = r.get(9)?;
        Ok(ProjectRow {
            id: r.get(0)?,
            name: r.get(1)?,
            description: r.get::<_, String>(2).unwrap_or_default(),
            location: r.get::<_, String>(3).unwrap_or_default(),
            repo_url: r.get::<_, String>(4).unwrap_or_default(),
            created_device_id: r.get::<_, String>(5).unwrap_or_default(),
            created_device_name: r.get::<_, String>(6).unwrap_or_default(),
            trust_writes: r.get::<_, i64>(7).unwrap_or(0) != 0,
            auto_approve_all: r.get::<_, i64>(8).unwrap_or(0) != 0,
            team: serde_json::from_str(&team_json).unwrap_or_default(),
            team_default_model_id: r.get::<_, String>(10).unwrap_or_default(),
            graph_json: r.get::<_, String>(11).unwrap_or_default(),
            chat_json: r.get::<_, String>(12).unwrap_or_default(),
            agent_logs_json: r.get::<_, String>(13).unwrap_or_default(),
            updated_at: r.get::<_, String>(14).unwrap_or_default(),
        })
    })
    .map_err(|e| format!("read project row: {e}"))
}

#[tauri::command]
pub async fn resolve_project_for_location(
    input: ResolveProjectInput,
) -> Result<ProjectRow, String> {
    let Some(path) = project_db_path() else {
        return Err("LLM/ tree not found".into());
    };
    let path2 = path.clone();
    tokio::task::spawn_blocking(move || {
        let location = input.location.trim().to_string();
        if location.is_empty() {
            return Err("project location is required".to_string());
        }
        let repo_url = git_origin_url(&location);
        if let Some(parent) = path2.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let conn = rusqlite::Connection::open(&path2)
            .map_err(|e| format!("open {}: {e}", path2.display()))?;
        ensure_schema(&conn)?;
        let path_key = normalize_path_key(&location);
        let mut found: Option<(String, String)> = None;
        let mut repo_found: Option<(String, String)> = None;
        {
            let mut stmt = conn
                .prepare("SELECT id, location, COALESCE(repo_url, '') FROM agent_projects")
                .map_err(|e| format!("prepare project resolve: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1).unwrap_or_default(),
                        r.get::<_, String>(2).unwrap_or_default(),
                    ))
                })
                .map_err(|e| format!("query project resolve: {e}"))?;
            for row in rows {
                let (id, loc, repo) = row.map_err(|e| format!("project resolve row: {e}"))?;
                let repo = normalize_repo_url(&repo);
                if !loc.trim().is_empty() && normalize_path_key(&loc) == path_key {
                    found = Some((id, repo));
                    break;
                }
                if repo_found.is_none() && !repo_url.is_empty() && repo == repo_url {
                    repo_found = Some((id, repo));
                }
            }
        }
        // A repository may have duplicate portable rows after older vault
        // migrations. Never let an earlier repo-only match hide the project
        // row explicitly bound to this computer's exact folder.
        if found.is_none() {
            found = repo_found;
        }
        if let Some((id, existing_repo_url)) = found {
            conn.execute(
                "UPDATE agent_projects SET location = ?2 WHERE id = ?1",
                rusqlite::params![id, location],
            )
            .map_err(|e| format!("bind project location: {e}"))?;
            if !repo_url.is_empty() && existing_repo_url.is_empty() {
                let now = now_iso();
                conn.execute(
                    "UPDATE agent_projects SET repo_url = ?2, updated_at = ?3 WHERE id = ?1",
                    rusqlite::params![id, repo_url, now],
                )
                .map_err(|e| format!("bind project repo url: {e}"))?;
            }
            return row_by_id(&conn, &id);
        }

        let id = new_id();
        let now = now_iso();
        let name = input
            .name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| {
                Path::new(&crate::agent_tools::host_cwd(&location))
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Code project".to_string())
            });
        conn.execute(
            "INSERT INTO agent_projects (id, name, description, location, repo_url, trust_writes, auto_approve_all, \
             team_json, model_overrides_json, graph_json, created_at, updated_at, team_default_model_id) \
             VALUES (?1, ?2, '', ?3, ?4, 0, 0, '[]', '{}', '', ?5, ?5, '')",
            rusqlite::params![id, name, location, repo_url, now],
        )
        .map_err(|e| format!("insert resolved project: {e}"))?;
        row_by_id(&conn, &id)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

// ---------- Write API ----------

#[derive(Deserialize)]
pub struct CreateProjectInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub repo_url: String,
    /// Create `location` (including parents) for a new/workspace recipe.
    /// Existing-repository recipes leave this false and require a real folder.
    #[serde(default)]
    pub create_location: bool,
    /// Stable onboarding recipe id written into the initial Project Card.
    #[serde(default)]
    pub project_kind: String,
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
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
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
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut rand_bytes = [0u8; 8];
    getrand_unsafe(&mut rand_bytes);
    let rand_hex = rand_bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();
    format!("{:x}_{}", ms, rand_hex)
}

// Pull 8 random bytes from the platform RNG without a crate dep.
// rand_chacha would be cleaner but adds dep mass.
fn getrand_unsafe(buf: &mut [u8]) {
    use std::time::Instant;
    let mut seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Mix in a couple of clock samples — gives us enough entropy for
    // a per-record id collision-resistant against the few-projects-
    // per-second worst case.
    seed ^= Instant::now().elapsed().as_nanos();
    for b in buf.iter_mut() {
        seed = seed
            .wrapping_mul(6364136223846793005u128)
            .wrapping_add(1442695040888963407u128);
        *b = (seed >> 96) as u8;
    }
}

#[tauri::command]
pub async fn create_project(input: CreateProjectInput) -> Result<ProjectRow, String> {
    let Some(path) = project_db_path() else {
        return Err("LLM/ tree not found".into());
    };
    let path2 = path.clone();
    tokio::task::spawn_blocking(move || {
        let location = input.location.trim();
        // Goal-aware onboarding owns its workspace lifecycle. Older callers
        // (notably the text bridges) still create DB-only projects, so retain
        // that compatibility until those flows explicitly opt into a recipe.
        let managed_onboarding = input.create_location || !input.project_kind.trim().is_empty();
        if managed_onboarding && location.is_empty() {
            return Err("A project folder is required.".to_string());
        }
        let workspace = PathBuf::from(location);
        if input.create_location {
            if workspace.exists() && !workspace.is_dir() {
                return Err(format!("project location is not a folder: {}", workspace.display()));
            }
            std::fs::create_dir_all(&workspace)
                .map_err(|e| format!("create project folder {}: {e}", workspace.display()))?;
            let owllm_dir = workspace.join(".owllm");
            std::fs::create_dir_all(&owllm_dir)
                .map_err(|e| format!("create {}: {e}", owllm_dir.display()))?;
            let card_path = owllm_dir.join("project.json");
            if !card_path.exists() {
                let card = serde_json::json!({
                    "name": input.name.clone(),
                    "kind": input.project_kind.clone(),
                    "goal": input.description.clone(),
                    "mode": "team"
                });
                let body = serde_json::to_string_pretty(&card)
                    .map_err(|e| format!("encode project card: {e}"))?;
                std::fs::write(&card_path, format!("{body}\n"))
                    .map_err(|e| format!("write {}: {e}", card_path.display()))?;
            }
        } else if managed_onboarding && !workspace.is_dir() {
            return Err(format!(
                "This workflow needs an existing folder: {}",
                workspace.display()
            ));
        }
        if let Some(parent) = path2.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let conn = rusqlite::Connection::open(&path2)
            .map_err(|e| format!("open {}: {e}", path2.display()))?;
        ensure_schema(&conn)?;

        let id = new_id();
        let now = now_iso();
        let team_json = serde_json::to_string(&input.team).unwrap_or("[]".into());

        let self_id = crate::remote_devices::self_device_id().unwrap_or_default();
        let self_name = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "This PC".to_string());
        let repo_url = normalize_repo_url(&input.repo_url);
        conn.execute(
            "INSERT INTO agent_projects (id, name, description, location, location_device_id, repo_url, \
             created_device_id, created_device_name, trust_writes, auto_approve_all, team_json, \
             model_overrides_json, graph_json, created_at, updated_at, team_default_model_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '{}', ?12, ?13, ?13, ?14)",
            rusqlite::params![
                id,
                input.name,
                input.description,
                input.location,
                self_id,
                repo_url,
                self_id,
                self_name,
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
            repo_url,
            created_device_id: self_id,
            created_device_name: self_name,
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
    pub repo_url: Option<String>,
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
    let Some(path) = project_db_path() else {
        return Err("LLM/ tree not found".into());
    };
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
            sets.push("location_device_id = ?");
            params.push(Box::new(
                crate::remote_devices::self_device_id().unwrap_or_default(),
            ));
        }
        if let Some(v) = input.repo_url {
            sets.push("repo_url = ?");
            params.push(Box::new(normalize_repo_url(&v)));
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

        let sql = format!("UPDATE agent_projects SET {} WHERE id = ?", sets.join(", "));
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
    let Some(path) = project_db_path() else {
        return Err("LLM/ tree not found".into());
    };
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
        conn.execute(
            "DELETE FROM agent_projects WHERE id = ?",
            rusqlite::params![id],
        )
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

#[cfg(test)]
mod tests {
    use super::*;

    fn git_ok(cwd: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {:?} failed: {}{}",
            args,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn migration_keeps_only_folders_that_exist_on_this_computer() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        let valid =
            std::env::temp_dir().join(format!("owllm-project-binding-test-{}", std::process::id()));
        std::fs::create_dir_all(&valid).unwrap();
        let missing = valid.with_extension("missing");
        conn.execute(
            "INSERT INTO agent_projects \
             (id, name, location, location_device_id, created_at, updated_at) VALUES \
             ('valid', 'valid', ?1, '', 'x', 'x'), \
             ('foreign', 'foreign', ?2, '', 'x', 'x')",
            rusqlite::params![
                valid.to_string_lossy().to_string(),
                missing.to_string_lossy().to_string()
            ],
        )
        .unwrap();
        migrate_location_ownership(&conn, "device-here").unwrap();
        let valid_row: (String, String) = conn
            .query_row(
                "SELECT location, location_device_id FROM agent_projects WHERE id = 'valid'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let foreign_row: (String, String) = conn
            .query_row(
                "SELECT location, location_device_id FROM agent_projects WHERE id = 'foreign'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(valid_row.0, valid.to_string_lossy());
        assert_eq!(valid_row.1, "device-here");
        assert_eq!(foreign_row, (String::new(), "device-here".into()));
        let _ = std::fs::remove_dir_all(valid);
    }

    #[test]
    fn repo_url_normalization_matches_common_git_remote_forms() {
        assert_eq!(
            normalize_repo_url("git@github.com:OwLLM/LocaLLM.git\n"),
            "https://github.com/owllm/locallm"
        );
        assert_eq!(
            normalize_repo_url("https://token@github.com/OwLLM/LocaLLM.git"),
            "https://github.com/owllm/locallm"
        );
        assert_eq!(
            normalize_repo_url("ssh://git@github.com/OwLLM/LocaLLM/"),
            "https://github.com/owllm/locallm"
        );
    }

    #[test]
    fn resolve_project_for_location_reuses_existing_project_by_git_origin() {
        let _guard = crate::memory::PROJECT_DB_TEST_ENV_LOCK
            .lock()
            .expect("project test lock");
        let tmp = tempfile::tempdir().expect("tempdir");
        let db = tmp.path().join("state.db");
        std::env::set_var("OWLLM_PROJECT_DB", &db);
        let repo_a = tmp.path().join("repo-a");
        let repo_b = tmp.path().join("repo-b");
        std::fs::create_dir_all(&repo_a).unwrap();
        std::fs::create_dir_all(&repo_b).unwrap();
        git_ok(&repo_a, &["init", "-q"]);
        git_ok(&repo_b, &["init", "-q"]);
        git_ok(
            &repo_a,
            &["remote", "add", "origin", "git@github.com:OwLLM/Shared.git"],
        );
        git_ok(
            &repo_b,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/owllm/shared.git",
            ],
        );

        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            ensure_schema(&conn).unwrap();
            conn.execute(
                "INSERT INTO agent_projects (id, name, location, repo_url, created_at, updated_at) \
                 VALUES ('project-shared', 'Shared', ?1, ?2, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                rusqlite::params![
                    repo_a.to_string_lossy().to_string(),
                    normalize_repo_url("git@github.com:OwLLM/Shared.git"),
                ],
            )
            .unwrap();
        }

        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let row = rt
            .block_on(resolve_project_for_location(ResolveProjectInput {
                location: repo_b.to_string_lossy().to_string(),
                name: Some("Shared clone".to_string()),
            }))
            .expect("resolve project");

        assert_eq!(row.id, "project-shared");
        assert_eq!(
            normalize_path_key(&row.location),
            normalize_path_key(&repo_b.to_string_lossy())
        );
        assert_eq!(row.repo_url, "https://github.com/owllm/shared");
        std::env::remove_var("OWLLM_PROJECT_DB");
    }

    #[test]
    fn resolve_project_for_location_prefers_exact_folder_over_earlier_repo_duplicate() {
        let _guard = crate::memory::PROJECT_DB_TEST_ENV_LOCK
            .lock()
            .expect("project test lock");
        let tmp = tempfile::tempdir().expect("tempdir");
        let db = tmp.path().join("state.db");
        std::env::set_var("OWLLM_PROJECT_DB", &db);
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git_ok(&repo, &["init", "-q"]);
        git_ok(
            &repo,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/OwLLM/Shared.git",
            ],
        );

        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            ensure_schema(&conn).unwrap();
            // The stale portable duplicate is deliberately inserted first:
            // the old one-pass resolver returned it before seeing the exact
            // local-folder binding and Coding opened an empty memory scope.
            conn.execute(
                "INSERT INTO agent_projects (id, name, location, repo_url, created_at, updated_at) \
                 VALUES ('repo-duplicate', 'Duplicate', '', ?1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                rusqlite::params![normalize_repo_url(
                    "https://github.com/OwLLM/Shared.git"
                )],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO agent_projects (id, name, location, repo_url, created_at, updated_at) \
                 VALUES ('project-exact', 'Exact', ?1, ?2, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')",
                rusqlite::params![
                    repo.to_string_lossy().to_string(),
                    normalize_repo_url("https://github.com/OwLLM/Shared.git"),
                ],
            )
            .unwrap();
        }

        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let row = rt
            .block_on(resolve_project_for_location(ResolveProjectInput {
                location: repo.to_string_lossy().to_string(),
                name: Some("Shared clone".to_string()),
            }))
            .expect("resolve project");

        assert_eq!(row.id, "project-exact");
        std::env::remove_var("OWLLM_PROJECT_DB");
    }
}

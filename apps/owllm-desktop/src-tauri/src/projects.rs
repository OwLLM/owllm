// Project listing — reads from the legacy SQLite at
// `LLM/data/owllm_state.db`, the SAME database the PySide6 app's
// ProjectStore writes to. This first cut is read-only; create /
// rename / delete will come once Studio + Agents pages need them.
//
// Schema (LLM/core/agents/projects.py:140-200):
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
use serde::Serialize;
use std::path::PathBuf;

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
    // rusqlite is sync; offload to blocking so we don't stall the Tauri
    // async runtime (the file may live on a slow disk).
    let path2 = path.clone();
    tokio::task::spawn_blocking(move || read_projects(&path2))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn project_db_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OWLLM_PROJECT_DB") {
        return Some(PathBuf::from(p));
    }
    Some(paths::llm_root()?.join("data").join("owllm_state.db"))
}

fn read_projects(path: &std::path::Path) -> Result<Vec<ProjectRow>, String> {
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| format!("open {}: {e}", path.display()))?;

    // Table may not exist if the legacy app never ran here.
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

    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, location, trust_writes, \
             auto_approve_all, team_json, team_default_model_id, updated_at \
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
                updated_at: r.get::<_, String>(8).unwrap_or_default(),
            })
        })
        .map_err(|e| format!("query: {e}"))?;
    let out: Result<Vec<_>, _> = rows.collect();
    out.map_err(|e| format!("row decode: {e}"))
}

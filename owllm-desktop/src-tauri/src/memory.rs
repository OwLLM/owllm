// Agentic memory — two stores, one SQLite DB (the same owllm_state.db that
// projects.rs owns).
//
//  1. agent_memory — PER-AGENT conversational memory. Each specialist used to
//     run as a stateless one-shot (history=undefined): it saw only the single
//     dispatch instruction, never its own prior turns. That is why teams "had no
//     memory of what happened". We now persist each (instruction → reply) pair
//     per (project, agent) and fold the recent tail back into that agent's
//     `history` on the next dispatch — model-agnostic (works for local, Claude,
//     Codex, Gemini, Kimi, API alike; it does NOT rely on any CLI --session-id).
//
//  2. team_memory — a SHARED, RAG-like knowledge store scoped to the project.
//     Any agent can WRITE a durable fact/decision/artifact and SEARCH it later
//     (keyword-scored LIKE retrieval — light, no FTS/vector dependency, but
//     ranked by term hits + recency). Exposed to agents as the memory_write /
//     memory_search / memory_read native tools (localTools.ts).
//
// Both tables live in the project DB so memory survives app restarts and is
// shared across every run of the same project.

use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn open_db() -> Result<rusqlite::Connection, String> {
    let path = crate::projects::project_db_path()
        .ok_or_else(|| "no project database path".to_string())?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = rusqlite::Connection::open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_memory (\
            id INTEGER PRIMARY KEY AUTOINCREMENT,\
            project_id TEXT NOT NULL,\
            agent_name TEXT NOT NULL,\
            role TEXT NOT NULL,\
            content TEXT NOT NULL,\
            ts INTEGER NOT NULL\
        );\
        CREATE INDEX IF NOT EXISTS idx_agent_memory ON agent_memory(project_id, agent_name, id);\
        CREATE TABLE IF NOT EXISTS team_memory (\
            id INTEGER PRIMARY KEY AUTOINCREMENT,\
            scope TEXT NOT NULL,\
            mkey TEXT NOT NULL DEFAULT '',\
            content TEXT NOT NULL,\
            tags TEXT NOT NULL DEFAULT '',\
            author TEXT NOT NULL DEFAULT '',\
            ts INTEGER NOT NULL\
        );\
        CREATE INDEX IF NOT EXISTS idx_team_memory ON team_memory(scope, id);",
    )
    .map_err(|e| format!("ensure memory schema: {e}"))
}

// ---------------------------------------------------------------------------
// Per-agent conversational memory
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct MemTurn {
    pub role: String,
    pub content: String,
}

/// Return the most recent `limit` turns for one (project, agent), oldest-first
/// (ready to splice straight into a `history` array). `limit` caps the count;
/// callers also budget by characters on the TS side.
#[tauri::command]
pub async fn agent_memory_get(
    project_id: String,
    agent_name: String,
    limit: Option<u32>,
) -> Result<Vec<MemTurn>, String> {
    let lim = limit.unwrap_or(20).clamp(1, 200) as i64;
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        // Pull the newest `lim` rows, then reverse to oldest-first.
        let mut stmt = conn
            .prepare(
                "SELECT role, content FROM agent_memory \
                 WHERE project_id = ?1 AND agent_name = ?2 \
                 ORDER BY id DESC LIMIT ?3",
            )
            .map_err(|e| format!("prepare: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![project_id, agent_name, lim], |r| {
                Ok(MemTurn { role: r.get(0)?, content: r.get(1)? })
            })
            .map_err(|e| format!("query: {e}"))?;
        let mut out: Vec<MemTurn> = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("row: {e}"))?);
        }
        out.reverse();
        Ok(out)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Append one (instruction → reply) exchange for an agent. Empty content is
/// skipped so a failed/blank reply doesn't pollute memory.
#[tauri::command]
pub async fn agent_memory_append(
    project_id: String,
    agent_name: String,
    instruction: String,
    reply: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        let ts = now_ms();
        if !instruction.trim().is_empty() {
            conn.execute(
                "INSERT INTO agent_memory (project_id, agent_name, role, content, ts) \
                 VALUES (?1, ?2, 'user', ?3, ?4)",
                rusqlite::params![project_id, agent_name, instruction, ts],
            )
            .map_err(|e| format!("insert instruction: {e}"))?;
        }
        if !reply.trim().is_empty() {
            conn.execute(
                "INSERT INTO agent_memory (project_id, agent_name, role, content, ts) \
                 VALUES (?1, ?2, 'assistant', ?3, ?4)",
                rusqlite::params![project_id, agent_name, reply, ts],
            )
            .map_err(|e| format!("insert reply: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Forget an agent's memory (one agent, or the whole project when agent_name is
/// None). Wired to a "Clear memory" affordance and the project-reset path.
#[tauri::command]
pub async fn agent_memory_clear(
    project_id: String,
    agent_name: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        match agent_name {
            Some(a) => conn.execute(
                "DELETE FROM agent_memory WHERE project_id = ?1 AND agent_name = ?2",
                rusqlite::params![project_id, a],
            ),
            None => conn.execute(
                "DELETE FROM agent_memory WHERE project_id = ?1",
                rusqlite::params![project_id],
            ),
        }
        .map_err(|e| format!("delete: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

// ---------------------------------------------------------------------------
// Shared team memory (RAG-like)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct TeamMemoryEntry {
    pub id: i64,
    pub key: String,
    pub content: String,
    pub tags: String,
    pub author: String,
    pub ts: i64,
}

fn scope_of(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() { "global".to_string() } else { t.to_string() }
}

/// Store (or upsert when `key` is non-empty) one shared memory entry. Returns
/// its row id. Upsert-on-key lets an agent revise a known fact ("build_command")
/// instead of piling duplicates.
#[tauri::command]
pub async fn team_memory_write(
    scope: String,
    content: String,
    key: Option<String>,
    tags: Option<String>,
    author: Option<String>,
) -> Result<i64, String> {
    if content.trim().is_empty() {
        return Err("content is empty".to_string());
    }
    let sc = scope_of(&scope);
    let k = key.unwrap_or_default();
    let tg = tags.unwrap_or_default();
    let au = author.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        let ts = now_ms();
        if !k.trim().is_empty() {
            // Upsert by (scope, key): update in place if present.
            let updated = conn
                .execute(
                    "UPDATE team_memory SET content = ?1, tags = ?2, author = ?3, ts = ?4 \
                     WHERE scope = ?5 AND mkey = ?6",
                    rusqlite::params![content, tg, au, ts, sc, k],
                )
                .map_err(|e| format!("update: {e}"))?;
            if updated > 0 {
                let id: i64 = conn
                    .query_row(
                        "SELECT id FROM team_memory WHERE scope = ?1 AND mkey = ?2",
                        rusqlite::params![sc, k],
                        |r| r.get(0),
                    )
                    .map_err(|e| format!("select id: {e}"))?;
                return Ok(id);
            }
        }
        conn.execute(
            "INSERT INTO team_memory (scope, mkey, content, tags, author, ts) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![sc, k, content, tg, au, ts],
        )
        .map_err(|e| format!("insert: {e}"))?;
        Ok(conn.last_insert_rowid())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Keyword-scored retrieval over a project's shared memory. Splits the query
/// into terms; scores each row by the number of distinct terms it contains
/// (content + tags + key), tie-broken by recency. An empty query returns the
/// most recent entries (acts as "list"). Light, deterministic, dependency-free.
#[tauri::command]
pub async fn team_memory_search(
    scope: String,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<TeamMemoryEntry>, String> {
    let sc = scope_of(&scope);
    let lim = limit.unwrap_or(8).clamp(1, 50) as usize;
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, mkey, content, tags, author, ts FROM team_memory \
                 WHERE scope = ?1 ORDER BY id DESC LIMIT 500",
            )
            .map_err(|e| format!("prepare: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![sc], |r| {
                Ok(TeamMemoryEntry {
                    id: r.get(0)?,
                    key: r.get(1)?,
                    content: r.get(2)?,
                    tags: r.get(3)?,
                    author: r.get(4)?,
                    ts: r.get(5)?,
                })
            })
            .map_err(|e| format!("query: {e}"))?;
        let mut all: Vec<TeamMemoryEntry> = Vec::new();
        for r in rows {
            all.push(r.map_err(|e| format!("row: {e}"))?);
        }
        let terms: Vec<String> = query
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| t.len() >= 2)
            .map(|t| t.to_string())
            .collect();
        if terms.is_empty() {
            all.truncate(lim);
            return Ok(all);
        }
        // Score by distinct-term hits; keep only rows that match ≥1 term.
        let mut scored: Vec<(i32, i64, TeamMemoryEntry)> = all
            .into_iter()
            .map(|e| {
                let hay = format!("{} {} {}", e.content, e.tags, e.key).to_lowercase();
                let score = terms.iter().filter(|t| hay.contains(t.as_str())).count() as i32;
                (score, e.ts, e)
            })
            .filter(|(score, _, _)| *score > 0)
            .collect();
        // Highest score first, then most-recent.
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
        Ok(scored.into_iter().take(lim).map(|(_, _, e)| e).collect())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Fetch one shared entry by its exact key (the precise complement to search).
#[tauri::command]
pub async fn team_memory_read(
    scope: String,
    key: String,
) -> Result<Option<TeamMemoryEntry>, String> {
    let sc = scope_of(&scope);
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        let res = conn.query_row(
            "SELECT id, mkey, content, tags, author, ts FROM team_memory \
             WHERE scope = ?1 AND mkey = ?2 ORDER BY id DESC LIMIT 1",
            rusqlite::params![sc, key],
            |r| {
                Ok(TeamMemoryEntry {
                    id: r.get(0)?,
                    key: r.get(1)?,
                    content: r.get(2)?,
                    tags: r.get(3)?,
                    author: r.get(4)?,
                    ts: r.get(5)?,
                })
            },
        );
        match res {
            Ok(e) => Ok(Some(e)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("read: {e}")),
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

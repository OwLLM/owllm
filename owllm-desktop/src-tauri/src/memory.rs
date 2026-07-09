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

pub(crate) fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
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
            ts INTEGER NOT NULL,\
            kind TEXT NOT NULL DEFAULT 'fact'\
        );\
        CREATE INDEX IF NOT EXISTS idx_team_memory ON team_memory(scope, id);",
    )
    .map_err(|e| format!("ensure memory schema: {e}"))?;
    // Legacy DBs predate the `kind` column (fact vs worklog). Ignored-error
    // ALTER is the repo's migration idiom (see projects.rs); the backfill runs
    // ONLY when the column was actually added — kind is otherwise derived from
    // the entry point (team_memory_log → worklog, team_memory_write → fact),
    // never from tags, so an agent writing tags="worklog" can't be reclassified.
    let added = conn
        .execute(
            "ALTER TABLE team_memory ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact'",
            [],
        )
        .is_ok();
    if added {
        let _ = conn.execute(
            "UPDATE team_memory SET kind = 'worklog' WHERE tags = 'worklog'",
            [],
        );
        normalize_existing_tags(conn);
    }
    Ok(())
}

/// Collapse whitespace runs and trim — the identity used for keyless-fact
/// dedup. Case is PRESERVED: commands, paths and env names are case-significant
/// and lowercasing would falsely merge them.
pub(crate) fn normalize_content(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Canonical tag spelling: lowercase, trimmed, hyphenated, comma-joined,
/// deduped. Free-form tags are kept (they feed the ranker and the graph);
/// only the spelling is normalized so clusters actually cluster.
pub(crate) fn normalize_tags(s: &str) -> String {
    let mut seen: Vec<String> = Vec::new();
    for raw in s.split([',', '\n', ';']) {
        let t = raw
            .trim()
            .to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("-");
        if !t.is_empty() && !seen.iter().any(|x| x == &t) {
            seen.push(t);
        }
    }
    seen.join(",")
}

/// One-time (gated on the kind-column ALTER) canonicalization of tags written
/// before normalization existed.
fn normalize_existing_tags(conn: &rusqlite::Connection) {
    let rows: Vec<(i64, String)> = match conn.prepare("SELECT id, tags FROM team_memory WHERE tags != ''") {
        Ok(mut stmt) => match stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))) {
            Ok(it) => it.filter_map(|r| r.ok()).collect(),
            Err(_) => return,
        },
        Err(_) => return,
    };
    for (id, tags) in rows {
        let norm = normalize_tags(&tags);
        if norm != tags {
            let _ = conn.execute(
                "UPDATE team_memory SET tags = ?1 WHERE id = ?2",
                rusqlite::params![norm, id],
            );
        }
    }
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
    /// 'fact' (durable, curated, vault-synced) or 'worklog' (auto-captured
    /// work transcript: local-only, hard-capped, never exported).
    pub kind: String,
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
    let tg = normalize_tags(&tags.unwrap_or_default());
    let au = author.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        let ts = now_ms();
        if !k.trim().is_empty() {
            // Upsert by (scope, key): update in place if present.
            let updated = conn
                .execute(
                    "UPDATE team_memory SET content = ?1, tags = ?2, author = ?3, ts = ?4, kind = 'fact' \
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
        } else {
            // Keyless: fold into an existing fact with the same normalized
            // content instead of piling duplicates (re-run goals re-derive the
            // same facts). Whitespace-insensitive, case-SENSITIVE compare.
            let norm = normalize_content(&content);
            let mut stmt = conn
                .prepare(
                    "SELECT id, content FROM team_memory \
                     WHERE scope = ?1 AND mkey = '' AND kind = 'fact'",
                )
                .map_err(|e| format!("prepare dedup: {e}"))?;
            let existing: Option<i64> = stmt
                .query_map(rusqlite::params![sc], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(|e| format!("dedup query: {e}"))?
                .filter_map(|r| r.ok())
                .find(|(_, c)| normalize_content(c) == norm)
                .map(|(id, _)| id);
            if let Some(id) = existing {
                conn.execute(
                    "UPDATE team_memory SET tags = ?1, author = ?2, ts = ?3 WHERE id = ?4",
                    rusqlite::params![tg, au, ts, id],
                )
                .map_err(|e| format!("touch duplicate: {e}"))?;
                return Ok(id);
            }
        }
        conn.execute(
            "INSERT INTO team_memory (scope, mkey, content, tags, author, ts, kind) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'fact')",
            rusqlite::params![sc, k, content, tg, au, ts],
        )
        .map_err(|e| format!("insert: {e}"))?;
        Ok(conn.last_insert_rowid())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Append one AUTO-CAPTURED work-state record (what an agent just did) and prune
/// old work records so the store stays a LIVE picture of the work, not an
/// ever-growing log. Distinct from team_memory_write (opt-in durable facts): this
/// is the HARNESS recording the work itself, tagged 'worklog' + authored by the
/// agent, so every later agent can retrieve what teammates did — relevance-ranked
/// by team_memory_search. Returns the new row id.
#[tauri::command]
pub async fn team_memory_log(
    scope: String,
    agent: String,
    content: String,
    keep: Option<u32>,
) -> Result<i64, String> {
    if content.trim().is_empty() {
        return Err("content is empty".to_string());
    }
    let sc = scope_of(&scope);
    let keep = keep.unwrap_or(100).clamp(20, 2000) as i64;
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        let ts = now_ms();
        conn.execute(
            "INSERT INTO team_memory (scope, mkey, content, tags, author, ts, kind) \
             VALUES (?1, '', ?2, 'worklog', ?3, ?4, 'worklog')",
            rusqlite::params![sc, content, agent, ts],
        )
        .map_err(|e| format!("insert worklog: {e}"))?;
        let id = conn.last_insert_rowid();
        // Keep only the newest `keep` worklog rows for this scope; opt-in
        // memory_write facts (kind='fact') are never pruned here.
        conn.execute(
            "DELETE FROM team_memory WHERE scope = ?1 AND kind = 'worklog' AND id NOT IN (\
               SELECT id FROM team_memory WHERE scope = ?1 AND kind = 'worklog' \
               ORDER BY id DESC LIMIT ?2)",
            rusqlite::params![sc, keep],
        )
        .map_err(|e| format!("prune worklog: {e}"))?;
        Ok(id)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Split into lowercase alphanumeric tokens (≥2 chars) — the shared tokenizer
/// for both query and rows, so matching is exact-token ("ci" no longer hits
/// "specific") rather than substring.
fn tokenize(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 2)
        .map(|t| t.to_string())
        .collect()
}

/// Keyword-scored retrieval over a project's shared memory — a dependency-free
/// BM25-lite. Exact-token matching per field with weights (key×3, tags×2,
/// content×1), corpus IDF so ubiquitous words stop dominating, light length
/// normalization so verbose worklogs stop out-scoring concise facts; ties break
/// by recency. `kinds` optionally restricts to 'fact' / 'worklog' rows. An
/// empty query returns the most recent entries (acts as "list").
#[tauri::command]
pub async fn team_memory_search(
    scope: String,
    query: String,
    limit: Option<u32>,
    kinds: Option<Vec<String>>,
) -> Result<Vec<TeamMemoryEntry>, String> {
    let sc = scope_of(&scope);
    // Up to 500 so the graph view can show the whole brain; the agent-facing
    // memory_search tool still passes small limits (8).
    let lim = limit.unwrap_or(8).clamp(1, 500) as usize;
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, mkey, content, tags, author, ts, kind FROM team_memory \
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
                    kind: r.get(6)?,
                })
            })
            .map_err(|e| format!("query: {e}"))?;
        let mut all: Vec<TeamMemoryEntry> = Vec::new();
        for r in rows {
            all.push(r.map_err(|e| format!("row: {e}"))?);
        }
        if let Some(ks) = kinds.as_ref().filter(|ks| !ks.is_empty()) {
            all.retain(|e| ks.iter().any(|k| k == &e.kind));
        }
        let mut terms = tokenize(&query);
        terms.dedup();
        terms.sort();
        terms.dedup();
        if terms.is_empty() {
            all.truncate(lim);
            return Ok(all);
        }
        // Pre-tokenize each row's fields once.
        struct RowTokens {
            key: std::collections::HashSet<String>,
            tags: std::collections::HashSet<String>,
            content: std::collections::HashSet<String>,
            content_len: usize,
        }
        let toks: Vec<RowTokens> = all
            .iter()
            .map(|e| {
                let content: Vec<String> = tokenize(&e.content);
                let content_len = content.len();
                RowTokens {
                    key: tokenize(&e.key).into_iter().collect(),
                    tags: tokenize(&e.tags).into_iter().collect(),
                    content: content.into_iter().collect(),
                    content_len,
                }
            })
            .collect();
        let n = all.len() as f64;
        let avg_len = (toks.iter().map(|t| t.content_len).sum::<usize>() as f64 / n.max(1.0)).max(1.0);
        // IDF per query term over the loaded corpus: a term present in every
        // row scores ~0, a rare term scores high — corpus-specific stopwording.
        let idf: Vec<f64> = terms
            .iter()
            .map(|t| {
                let df = toks
                    .iter()
                    .filter(|r| r.content.contains(t) || r.tags.contains(t) || r.key.contains(t))
                    .count() as f64;
                (1.0 + (n - df + 0.5) / (df + 0.5)).ln()
            })
            .collect();
        let mut scored: Vec<(f64, i64, TeamMemoryEntry)> = all
            .into_iter()
            .zip(toks)
            .map(|(e, r)| {
                let raw: f64 = terms
                    .iter()
                    .zip(&idf)
                    .map(|(t, w)| {
                        let field = if r.key.contains(t) {
                            3.0
                        } else if r.tags.contains(t) {
                            2.0
                        } else if r.content.contains(t) {
                            1.0
                        } else {
                            0.0
                        };
                        field * w
                    })
                    .sum();
                let norm = 0.75 + 0.25 * (r.content_len as f64 / avg_len);
                (raw / norm, e.ts, e)
            })
            .filter(|(score, _, _)| *score > 0.0)
            .collect();
        // Highest score first, then most-recent.
        scored.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.1.cmp(&a.1))
        });
        Ok(scored.into_iter().take(lim).map(|(_, _, e)| e).collect())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Promote one auto-captured worklog row into a durable fact (the viewer's
/// "promote" affordance). Clears the 'worklog' tag so the row survives the
/// vault import quarantine on other devices.
#[tauri::command]
pub async fn team_memory_promote(scope: String, id: i64) -> Result<usize, String> {
    let sc = scope_of(&scope);
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        conn.execute(
            "UPDATE team_memory SET kind = 'fact', tags = '' \
             WHERE scope = ?1 AND id = ?2 AND kind = 'worklog'",
            rusqlite::params![sc, id],
        )
        .map_err(|e| format!("promote: {e}"))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Delete one shared entry by row id (the viewer's per-row delete). Returns the
/// number of rows removed (0 if the id wasn't in this scope).
#[tauri::command]
pub async fn team_memory_delete(scope: String, id: i64) -> Result<usize, String> {
    let sc = scope_of(&scope);
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        conn.execute(
            "DELETE FROM team_memory WHERE scope = ?1 AND id = ?2",
            rusqlite::params![sc, id],
        )
        .map_err(|e| format!("delete: {e}"))
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
            "SELECT id, mkey, content, tags, author, ts, kind FROM team_memory \
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
                    kind: r.get(6)?,
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

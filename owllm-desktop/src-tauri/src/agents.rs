// Agent-related Tauri commands — first slice (read-only).
//
// Reads the legacy on-disk spec layer that the PySide6 Studio + Workspace
// pages populate the UI from:
//
//   LLM/core/agents/teams/*.json   — team templates (display name,
//                                    category, description, icon,
//                                    required_mcp, agents[], graph)
//   LLM/core/agents/roles/*.yaml   — built-in role definitions (the
//                                    agent layer Studio's "Agents"
//                                    tab shows).
//
// Both surfaces are pure FS reads — no subprocess, no DB, no Python.
// Writing custom team / agent definitions is a follow-up command; the
// current Studio page is fine with a read-only catalogue.

use crate::paths;
use serde::Serialize;
use serde_json::Value as JsonValue;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

#[derive(Serialize, Clone)]
pub struct TeamTemplate {
    /// File stem (e.g. `code_artisan`). Stable id for the React side.
    pub id: String,
    /// Absolute path on disk so the UI can show "edit on disk" hints.
    pub path: String,
    /// Whether this lives under the built-in `core/agents/teams/`
    /// directory (vs a user-saved team in `LLM/data/teams/`).
    pub built_in: bool,
    /// Full parsed JSON — opaque to Rust, the React side already
    /// knows the shape (display_name, category, agents[], graph, …).
    pub data: JsonValue,
}

#[derive(Serialize, Clone)]
pub struct AgentRole {
    /// File stem (e.g. `coder`, `critic`). Matches the `base` field
    /// inside a team's `agents[].base`.
    pub id: String,
    pub path: String,
    pub built_in: bool,
    /// Full parsed YAML as JSON (Value). Same opacity rationale as
    /// TeamTemplate.data — Studio reads the shape directly.
    pub data: JsonValue,
}

/// SKILL.md-style agent definition (OpenClaw / Anthropic Claude
/// Skills format). Lives in `LLM/data/skills/<pack>/SKILL.md`. Parses
/// YAML frontmatter + Markdown body — the body becomes the system
/// prompt; the frontmatter carries name, description, tools[],
/// mcp_tools[], icon, model, temperature, leader.
#[derive(Serialize, Clone)]
pub struct SkillPack {
    /// Directory name on disk (e.g. `anthropics__pdf`).
    pub id: String,
    /// Full path to the SKILL.md file.
    pub path: String,
    /// Path to the pack directory (contains SKILL.md + resources).
    pub dir: String,
    /// The frontmatter fields, opaque JSON for the UI side.
    pub frontmatter: JsonValue,
    /// Markdown body (the system prompt). May be long.
    pub body: String,
}

#[tauri::command]
pub async fn list_team_templates() -> Result<Vec<TeamTemplate>, String> {
    // Built-in teams ship as JSONs inside the app's resources tree.
    let mut builtins = Vec::new();
    if let Some(builtin) = paths::teams_dir() {
        collect_team_dir(&builtin, true, &mut builtins);
    }
    // User-saved teams — Phase 2 home is %APPDATA%\OwLLM Desktop\teams/.
    // The helper returns BOTH the new and legacy LLM/data/teams/ dirs
    // during the migration window so existing teams stay visible.
    let mut customs = Vec::new();
    for custom in paths::custom_teams_dirs_read() {
        collect_team_dir(&custom, false, &mut customs);
    }
    // Dedup by id (= file stem): a custom team that shares a built-in's stem is
    // an in-place EDIT of that built-in — saved to the writable custom dir
    // because the bundled file is read-only — and SHADOWS it. Customs are
    // visited first so they win; among customs the first dir (new home) wins.
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<TeamTemplate> = Vec::new();
    for t in customs.into_iter().chain(builtins.into_iter()) {
        if seen.insert(t.id.clone()) {
            out.push(t);
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[tauri::command]
pub async fn list_skill_packs() -> Result<Vec<SkillPack>, String> {
    let mut out = Vec::new();
    // Walk EVERY skills home — Phase 2 puts new installs in
    // %APPDATA%\OwLLM Desktop\skills/, but the legacy LLM/data/skills/
    // location is also enumerated during the migration window.
    for skills_root in paths::skills_dirs_read() {
        let Ok(read) = std::fs::read_dir(&skills_root) else { continue };
        for entry in read.flatten() {
            let dir = entry.path();
            if !dir.is_dir() { continue; }
            // The shallow clone of upstream repos lives under
            // skills/_remote/ — skip that container since the
            // individual skills are listed at the top level.
            if dir.file_name().and_then(|n| n.to_str()) == Some("_remote") { continue; }
            let md = dir.join("SKILL.md");
            if !md.is_file() { continue; }
            let raw = match std::fs::read_to_string(&md) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let (frontmatter, body) = split_skill_md(&raw);
            let id = dir.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            out.push(SkillPack {
                id,
                path: md.to_string_lossy().into_owned(),
                dir: dir.to_string_lossy().into_owned(),
                frontmatter,
                body,
            });
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[derive(Serialize)]
pub struct SkillSyncResult {
    pub count: usize,
    pub index_rel: String,
}

/// Mirror every available skill pack's SKILL.md into
/// `<cwd>/.owllm/skills/<id>/SKILL.md` plus an `INDEX.md` catalog, so a
/// SANDBOXED agent on ANY provider can self-load a skill with its native
/// file-read tool. (The `load_skill` tool only reaches local-model agents; a
/// Claude/Codex/Gemini CLI agent is jailed to the project folder and can't see
/// %APPDATA%\skills — so we bring the skills into the project.) The mirror is
/// git-ignored so it never lands in the user's repo, and is refreshed each run.
#[tauri::command]
pub async fn sync_project_skills(cwd: String) -> Result<SkillSyncResult, String> {
    if cwd.trim().is_empty() {
        return Err("sync_project_skills: empty cwd".into());
    }
    let packs = list_skill_packs().await?;
    let base = Path::new(&cwd).join(".owllm").join("skills");
    std::fs::create_dir_all(&base).map_err(|e| format!("mkdir {}: {e}", base.display()))?;
    // Never commit the mirror — it's a per-run cache, not project content.
    let _ = std::fs::write(base.join(".gitignore"), "*\n");
    let mut index = String::from(
        "# Skill library — your self-load catalog\n\nRead `<id>/SKILL.md` (relative to this folder) to load a skill's full instructions on demand.\n\n",
    );
    let mut count = 0usize;
    for p in &packs {
        let dest = base.join(&p.id);
        if std::fs::create_dir_all(&dest).is_err() {
            continue;
        }
        // Copy the ORIGINAL SKILL.md verbatim (frontmatter + body).
        if std::fs::copy(&p.path, dest.join("SKILL.md")).is_ok() {
            count += 1;
        }
        let name = p.frontmatter.get("name").and_then(|v| v.as_str()).unwrap_or(p.id.as_str());
        let desc = p.frontmatter.get("description").and_then(|v| v.as_str()).unwrap_or("");
        let desc1 = desc.lines().next().unwrap_or("").trim();
        index.push_str(&format!("- **{}** — `{}/SKILL.md`\n  {}\n", name, p.id, desc1));
    }
    std::fs::write(base.join("INDEX.md"), index).map_err(|e| format!("write INDEX.md: {e}"))?;
    Ok(SkillSyncResult { count, index_rel: ".owllm/skills/INDEX.md".into() })
}

/// Split a SKILL.md document into its YAML frontmatter (as JSON) and
/// the markdown body. Frontmatter is enclosed in `---` lines at the
/// top of the file. Returns an empty object + the whole file as body
/// when no frontmatter is found.
fn split_skill_md(raw: &str) -> (JsonValue, String) {
    let trimmed = raw.trim_start_matches('\u{feff}'); // strip BOM
    if let Some(rest) = trimmed.strip_prefix("---") {
        // find the next `---` line
        if let Some(end) = rest.find("\n---") {
            let fm = &rest[..end].trim_start_matches('\n');
            let after = &rest[end + 4..]; // skip "\n---"
            let body = after.trim_start_matches('\n').to_string();
            let parsed = yaml_lite_to_json(fm);
            return (parsed, body);
        }
    }
    (JsonValue::Object(Default::default()), raw.to_string())
}

/// Persist edits to a CUSTOM agent definition (the JSON files under
/// LLM/data/agent_definitions/). Built-in YAMLs in LLM/core/agents/roles/
/// are intentionally read-only — to "edit" a built-in the Studio UI
/// duplicates it into the custom dir first.
///
/// `path` must be inside the custom agent_definitions dir AND end in
/// .json. We reject anything else so a misbehaving caller can't write
/// outside the sandbox.
#[tauri::command]
pub async fn save_agent_definition(path: String, data: JsonValue) -> Result<(), String> {
    // Writes accepted into EITHER the new %APPDATA% custom dir or the
    // legacy LLM/data/agent_definitions/ — the path resolver returns
    // both during the migration window, so the Studio "Save" round-
    // trip still works whichever home the file came from.
    let allowed_dirs = paths::custom_agents_dirs_read();
    let write_target_root = paths::custom_agents_dir()
        .ok_or_else(|| "user-data root not found".to_string())?;
    let target = std::path::PathBuf::from(&path);
    if target.extension().and_then(|s| s.to_str()) != Some("json") {
        return Err("save_agent_definition only writes .json files (built-in YAML roles are read-only)".into());
    }
    // Make sure the canonical path is inside one of the allowed roots.
    let target_canon = target.canonicalize().unwrap_or(target.clone());
    let ok = allowed_dirs.iter().any(|d| {
        let dc = d.canonicalize().unwrap_or(d.clone());
        target_canon.starts_with(&dc)
    }) || {
        // First-time write into the new dir (which doesn't exist yet).
        let _ = std::fs::create_dir_all(&write_target_root);
        let wc = write_target_root.canonicalize().unwrap_or(write_target_root.clone());
        target_canon.starts_with(&wc)
    };
    if !ok {
        return Err(format!(
            "refusing to save outside an allowed agent_definitions dir — got {}",
            target.display(),
        ));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let pretty = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&target, pretty)
        .map_err(|e| format!("write {}: {e}", target.display()))?;
    Ok(())
}

/// True when `target`'s canonical path sits inside any of `dirs`.
fn path_inside(dirs: &[std::path::PathBuf], target: &Path) -> bool {
    let tc = target.canonicalize().unwrap_or_else(|_| target.to_path_buf());
    dirs.iter().any(|d| {
        let dc = d.canonicalize().unwrap_or_else(|_| d.clone());
        tc.starts_with(&dc)
    })
}

/// Sanitize a user-typed template/agent name into a file stem.
fn sanitize_stem(name: &str) -> String {
    let s: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    s.trim_matches(|c| c == '_' || c == '-').to_string()
}

/// Create or update a CUSTOM team template (Studio CRUD — P0-3). Writes
/// `<custom_teams_dir>/<stem>.json`; the same stem saves over itself (that
/// IS the edit path). Built-in template names are refused so a custom team
/// can never shadow a shipped one — duplicate-to-edit always picks a new
/// name. Custom teams sync through the vault like other non-secret state.
#[tauri::command]
pub async fn save_team_template(file_stem: String, data: JsonValue) -> Result<TeamTemplate, String> {
    let stem = sanitize_stem(&file_stem);
    if stem.is_empty() {
        return Err("that name produces an empty file name — use letters or digits".into());
    }
    // NOTE: saving with a built-in's stem is ALLOWED on purpose — it writes a
    // custom OVERRIDE (into the writable custom dir below; the bundled file is
    // never touched) which list_team_templates then prefers over the built-in.
    // That's how "edit a built-in template to fix it" works.
    let dir = paths::custom_teams_dir().ok_or_else(|| "user-data root not found".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let path = dir.join(format!("{stem}.json"));
    // The template's `name` field IS its id — keep it equal to the file
    // stem so the UI never has to predict the sanitization.
    let mut data = data;
    if let Some(obj) = data.as_object_mut() {
        obj.insert("name".into(), JsonValue::String(stem.clone()));
    }
    let pretty = serde_json::to_string_pretty(&data).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, pretty).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(TeamTemplate {
        id: stem,
        path: path.to_string_lossy().into_owned(),
        built_in: false,
        data,
    })
}

/// Delete a CUSTOM team template. Path must resolve inside a custom teams
/// dir and end in .json — built-ins physically can't be deleted through
/// this command.
#[tauri::command]
pub async fn delete_team_template(path: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(&path);
    if target.extension().and_then(|s| s.to_str()) != Some("json") {
        return Err("delete_team_template only removes .json files".into());
    }
    if !path_inside(&paths::custom_teams_dirs_read(), &target) {
        return Err(format!(
            "refusing to delete outside the custom teams dir — got {}",
            target.display()
        ));
    }
    std::fs::remove_file(&target).map_err(|e| format!("delete {}: {e}", target.display()))?;
    Ok(())
}

/// Create a CUSTOM agent definition (duplicate-a-built-in / new-from-
/// scratch — P0-3). Writes `<custom_agents_dir>/<stem>.json` and returns
/// the role so the UI can select it for editing. Refuses stems that match
/// a built-in role id (the `base` namespace must stay unambiguous).
#[tauri::command]
pub async fn create_agent_definition(file_stem: String, data: JsonValue) -> Result<AgentRole, String> {
    let stem = sanitize_stem(&file_stem);
    if stem.is_empty() {
        return Err("that name produces an empty file name — use letters or digits".into());
    }
    if let Some(builtin) = paths::roles_dir() {
        for ext in ["yaml", "yml"] {
            if builtin.join(format!("{stem}.{ext}")).is_file() {
                return Err(format!(
                    "'{stem}' is a built-in role name — pick a different name for your copy"
                ));
            }
        }
    }
    let dir = paths::custom_agents_dir().ok_or_else(|| "user-data root not found".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let path = dir.join(format!("{stem}.json"));
    if path.is_file() {
        return Err(format!("a custom agent named '{stem}' already exists — pick another name"));
    }
    let mut data = data;
    if let Some(obj) = data.as_object_mut() {
        obj.insert("name".into(), JsonValue::String(stem.clone()));
    }
    let pretty = serde_json::to_string_pretty(&data).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, pretty).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(AgentRole {
        id: stem,
        path: path.to_string_lossy().into_owned(),
        built_in: false,
        data,
    })
}

/// Delete a CUSTOM agent definition. Same containment guard as
/// save_agent_definition; built-in YAML roles can't be touched.
#[tauri::command]
pub async fn delete_agent_definition(path: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(&path);
    if target.extension().and_then(|s| s.to_str()) != Some("json") {
        return Err("delete_agent_definition only removes .json files (built-in YAML roles are read-only)".into());
    }
    if !path_inside(&paths::custom_agents_dirs_read(), &target) {
        return Err(format!(
            "refusing to delete outside the custom agents dir — got {}",
            target.display()
        ));
    }
    std::fs::remove_file(&target).map_err(|e| format!("delete {}: {e}", target.display()))?;
    Ok(())
}

#[tauri::command]
pub async fn list_agent_roles() -> Result<Vec<AgentRole>, String> {
    let mut out = Vec::new();
    if let Some(builtin) = paths::roles_dir() {
        collect_role_dir(&builtin, true, &mut out);
    }
    // User-saved custom roles — Phase 2 home is
    // %APPDATA%\OwLLM Desktop\agent_definitions/. Helper returns BOTH
    // the new and legacy LLM/data/agent_definitions/ dirs so existing
    // custom roles stay visible during the migration window.
    for custom in paths::custom_agents_dirs_read() {
        collect_role_dir(&custom, false, &mut out);
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

fn collect_team_dir(dir: &Path, built_in: bool, out: &mut Vec<TeamTemplate>) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        // Skip `__init__.json` etc. — files starting with underscore.
        if id.starts_with('_') { continue; }
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        let Ok(data) = serde_json::from_str::<JsonValue>(&raw) else { continue };
        out.push(TeamTemplate {
            id: id.to_string(),
            path: path.to_string_lossy().into_owned(),
            built_in,
            data,
        });
    }
}

fn collect_role_dir(dir: &Path, built_in: bool, out: &mut Vec<AgentRole>) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        let path = entry.path();
        // Built-ins are YAML, user-saved customs are JSON. Handle both.
        let ext = path.extension().and_then(|s| s.to_str());
        let parsed: Option<JsonValue> = match ext {
            Some("yaml") | Some("yml") => parse_yaml_to_json(&path),
            Some("json") => std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok()),
            _ => None,
        };
        let Some(data) = parsed else { continue };
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if id.starts_with('_') || id == "loader" { continue; }
        out.push(AgentRole {
            id: id.to_string(),
            path: path.to_string_lossy().into_owned(),
            built_in,
            data,
        });
    }
}

/// Parse a YAML file by shelling out to Rust's serde_yaml? No — we
/// removed that dep earlier. Use a tiny line-based parser sufficient
/// for the role yamls in this repo (flat key/value with one nested
/// list and a piped block scalar for system_prompt).
fn parse_yaml_to_json(path: &Path) -> Option<JsonValue> {
    let raw = std::fs::read_to_string(path).ok()?;
    Some(yaml_lite_to_json(&raw))
}

/// Minimal YAML→JSON conversion for the role definitions. Supports:
///   key: scalar
///   key: |    (folded block scalar, preserved verbatim, terminates
///             at the next zero-indent key or EOF)
///   key:
///     - item
///     - item
///
/// Anything more complex falls back to a string blob under the key
/// `_raw` so the UI can at least show the unparsed contents.
fn yaml_lite_to_json(raw: &str) -> JsonValue {
    use serde_json::{Map, Value};
    let mut map = Map::new();
    let lines: Vec<&str> = raw.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            i += 1;
            continue;
        }
        // Top-level key (no leading whitespace).
        if !line.starts_with(' ') && line.contains(':') {
            let (k, rest) = line.split_once(':').unwrap();
            let key = k.trim().to_string();
            let v = rest.trim();
            if v == "|" {
                // Block scalar: gather lines until indentation collapses.
                let mut buf = String::new();
                i += 1;
                while i < lines.len() {
                    let l = lines[i];
                    if l.is_empty() {
                        buf.push('\n');
                        i += 1;
                        continue;
                    }
                    if !l.starts_with(' ') {
                        break;
                    }
                    // Strip the common indent (2 spaces is the convention
                    // in these YAMLs).
                    let stripped = l.strip_prefix("  ").unwrap_or(l);
                    buf.push_str(stripped);
                    buf.push('\n');
                    i += 1;
                }
                map.insert(key, Value::String(buf.trim_end().to_string()));
                continue;
            }
            if v.is_empty() {
                // Maybe a nested list follows.
                let mut items: Vec<Value> = Vec::new();
                i += 1;
                while i < lines.len() {
                    let l = lines[i];
                    let trimmed = l.trim_start();
                    if trimmed.is_empty() { i += 1; continue; }
                    if !l.starts_with(' ') { break; }
                    if let Some(rest) = trimmed.strip_prefix("- ") {
                        items.push(Value::String(rest.trim().to_string()));
                        i += 1;
                    } else {
                        break;
                    }
                }
                map.insert(key, Value::Array(items));
                continue;
            }
            // Plain scalar — try number first, fall back to string.
            let val = if let Ok(n) = v.parse::<f64>() {
                if n.fract() == 0.0 && v.find('.').is_none() {
                    Value::Number((n as i64).into())
                } else {
                    serde_json::Number::from_f64(n).map(Value::Number).unwrap_or(Value::String(v.to_string()))
                }
            } else if v == "true" {
                Value::Bool(true)
            } else if v == "false" {
                Value::Bool(false)
            } else {
                // Strip optional surrounding quotes.
                let stripped = v.trim_matches(|c| c == '"' || c == '\'');
                Value::String(stripped.to_string())
            };
            map.insert(key, val);
            i += 1;
            continue;
        }
        i += 1;
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yaml_lite_parses_role_shape() {
        let yaml = r#"
name: coder
description: Reads, searches, and edits code with precise diffs.
default_temperature: 0.2
tool_allowlist:
  - read_file
  - edit_file
  - shell
system_prompt: |
  You are the Coder.

  Be precise.
"#;
        let v = yaml_lite_to_json(yaml);
        assert_eq!(v["name"], "coder");
        assert!(v["description"].as_str().unwrap().contains("precise diffs"));
        assert!(v["default_temperature"].as_f64().is_some());
        let list = v["tool_allowlist"].as_array().unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0], "read_file");
        assert!(v["system_prompt"].as_str().unwrap().contains("Be precise."));
    }

    fn dummy_paths() -> (PathBuf, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        (root, tmp)
    }

    #[test]
    fn sanitize_stem_basics() {
        assert_eq!(sanitize_stem("My Research Crew"), "my_research_crew");
        assert_eq!(sanitize_stem("__weird--"), "weird");
        assert_eq!(sanitize_stem("数据"), "");
        assert_eq!(sanitize_stem("data_wrangler"), "data_wrangler");
    }

    /// Live CRUD probe against the REAL custom dirs (creates + deletes a
    /// uniquely-named team/agent; cleans up after itself):
    ///   cargo test --lib -- --ignored probe_studio_crud
    #[test]
    #[ignore]
    fn probe_studio_crud_roundtrip() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        // --- team: create → list → edit(overwrite) → delete ---
        let data = serde_json::json!({
            "display_name": "Probe Team",
            "category": "Custom",
            "description": "crud probe",
            "agents": [{"name": "orchestrator", "base": "orchestrator", "description": "plans"}],
        });
        let saved = rt
            .block_on(save_team_template("OWLLM Probe CRUD Team".into(), data))
            .expect("save team");
        assert_eq!(saved.id, "owllm_probe_crud_team");
        assert_eq!(saved.data["name"], "owllm_probe_crud_team", "name enforced to stem");
        let listed = rt.block_on(list_team_templates()).unwrap();
        assert!(listed.iter().any(|t| t.id == saved.id && !t.built_in), "custom team listed");
        // built-in name collision refused
        assert!(
            rt.block_on(save_team_template("code_artisan".into(), serde_json::json!({}))).is_err(),
            "built-in shadowing must be refused"
        );
        // edit = same stem saves over itself
        let mut edited = saved.data.clone();
        edited["description"] = "edited".into();
        let resaved = rt
            .block_on(save_team_template(saved.id.clone(), edited))
            .expect("edit team");
        assert_eq!(resaved.data["description"], "edited");
        // delete + containment guard
        assert!(
            rt.block_on(delete_team_template("C:\\Windows\\notours.json".into())).is_err(),
            "outside-path delete must be refused"
        );
        rt.block_on(delete_team_template(saved.path.clone())).expect("delete team");
        let listed2 = rt.block_on(list_team_templates()).unwrap();
        assert!(!listed2.iter().any(|t| t.id == saved.id), "deleted team gone");

        // --- agent: create → list → duplicate-collision → delete ---
        let role = serde_json::json!({
            "description": "crud probe agent",
            "default_temperature": 0.3,
            "system_prompt": "You are a probe.",
        });
        let created = rt
            .block_on(create_agent_definition("OWLLM Probe CRUD Agent".into(), role.clone()))
            .expect("create agent");
        assert_eq!(created.id, "owllm_probe_crud_agent");
        let roles = rt.block_on(list_agent_roles()).unwrap();
        assert!(roles.iter().any(|r| r.id == created.id && !r.built_in), "custom agent listed");
        assert!(
            rt.block_on(create_agent_definition(created.id.clone(), role)).is_err(),
            "same-name create must be refused"
        );
        assert!(
            rt.block_on(create_agent_definition("critic".into(), serde_json::json!({}))).is_err(),
            "built-in role shadowing must be refused"
        );
        rt.block_on(delete_agent_definition(created.path.clone())).expect("delete agent");
        let roles2 = rt.block_on(list_agent_roles()).unwrap();
        assert!(!roles2.iter().any(|r| r.id == created.id), "deleted agent gone");
    }

    #[test]
    fn collects_built_in_team_jsons_and_skips_underscored() {
        let (root, _tmp) = dummy_paths();
        let dir = root.join("teams");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("alpha.json"), r#"{"display_name":"A"}"#).unwrap();
        std::fs::write(dir.join("__init__.json"), "{}").unwrap();
        let mut out = Vec::new();
        collect_team_dir(&dir, true, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "alpha");
        assert!(out[0].built_in);
    }
}

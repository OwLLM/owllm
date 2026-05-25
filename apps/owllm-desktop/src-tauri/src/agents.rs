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
    let Some(root) = paths::llm_root() else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    // Built-in teams ship inside the source tree.
    let builtin = root.join("core").join("agents").join("teams");
    collect_team_dir(&builtin, true, &mut out);
    // User-saved teams (Studio's "+ New" / "Edit on builtin" writes here).
    let custom = root.join("data").join("teams");
    collect_team_dir(&custom, false, &mut out);
    // Stable order so the UI's category grouping is deterministic.
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[tauri::command]
pub async fn list_skill_packs() -> Result<Vec<SkillPack>, String> {
    let Some(root) = paths::llm_root() else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    let skills_root = root.join("data").join("skills");
    let Ok(read) = std::fs::read_dir(&skills_root) else { return Ok(Vec::new()) };
    for entry in read.flatten() {
        let dir = entry.path();
        if !dir.is_dir() { continue; }
        // The shallow clone of upstream repos lives under
        // data/skills/_remote/ — skip that container since the
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
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
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
    let Some(root) = paths::llm_root() else { return Err("LLM root not found".into()) };
    let custom_dir = root.join("data").join("agent_definitions");
    let target = std::path::PathBuf::from(&path);
    let target_canon = target.canonicalize().unwrap_or(target.clone());
    let custom_canon = custom_dir.canonicalize().unwrap_or(custom_dir.clone());
    if !target_canon.starts_with(&custom_canon) {
        return Err(format!(
            "refusing to save outside LLM/data/agent_definitions/ — got {}",
            target.display(),
        ));
    }
    if target.extension().and_then(|s| s.to_str()) != Some("json") {
        return Err("save_agent_definition only writes .json files (built-in YAML roles are read-only)".into());
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

#[tauri::command]
pub async fn list_agent_roles() -> Result<Vec<AgentRole>, String> {
    let Some(root) = paths::llm_root() else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    let builtin = root.join("core").join("agents").join("roles");
    collect_role_dir(&builtin, true, &mut out);
    let custom = root.join("data").join("agent_definitions");
    collect_role_dir(&custom, false, &mut out);
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

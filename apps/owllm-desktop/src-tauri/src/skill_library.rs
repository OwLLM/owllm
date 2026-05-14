// Skill Library — browse, fetch, and install community SKILL.md packs
// from curated git sources. Ports LLM/core/agents/skill_sources.py.
//
// Layout:
//   LLM/data/skills/_remote/<source_key>/...   shallow clones
//   LLM/data/skills/<source_key>__<folder>/    installed skills
//
// Tauri commands exposed:
//   list_skill_sources()                 -> Vec<SkillSource>
//   fetch_skill_source(key, force)       -> { local_path }
//   discover_skills(key)                 -> Vec<DiscoveredSkill>
//   install_skill(key, relative_dir)     -> { installed_folder }
//   uninstall_skill(folder_name)         -> bool
//   list_installed_skill_folders()       -> Vec<String>

use crate::paths;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Clone)]
pub struct SkillSource {
    /// Stable id used as the on-disk folder name (e.g. "anthropics").
    pub key: String,
    /// Human-readable name shown in the picker.
    pub label: String,
    /// Where to git-clone from.
    pub git_url: String,
    /// One-liner description.
    pub description: String,
    /// Optional subdir inside the clone where SKILL.md files start.
    pub skills_subpath: String,
}

/// Curated initial set. Mirrors `KNOWN_SOURCES` in skill_sources.py.
fn known_sources() -> Vec<SkillSource> {
    vec![
        SkillSource {
            key: "anthropics".into(),
            label: "Anthropic — official skills".into(),
            git_url: "https://github.com/anthropics/skills.git".into(),
            description: "Anthropic's reference SKILL.md collection (PDF, Excel, Word, PowerPoint helpers). MIT licensed, drop-in compatible.".into(),
            skills_subpath: String::new(),
        },
        SkillSource {
            key: "superpowers".into(),
            label: "obra/superpowers — community skills".into(),
            git_url: "https://github.com/obra/superpowers.git".into(),
            description: "Curated community SKILL.md collection — engineering, research, and writing helpers.".into(),
            skills_subpath: String::new(),
        },
    ]
}

#[tauri::command]
pub async fn list_skill_sources() -> Result<Vec<SkillSource>, String> {
    Ok(known_sources())
}

fn remote_root() -> Option<PathBuf> {
    Some(paths::llm_root()?.join("data").join("skills").join("_remote"))
}

fn installed_root() -> Option<PathBuf> {
    Some(paths::llm_root()?.join("data").join("skills"))
}

fn resolve_source_or_custom(key: &str, git_url: Option<&str>) -> Result<SkillSource, String> {
    if let Some(s) = known_sources().into_iter().find(|s| s.key == key) {
        return Ok(s);
    }
    // Custom URL — caller passes both key + git_url. Key is used as the
    // local folder name; allow alphanumerics + dash/underscore only.
    let g = git_url.ok_or_else(|| format!("unknown source '{key}' (no git_url)"))?;
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        || key.is_empty()
    {
        return Err("custom source key must be ascii alphanumerics + _ / -".into());
    }
    Ok(SkillSource {
        key: key.to_string(),
        label: format!("Custom: {g}"),
        git_url: g.to_string(),
        description: String::new(),
        skills_subpath: String::new(),
    })
}

#[derive(Serialize)]
pub struct FetchResult {
    pub local_path: String,
}

/// Shallow-clone (or refresh) a known/custom source. Returns the local
/// clone directory. `force=true` wipes and re-clones.
#[tauri::command]
pub async fn fetch_skill_source(
    key: String,
    git_url: Option<String>,
    force: bool,
) -> Result<FetchResult, String> {
    let source = resolve_source_or_custom(&key, git_url.as_deref())?;
    let root = remote_root().ok_or("LLM/ tree not found")?;
    std::fs::create_dir_all(&root).map_err(|e| format!("mkdir {}: {e}", root.display()))?;
    let target = root.join(&source.key);

    // git on PATH — best-effort. The Python original surfaces a friendly
    // message; we do the same so the user knows what to install.
    let git_exe = which_git().ok_or_else(|| {
        "Git is not installed or not on PATH. Install Git to add skill libraries from the internet.".to_string()
    })?;

    let key_clone = source.key.clone();
    let url = source.git_url.clone();
    let target2 = target.clone();
    tokio::task::spawn_blocking(move || run_git(&git_exe, &url, &target2, force))
        .await
        .map_err(|e| format!("join error: {e}"))??;

    Ok(FetchResult {
        local_path: remote_root().unwrap().join(key_clone).to_string_lossy().into_owned(),
    })
}

fn which_git() -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        let candidate = dir.join("git.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
        let candidate2 = dir.join("git");
        if candidate2.is_file() {
            return Some(candidate2);
        }
    }
    None
}

fn run_git(git_exe: &Path, url: &str, target: &Path, force: bool) -> Result<(), String> {
    if target.exists() && !force {
        // Best-effort fast-forward refresh. Ignore failures — an offline
        // user can still browse what was cloned previously.
        let mut cmd = Command::new(git_exe);
        cmd.args([
            "-C",
            target.to_str().unwrap_or(""),
            "pull",
            "--ff-only",
            "--quiet",
        ]);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.output();
        return Ok(());
    }
    if target.exists() && force {
        std::fs::remove_dir_all(target).map_err(|e| format!("rmtree {}: {e}", target.display()))?;
    }
    let mut cmd = Command::new(git_exe);
    cmd.args(["clone", "--depth", "1", url, target.to_str().unwrap_or("")]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        return Err(format!(
            "Could not clone {url}: {}",
            stderr.trim().to_string()
        ));
    }
    Ok(())
}

#[derive(Serialize, Clone)]
pub struct DiscoveredSkill {
    pub source_key: String,
    pub relative_dir: String,
    pub name: String,
    pub description: String,
    /// Absolute path to the SKILL.md, so the UI can preview it.
    pub skill_md_path: String,
    /// Whether a matching installed folder (source_key__<basename>)
    /// already exists under LLM/data/skills/.
    pub installed: bool,
}

#[tauri::command]
pub async fn discover_skills(key: String) -> Result<Vec<DiscoveredSkill>, String> {
    let root = remote_root().ok_or("LLM/ tree not found")?;
    let src_root = root.join(&key);
    if !src_root.exists() {
        return Ok(Vec::new());
    }
    let inst = installed_root().ok_or("LLM/ tree not found")?;
    let installed_set: std::collections::HashSet<String> = std::fs::read_dir(&inst)
        .map(|r| {
            r.flatten()
                .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let key_clone = key.clone();
    tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        walk_for_skill_md(&src_root, &src_root, &key_clone, &installed_set, &mut out);
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(out)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn walk_for_skill_md(
    cur: &Path,
    src_root: &Path,
    source_key: &str,
    installed: &std::collections::HashSet<String>,
    out: &mut Vec<DiscoveredSkill>,
) {
    let Ok(read) = std::fs::read_dir(cur) else { return };
    for entry in read.flatten() {
        let path = entry.path();
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if file_name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            walk_for_skill_md(&path, src_root, source_key, installed, out);
            continue;
        }
        if file_name != "SKILL.md" {
            continue;
        }
        let text = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let (name, description) = peek_frontmatter(&text);
        let parent = path.parent().unwrap_or(src_root);
        let rel = parent.strip_prefix(src_root).unwrap_or(parent);
        let rel_str = rel.to_string_lossy().into_owned();
        let folder_name = format!(
            "{}__{}",
            source_key,
            parent.file_name().and_then(|n| n.to_str()).unwrap_or("")
        );
        let final_name = if name.is_empty() {
            parent
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string()
        } else {
            name
        };
        out.push(DiscoveredSkill {
            source_key: source_key.to_string(),
            relative_dir: rel_str.replace('\\', "/"),
            name: final_name,
            description,
            skill_md_path: path.to_string_lossy().into_owned(),
            installed: installed.contains(&folder_name),
        });
    }
}

fn peek_frontmatter(text: &str) -> (String, String) {
    let trimmed = text.trim_start_matches('\u{feff}');
    if !trimmed.starts_with("---") {
        return (String::new(), String::new());
    }
    let rest = &trimmed[3..];
    let Some(end_idx) = rest.find("\n---") else {
        return (String::new(), String::new());
    };
    let fm = &rest[..end_idx];
    let mut name = String::new();
    let mut desc = String::new();
    for raw in fm.lines() {
        let line = raw.trim();
        if name.is_empty() {
            if let Some(v) = line.strip_prefix("name:") {
                name = v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
            }
        }
        if desc.is_empty() {
            if let Some(v) = line.strip_prefix("description:") {
                desc = v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
            }
        }
    }
    (name, desc)
}

#[derive(Serialize)]
pub struct InstallResult {
    pub installed_folder: String,
}

/// Install a discovered skill — copies the directory into
/// LLM/data/skills/<source>__<folder>/ and rewrites Anthropic-style
/// tool names in the SKILL.md frontmatter.
#[tauri::command]
pub async fn install_skill(
    source_key: String,
    relative_dir: String,
) -> Result<InstallResult, String> {
    let src = remote_root()
        .ok_or("LLM/ tree not found")?
        .join(&source_key)
        .join(&relative_dir);
    if !src.is_dir() {
        return Err(format!("source dir not found: {}", src.display()));
    }
    let folder_name = format!(
        "{}__{}",
        source_key,
        src.file_name().and_then(|n| n.to_str()).unwrap_or("")
    );
    let dest = installed_root()
        .ok_or("LLM/ tree not found")?
        .join(&folder_name);

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        if dest.exists() {
            std::fs::remove_dir_all(&dest)
                .map_err(|e| format!("rmtree {}: {e}", dest.display()))?;
        }
        copy_dir_recursive(&src, &dest)?;
        // Rewrite SKILL.md tools: list with Anthropic→OWLLM aliases.
        let dest_md = dest.join("SKILL.md");
        if dest_md.is_file() {
            if let Ok(text) = std::fs::read_to_string(&dest_md) {
                let rewritten = rewrite_tool_aliases(&text);
                if rewritten != text {
                    let _ = std::fs::write(&dest_md, rewritten);
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("join error: {e}"))??;

    Ok(InstallResult { installed_folder: folder_name })
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
    let read = std::fs::read_dir(src).map_err(|e| format!("read {}: {e}", src.display()))?;
    for entry in read.flatten() {
        let from = entry.path();
        let name = match from.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        let to = dst.join(name);
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if from.is_file() {
            std::fs::copy(&from, &to)
                .map_err(|e| format!("copy {} → {}: {e}", from.display(), to.display()))?;
        }
    }
    Ok(())
}

/// Rewrite Anthropic CamelCase tool names in the SKILL.md frontmatter
/// `tools:` list to OWLLM snake_case ids. Anything not in the alias map
/// passes through (lowercased) so the runtime can either match a
/// builtin or skip it silently.
fn rewrite_tool_aliases(text: &str) -> String {
    if !text.starts_with("---") {
        return text.to_string();
    }
    let rest = &text[3..];
    let Some(end_idx) = rest.find("\n---") else {
        return text.to_string();
    };
    let fm = &rest[..end_idx];
    let body = &rest[end_idx..];
    let mut out_fm = String::new();
    let mut in_tools = false;
    for raw in fm.lines() {
        let trimmed = raw.trim_start();
        let indent_len = raw.len() - trimmed.len();
        if trimmed.starts_with("tools:") {
            in_tools = true;
            out_fm.push_str(raw);
            out_fm.push('\n');
            continue;
        }
        if in_tools {
            // List items at deeper indent than the `tools:` line.
            if let Some(item) = trimmed.strip_prefix("- ") {
                let mapped = alias_tool_name(item.trim());
                out_fm.push_str(&" ".repeat(indent_len));
                out_fm.push_str("- ");
                out_fm.push_str(&mapped);
                out_fm.push('\n');
                continue;
            }
            // Indented continuation but not a list item, or back to flush
            // — leave tools: block on first non-list non-blank line.
            if !trimmed.is_empty() && indent_len == 0 {
                in_tools = false;
            }
        }
        out_fm.push_str(raw);
        out_fm.push('\n');
    }
    let mut out = String::with_capacity(text.len());
    out.push_str("---");
    out.push_str(&out_fm);
    out.push_str(body);
    out
}

fn alias_tool_name(name: &str) -> String {
    let n = name.trim();
    match n {
        "Read" => "read_file".into(),
        "Write" => "write_file_with_diff".into(),
        "Edit" | "MultiEdit" => "edit_file".into(),
        "Bash" | "PowerShell" => "shell".into(),
        "LS" => "list_dir".into(),
        "Glob" => "glob_files".into(),
        "Grep" => "grep".into(),
        "WebFetch" | "WebSearch" => "http_get".into(),
        "TodoWrite" => "todo_write".into(),
        _ => {
            if n.chars().all(|c| c.is_ascii_lowercase() || c == '_' || c.is_ascii_digit())
                || n.contains('_')
            {
                n.to_string()
            } else {
                n.to_lowercase()
            }
        }
    }
}

#[tauri::command]
pub async fn uninstall_skill(folder_name: String) -> Result<bool, String> {
    if !folder_name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("folder name must be alphanumerics + _ / -".into());
    }
    let dest = installed_root().ok_or("LLM/ tree not found")?.join(&folder_name);
    if !dest.is_dir() {
        return Ok(false);
    }
    tokio::task::spawn_blocking(move || {
        std::fs::remove_dir_all(&dest)
            .map_err(|e| format!("rmtree {}: {e}", dest.display()))
    })
    .await
    .map_err(|e| format!("join error: {e}"))??;
    Ok(true)
}

#[tauri::command]
pub async fn list_installed_skill_folders() -> Result<Vec<String>, String> {
    let inst = installed_root().ok_or("LLM/ tree not found")?;
    let Ok(read) = std::fs::read_dir(&inst) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<String> = read
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            if name == "_remote" || name.starts_with('.') {
                return None;
            }
            if e.path().is_dir() {
                Some(name)
            } else {
                None
            }
        })
        .collect();
    out.sort();
    Ok(out)
}

#[tauri::command]
pub async fn read_skill_md(path: String) -> Result<String, String> {
    // Whitelist: must be under the LLM/data/skills/_remote/ tree.
    let root = remote_root().ok_or("LLM/ tree not found")?;
    let p = PathBuf::from(&path);
    let canon = p
        .canonicalize()
        .map_err(|e| format!("canonicalize {}: {e}", p.display()))?;
    let canon_root = root
        .canonicalize()
        .map_err(|e| format!("canonicalize {}: {e}", root.display()))?;
    if !canon.starts_with(&canon_root) {
        return Err("path escapes the skills remote root".into());
    }
    std::fs::read_to_string(&canon).map_err(|e| format!("read {}: {e}", canon.display()))
}

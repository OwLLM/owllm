// First-launch bootstrap helpers.
//
// Phase 2 of the restructure moved user-mutable state out of
// LLM/data/ into the OS-canonical %APPDATA%/~Library/Application
// Support/... directory under "OwLLM Desktop". For existing installs
// we need a one-time copy so the user doesn't lose:
//   * owllm_state.db        (projects, chats, directives, settings)
//   * agent_definitions/    (custom Studio agent JSONs)
//   * teams/                (custom Studio team templates)
//   * skills/               (installed SKILL.md packs)
//   * gpu_config.json       (GPU selection)
//
// Migration runs on app boot (lib.rs setup hook). It's gated by a
// sentinel file in the new user-data root, so it only fires once per
// install. Any failure logs a warning but doesn't abort startup — the
// legacy fallbacks in paths.rs keep the app functional.

use std::path::Path;

/// Run the one-time copy if (a) the new user-data root exists, (b) the
/// sentinel file is missing, and (c) the legacy LLM/data/ tree exists.
/// Safe to call on every launch; only the first call does real work.
pub fn migrate_user_state_if_needed() {
    let Some(new_root) = crate::paths::user_data_root() else {
        eprintln!("[bootstrap] user_data_root unavailable, skipping migration");
        return;
    };
    let Some(sentinel) = crate::paths::migration_sentinel_path() else {
        return;
    };
    if sentinel.is_file() {
        return; // already migrated
    }
    let Some(legacy_root) = crate::paths::legacy_user_data_root() else {
        // No legacy LLM/data/ to migrate — write the sentinel anyway so
        // we don't repeat this check forever.
        let _ = write_sentinel(&sentinel, "no legacy LLM/data/ tree found");
        return;
    };
    // Files to copy (single SQLite blob) + directories to mirror.
    let mut copied: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();

    let db_src = legacy_root.join("owllm_state.db");
    let db_dst = new_root.join("owllm_state.db");
    if db_src.is_file() && !db_dst.exists() {
        match std::fs::copy(&db_src, &db_dst) {
            Ok(_) => copied.push("owllm_state.db".into()),
            Err(e) => failed.push(format!("owllm_state.db: {e}")),
        }
    }
    // Also copy the SQLite -wal / -shm sidecars if present so we don't
    // lose any pending writes the legacy app left behind.
    for ext in ["owllm_state.db-wal", "owllm_state.db-shm"] {
        let s = legacy_root.join(ext);
        let d = new_root.join(ext);
        if s.is_file() && !d.exists() {
            let _ = std::fs::copy(&s, &d);
        }
    }

    for sub in ["agent_definitions", "teams", "skills"] {
        let s = legacy_root.join(sub);
        let d = new_root.join(sub);
        if !s.is_dir() { continue; }
        if d.exists() { continue; } // user already has something there — don't merge over it
        match copy_dir_recursive(&s, &d) {
            Ok(n) => copied.push(format!("{sub}/ ({n} files)")),
            Err(e) => failed.push(format!("{sub}/: {e}")),
        }
    }

    // gpu_config.json may live at LLM/data/gpu_config.json (Phase 4
    // intermediate) OR at LLM/desktop_app/config/gpu_config.json (the
    // original PySide6 spot). Try both, take the newer one.
    if !new_root.join("gpu_config.json").exists() {
        let candidates = [
            legacy_root.join("gpu_config.json"),
            crate::paths::llm_root()
                .map(|r| r.join("desktop_app").join("config").join("gpu_config.json"))
                .unwrap_or_default(),
        ];
        let mut best: Option<(std::time::SystemTime, &Path)> = None;
        for c in candidates.iter() {
            if let Ok(meta) = std::fs::metadata(c) {
                if let Ok(mt) = meta.modified() {
                    if best.map(|(t, _)| mt > t).unwrap_or(true) {
                        best = Some((mt, c.as_path()));
                    }
                }
            }
        }
        if let Some((_, src)) = best {
            match std::fs::copy(src, new_root.join("gpu_config.json")) {
                Ok(_) => copied.push("gpu_config.json".into()),
                Err(e) => failed.push(format!("gpu_config.json: {e}")),
            }
        }
    }

    let summary = format!(
        "migrated {} item(s){}{}",
        copied.len(),
        if copied.is_empty() { "" } else { ": " },
        copied.join(", "),
    );
    if !failed.is_empty() {
        eprintln!("[bootstrap] migration finished with {} failure(s): {}",
            failed.len(), failed.join(" | "));
    } else {
        eprintln!("[bootstrap] {summary}");
    }
    let _ = write_sentinel(&sentinel, &summary);
}

/// One built-in skill pack embedded in the binary. `(dir_name, SKILL.md)`.
/// Seeded into the user skills dir so it's listed by `list_skill_packs`,
/// editable in Studio, and equippable — exactly like a downloaded pack.
const BUILTIN_SKILLS: &[(&str, &str)] = &[
    (
        "owllm__parallel-dispatch",
        include_str!("../seed/owllm__parallel-dispatch.SKILL.md"),
    ),
];

/// Write OWLLM's built-in skill packs into the user skills dir if they're not
/// already there. Idempotent and NON-destructive: an existing SKILL.md (possibly
/// user-edited) is left untouched, so we never clobber a customization.
pub fn seed_builtin_skills() {
    let Some(skills_root) = crate::paths::skills_dir() else {
        eprintln!("[bootstrap] skills_dir unavailable, skipping built-in skill seed");
        return;
    };
    for (dir_name, contents) in BUILTIN_SKILLS {
        let dir = skills_root.join(dir_name);
        let md = dir.join("SKILL.md");
        if md.exists() {
            continue; // user already has it (maybe edited) — don't overwrite
        }
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("[bootstrap] seed skill {dir_name}: mkdir failed: {e}");
            continue;
        }
        match std::fs::write(&md, contents) {
            Ok(_) => eprintln!("[bootstrap] seeded built-in skill {dir_name}"),
            Err(e) => eprintln!("[bootstrap] seed skill {dir_name}: write failed: {e}"),
        }
    }
}

fn write_sentinel(path: &Path, summary: &str) -> std::io::Result<()> {
    let body = format!(
        "OwLLM Desktop user-state migration ran at {}.\n{summary}\n",
        chrono_now_simple(),
    );
    std::fs::write(path, body)
}

// Avoid pulling chrono just for this. RFC3339-ish wall-clock.
fn chrono_now_simple() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Same iso_from_epoch shape projects.rs uses; inlined to avoid the
    // private-fn import.
    let days = (secs / 86_400) as i64;
    let s_in_day = secs % 86_400;
    let h = s_in_day / 3600;
    let m = (s_in_day % 3600) / 60;
    let s = s_in_day % 60;
    // Calendar conversion. Same algorithm as Python's datetime.fromtimestamp.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m_n = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = y + if m_n <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m_n, d, h, m, s)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<usize> {
    std::fs::create_dir_all(dst)?;
    let mut count = 0;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            count += copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
            count += 1;
        }
    }
    Ok(count)
}

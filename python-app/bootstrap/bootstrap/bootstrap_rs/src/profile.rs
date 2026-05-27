//! Hardware profile table loader. Mirrors `bootstrap_go/exec/profile.go`.
//!
//! Profiles are cold-start "happy path" install recipes consulted
//! before asking the LLM brain — when the model emits a single
//! `pick_profile` step instead of enumerating create_venv +
//! install_pkg + … the executor expands it inline by walking the
//! profile's `steps`.
//!
//! Authoring lives in `LLM/bootstrap/recipes/hardware_profiles.json`.
//! See `LLM/docs/supervisor/BOOTSTRAP.md` for the field semantics.

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::fs;
use std::path::Path;

use crate::plan::Step;

#[derive(Debug, Clone, Deserialize)]
pub struct ProfileSpec {
    pub id: String,
    #[serde(default)]
    pub description: String,
    /// Hardware match constraints (e.g. `{"gpu.0.vendor": "nvidia"}`).
    /// Kept as raw JSON for now — Phase R5's hardware probe will be
    /// the consumer; the executor doesn't interpret these.
    #[serde(default = "default_match")]
    #[allow(dead_code)]
    pub r#match: Value,
    pub steps: Vec<Step>,
}

fn default_match() -> Value {
    Value::Object(serde_json::Map::new())
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ProfileTable {
    #[serde(default)]
    pub version: i64,
    #[serde(default)]
    pub profiles: Vec<ProfileSpec>,
}

impl ProfileTable {
    /// Look up a profile by id.
    pub fn find_profile(&self, id: &str) -> Option<&ProfileSpec> {
        self.profiles.iter().find(|p| p.id == id)
    }
}

/// Read `<boot_dir>/recipes/hardware_profiles.json`. Returns an empty
/// table (no profiles) when the file is missing — that's not an
/// error; the model can still emit ad-hoc steps. Returns `Err` if the
/// file exists but doesn't parse, so a typo in the recipe file is
/// surfaced loudly.
pub fn load_profile_table(boot_dir: &Path) -> Result<ProfileTable> {
    let path = boot_dir.join("recipes").join("hardware_profiles.json");
    let data = match fs::read(&path) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProfileTable::default());
        }
        Err(e) => return Err(anyhow::anyhow!("load profiles: {}: {}", path.display(), e)),
    };
    let table: ProfileTable =
        serde_json::from_slice(&data).context("parse profiles")?;
    Ok(table)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const SAMPLE: &str = r#"{
        "version": 1,
        "profiles": [
            {
                "id": "cuda121-torch25",
                "description": "NVIDIA Ampere/Ada/Hopper",
                "match": {"gpu.0.vendor": "nvidia"},
                "steps": [
                    {"action": "create_venv", "args": {"python_version": "3.11"}},
                    {"action": "install_pkg", "args": {"name": "torch==2.5.1+cu121"}}
                ]
            },
            {
                "id": "cpu-only",
                "description": "fallback",
                "match": {"gpu.0.vendor": "none"},
                "steps": [
                    {"action": "create_venv", "args": {"python_version": "3.11"}}
                ]
            }
        ]
    }"#;

    fn write_profiles(boot_dir: &Path, body: &str) {
        let recipes = boot_dir.join("recipes");
        fs::create_dir_all(&recipes).unwrap();
        fs::write(recipes.join("hardware_profiles.json"), body).unwrap();
    }

    #[test]
    fn parses_sample_table() {
        let tmp = tempdir().unwrap();
        write_profiles(tmp.path(), SAMPLE);
        let tbl = load_profile_table(tmp.path()).expect("loads");
        assert_eq!(tbl.version, 1);
        assert_eq!(tbl.profiles.len(), 2);
        assert_eq!(tbl.profiles[0].id, "cuda121-torch25");
        assert_eq!(tbl.profiles[0].steps.len(), 2);
        assert_eq!(tbl.profiles[1].id, "cpu-only");
    }

    #[test]
    fn missing_file_returns_empty_table() {
        let tmp = tempdir().unwrap();
        let tbl = load_profile_table(tmp.path()).expect("not an error");
        assert_eq!(tbl.profiles.len(), 0);
    }

    #[test]
    fn malformed_file_errors() {
        let tmp = tempdir().unwrap();
        write_profiles(tmp.path(), "{ not json");
        assert!(load_profile_table(tmp.path()).is_err());
    }

    #[test]
    fn find_profile_hits_and_misses() {
        let tbl: ProfileTable = serde_json::from_str(SAMPLE).unwrap();
        assert!(tbl.find_profile("cpu-only").is_some());
        assert_eq!(tbl.find_profile("cpu-only").unwrap().id, "cpu-only");
        assert!(tbl.find_profile("does-not-exist").is_none());
    }
}

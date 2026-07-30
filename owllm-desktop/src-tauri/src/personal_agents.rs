//! Persistent personal-agent profiles and reusable rule cards.
//!
//! Documents are append-only by revision and are stored in encrypted,
//! per-scope envelopes below `<user_data>/personal-agents/`.  AES-GCM always
//! encrypts the document payload.  The random data key is additionally wrapped
//! by `crypt::protect` (DPAPI on Windows).  On macOS/Linux `crypt::protect`
//! currently has no keychain backend, so the random key is permission-locked
//! to the current user; documents are still never persisted as plaintext.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

const SCHEMA_VERSION: u32 = 1;
const STORE_SCHEMA_VERSION: u32 = 2;
const EXPORT_SCHEMA_VERSION: u32 = 2;
const AAD: &[u8] = b"owllm-personal-agents-v1";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentIdentity {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentModel {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DelegationPolicy {
    pub enabled: bool,
    #[serde(default)]
    pub allowed_profile_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RevisionRef {
    pub id: String,
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileDoc {
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub display_name: String,
    pub identity: AgentIdentity,
    pub role: String,
    pub system_instructions: String,
    #[serde(default)]
    pub model: AgentModel,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    pub memory_scope: String,
    pub delegation: DelegationPolicy,
    #[serde(default)]
    pub skill_ids: Vec<String>,
    #[serde(default)]
    pub personal_skill_refs: Vec<RevisionRef>,
    #[serde(default)]
    pub rule_card_refs: Vec<RevisionRef>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuleCondition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuleCardDoc {
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub kind: String,
    pub title: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<RuleCondition>,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub private: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillPermissionBoundary {
    #[serde(default)]
    pub allowed_tools: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersonalSkillDoc {
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub name: String,
    pub purpose: String,
    pub instructions: String,
    #[serde(default)]
    pub required_tools: Vec<String>,
    pub input_contract: String,
    pub output_contract: String,
    #[serde(default)]
    pub permission_boundary: SkillPermissionBoundary,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub private: bool,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillValidationResult {
    pub valid: bool,
    #[serde(default)]
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DelegationOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_profile_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<AgentModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation: Option<DelegationOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personal_skill_refs: Option<Vec<RevisionRef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_card_refs: Option<Vec<RevisionRef>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAgentConfigDoc {
    pub schema_version: u32,
    pub project_id: String,
    pub revision: u64,
    #[serde(default)]
    pub profile_refs: Vec<RevisionRef>,
    #[serde(default)]
    pub rule_card_refs: Vec<RevisionRef>,
    #[serde(default)]
    pub profile_overrides: BTreeMap<String, AgentProfileOverride>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceEntry {
    pub source: String,
    pub document_id: String,
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveAgentConfig {
    #[serde(flatten)]
    pub profile: AgentProfileDoc,
    pub provenance: BTreeMap<String, ProvenanceEntry>,
    pub attached_rules: Vec<RuleCardDoc>,
    #[serde(default)]
    pub attached_skills: Vec<PersonalSkillDoc>,
    pub validation_errors: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub profiles: usize,
    pub rule_cards: usize,
    #[serde(default)]
    pub skills: usize,
    pub project_configs: usize,
    #[serde(default)]
    pub validation_errors: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopeStore {
    #[serde(default = "store_schema_version")]
    schema_version: u32,
    #[serde(default)]
    profiles: Vec<AgentProfileDoc>,
    #[serde(default)]
    rule_cards: Vec<RuleCardDoc>,
    #[serde(default)]
    skills: Vec<PersonalSkillDoc>,
    #[serde(default)]
    project_configs: Vec<ProjectAgentConfigDoc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CipherEnvelope {
    schema_version: u32,
    nonce: String,
    ciphertext: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportBundle {
    #[serde(default = "schema_one")]
    schema_version: u32,
    #[serde(default)]
    profiles: Vec<AgentProfileDoc>,
    #[serde(default)]
    rule_cards: Vec<RuleCardDoc>,
    #[serde(default, rename = "personalSkills", alias = "skills")]
    skills: Vec<PersonalSkillDoc>,
    #[serde(default)]
    project_configs: Vec<ProjectAgentConfigDoc>,
}

#[derive(Clone)]
pub(crate) struct PersonalAgentSnapshotMaterial {
    pub profiles: Vec<AgentProfileDoc>,
    pub rules: Vec<RuleCardDoc>,
    pub skills: Vec<PersonalSkillDoc>,
    pub project_config: ProjectAgentConfigDoc,
}

fn schema_one() -> u32 {
    SCHEMA_VERSION
}

fn store_schema_version() -> u32 {
    STORE_SCHEMA_VERSION
}

#[derive(Clone)]
struct Repository {
    root: PathBuf,
}

impl Repository {
    fn production() -> Result<Self, String> {
        let root = crate::paths::user_data_root()
            .ok_or_else(|| "personal agents: user-data directory unavailable".to_string())?
            .join("personal-agents");
        Ok(Self { root })
    }

    fn global_path(&self) -> PathBuf {
        self.root.join("global").join("store.enc")
    }

    fn project_dir(&self, project_id: &str) -> PathBuf {
        let digest = Sha256::digest(project_id.as_bytes());
        self.root.join("projects").join(hex_bytes(&digest))
    }

    fn project_path(&self, project_id: &str) -> PathBuf {
        self.project_dir(project_id).join("store.enc")
    }

    fn key_path(&self) -> PathBuf {
        self.root.join("data-key.bin")
    }

    fn lock(&self) -> Result<LockGuard, String> {
        fs::create_dir_all(&self.root).map_err(|e| format!("create personal-agent root: {e}"))?;
        LockGuard::acquire(self.root.join(".write.lock"))
    }

    fn data_key(&self) -> Result<[u8; 32], String> {
        let path = self.key_path();
        if let Ok(wrapped) = fs::read(&path) {
            let raw = crate::crypt::unprotect(&wrapped)?;
            return raw
                .as_slice()
                .try_into()
                .map_err(|_| "personal agents: invalid encrypted data-key length".to_string());
        }
        fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let mut raw = [0u8; 32];
        OsRng.fill_bytes(&mut raw);
        let wrapped = crate::crypt::protect(&raw)?;
        atomic_write(&path, &wrapped, false)?;
        restrict_owner_only(&path)?;
        Ok(raw)
    }

    fn load_scope(&self, path: &Path) -> Result<ScopeStore, String> {
        if !path.exists() {
            return Ok(ScopeStore {
                schema_version: STORE_SCHEMA_VERSION,
                ..ScopeStore::default()
            });
        }
        let key = self.data_key()?;
        match read_encrypted(path, &key) {
            Ok(v) => migrate_scope(v),
            Err(primary) => {
                let bak = backup_path(path);
                read_encrypted(&bak, &key)
                    .and_then(migrate_scope)
                    .map_err(|backup| {
                        format!(
                            "personal agents: corrupt primary ({primary}); backup recovery failed ({backup})"
                        )
                    })
            }
        }
    }

    fn save_scope(&self, path: &Path, value: &ScopeStore) -> Result<(), String> {
        let bytes = self.encode_scope(value)?;
        atomic_write(path, &bytes, true)?;
        restrict_owner_only(path)
    }

    fn encode_scope(&self, value: &ScopeStore) -> Result<Vec<u8>, String> {
        let key = self.data_key()?;
        let plain = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let encrypted = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                aes_gcm::aead::Payload {
                    msg: &plain,
                    aad: AAD,
                },
            )
            .map_err(|_| "personal agents: AES-GCM encryption failed".to_string())?;
        let env = CipherEnvelope {
            schema_version: STORE_SCHEMA_VERSION,
            nonce: B64.encode(nonce),
            ciphertext: B64.encode(encrypted),
        };
        serde_json::to_vec(&env).map_err(|e| e.to_string())
    }

    fn save_scopes_transaction(&self, scopes: &[(PathBuf, ScopeStore)]) -> Result<(), String> {
        let mut prepared = Vec::with_capacity(scopes.len());
        for (path, store) in scopes {
            prepared.push((path.clone(), self.encode_scope(store)?, fs::read(path).ok()));
        }

        let mut replaced: Vec<usize> = Vec::new();
        for (path, bytes, _) in &prepared {
            if let Err(error) =
                atomic_write(path, bytes, true).and_then(|_| restrict_owner_only(path))
            {
                let mut rollback_errors = Vec::new();
                for index in replaced.into_iter().rev() {
                    let (prior_path, _, prior_bytes) = &prepared[index];
                    let rollback = match prior_bytes {
                        Some(bytes) => atomic_write(prior_path, bytes, false)
                            .and_then(|_| restrict_owner_only(prior_path)),
                        None => {
                            if prior_path.exists() {
                                fs::remove_file(prior_path)
                                    .map_err(|e| format!("remove {}: {e}", prior_path.display()))
                            } else {
                                Ok(())
                            }
                        }
                    };
                    if let Err(e) = rollback {
                        rollback_errors.push(e);
                    }
                }
                return if rollback_errors.is_empty() {
                    Err(format!(
                        "personal agents: import rolled back after write failure: {error}"
                    ))
                } else {
                    Err(format!(
                        "personal agents: import write failed ({error}); rollback also failed ({})",
                        rollback_errors.join("; ")
                    ))
                };
            }
            replaced.push(replaced.len());
        }
        Ok(())
    }

    fn all_project_paths(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let root = self.root.join("projects");
        let Ok(entries) = fs::read_dir(root) else {
            return out;
        };
        for entry in entries.flatten() {
            let path = entry.path().join("store.enc");
            if path.is_file() {
                out.push(path);
            }
        }
        out.sort();
        out
    }

    fn load_all(&self) -> Result<(ScopeStore, Vec<(PathBuf, ScopeStore)>), String> {
        let global = self.load_scope(&self.global_path())?;
        let mut projects = Vec::new();
        for path in self.all_project_paths() {
            projects.push((path.clone(), self.load_scope(&path)?));
        }
        Ok((global, projects))
    }
}

struct LockGuard {
    path: PathBuf,
}

impl LockGuard {
    fn acquire(path: PathBuf) -> Result<Self, String> {
        let started = Instant::now();
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut f) => {
                    let _ = writeln!(f, "pid={} ts={:?}", std::process::id(), SystemTime::now());
                    let _ = f.sync_all();
                    return Ok(Self { path });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|m| m.elapsed().ok())
                        .is_some_and(|age| age > Duration::from_secs(30));
                    if stale {
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                    if started.elapsed() > Duration::from_secs(5) {
                        return Err("personal agents: store is busy in another process".into());
                    }
                    thread::sleep(Duration::from_millis(25));
                }
                Err(e) => return Err(format!("personal agents: acquire store lock: {e}")),
            }
        }
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn read_encrypted(path: &Path, key: &[u8; 32]) -> Result<ScopeStore, String> {
    let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let env: CipherEnvelope =
        serde_json::from_slice(&bytes).map_err(|e| format!("decode envelope: {e}"))?;
    let nonce = B64
        .decode(env.nonce)
        .map_err(|e| format!("decode nonce: {e}"))?;
    if nonce.len() != 12 {
        return Err("invalid AES-GCM nonce length".into());
    }
    let ciphertext = B64
        .decode(env.ciphertext)
        .map_err(|e| format!("decode ciphertext: {e}"))?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let plain = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            aes_gcm::aead::Payload {
                msg: &ciphertext,
                aad: AAD,
            },
        )
        .map_err(|_| "AES-GCM authentication failed".to_string())?;
    serde_json::from_slice(&plain).map_err(|e| format!("decode payload: {e}"))
}

fn atomic_write(path: &Path, bytes: &[u8], preserve_backup: bool) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("store"),
        uuid::Uuid::new_v4()
    ));
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("create temp {}: {e}", tmp.display()))?;
        file.write_all(bytes)
            .map_err(|e| format!("write temp: {e}"))?;
        file.sync_all().map_err(|e| format!("fsync temp: {e}"))?;
    }
    let bak = backup_path(path);
    if path.exists() {
        if preserve_backup {
            let _ = fs::remove_file(&bak);
            fs::rename(path, &bak).map_err(|e| format!("rotate backup: {e}"))?;
        } else {
            fs::remove_file(path).map_err(|e| format!("replace key: {e}"))?;
        }
    }
    if let Err(e) = fs::rename(&tmp, path) {
        if preserve_backup && bak.exists() {
            let _ = fs::rename(&bak, path);
        }
        let _ = fs::remove_file(&tmp);
        return Err(format!("atomic replace {}: {e}", path.display()));
    }
    if let Ok(dir) = OpenOptions::new().read(true).open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

fn backup_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(".bak");
    PathBuf::from(s)
}

#[cfg(unix)]
fn restrict_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("chmod 600 {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn restrict_owner_only(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn migrate_scope(mut value: ScopeStore) -> Result<ScopeStore, String> {
    match value.schema_version {
        0 | 1 => {
            value.schema_version = STORE_SCHEMA_VERSION;
            for p in &mut value.profiles {
                p.schema_version = SCHEMA_VERSION;
            }
            for r in &mut value.rule_cards {
                r.schema_version = SCHEMA_VERSION;
            }
            for p in &mut value.project_configs {
                p.schema_version = SCHEMA_VERSION;
            }
            Ok(value)
        }
        STORE_SCHEMA_VERSION => Ok(value),
        other => Err(format!("unsupported personal-agent store schema {other}")),
    }
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn validate_id(id: &str, prefix: &str) -> Result<(), String> {
    let Some(raw) = id.strip_prefix(prefix) else {
        return Err(format!("id must start with {prefix}"));
    };
    uuid::Uuid::parse_str(raw)
        .map(|_| ())
        .map_err(|_| format!("id must be {prefix}<uuid>"))
}

fn validate_text(label: &str, text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        Err(format!("{label} is required"))
    } else {
        Ok(())
    }
}

fn validate_time(label: &str, value: &str) -> Result<(), String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| format!("{label} must be RFC3339"))
}

fn unique_strings(label: &str, values: &[String]) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    if values
        .iter()
        .all(|v| !v.trim().is_empty() && seen.insert(v))
    {
        Ok(())
    } else {
        Err(format!("{label} must contain unique non-empty values"))
    }
}

fn unique_refs(label: &str, refs: &[RevisionRef]) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    if refs
        .iter()
        .all(|r| r.revision > 0 && seen.insert(r.id.clone()))
    {
        Ok(())
    } else {
        Err(format!(
            "{label} must contain one positive pinned revision per id"
        ))
    }
}

fn validate_memory_scope(value: &str) -> Result<(), String> {
    match value {
        "none" | "project" | "global" => Ok(()),
        _ => Err("memoryScope must be none, project, or global".into()),
    }
}

fn validate_personal_skill_id(id: &str) -> Result<(), String> {
    let Some(name) = id.strip_prefix("personal__") else {
        return Err("skill id must start with reserved prefix personal__".into());
    };
    if name.is_empty()
        || name.len() > 96
        || !name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
        || id.contains("..")
        || id.contains('/')
        || id.contains('\\')
    {
        return Err(
            "skill id must be personal__ followed by lowercase letters, digits, '_' or '-'".into(),
        );
    }
    Ok(())
}

fn canonical_tool_names() -> BTreeSet<&'static str> {
    [
        "browser_back",
        "browser_click",
        "browser_close",
        "browser_device",
        "browser_fill",
        "browser_get_text",
        "browser_navigate",
        "browser_open",
        "browser_press",
        "browser_reload",
        "browser_scroll",
        "browser_screenshot",
        "browser_select",
        "browser_snapshot",
        "browser_tab_close",
        "browser_tab_select",
        "browser_tabs",
        "create_dir",
        "device_exec",
        "device_screenshot",
        "edit_file",
        "glob",
        "grep",
        "kvm_node",
        "list_dir",
        "list_skills",
        "load_skill",
        "memory_read",
        "memory_search",
        "memory_write",
        "mcp_call_connected",
        "mcp_install_curated",
        "mcp_search_capabilities",
        "publish_release",
        "read_file",
        "screenshot_url",
        "shell",
        "signing_get",
        "ssh_download",
        "ssh_exec",
        "ssh_upload",
        "web_fetch",
        "web_search",
        "write_file_with_diff",
    ]
    .into_iter()
    .collect()
}

fn validate_tool_names(label: &str, tools: &[String], errors: &mut Vec<String>) {
    if let Err(error) = unique_strings(label, tools) {
        errors.push(error);
    }
    let known = canonical_tool_names();
    for tool in tools {
        if !known.contains(tool.as_str()) {
            errors.push(format!("{label} contains unknown tool: {tool}"));
        }
    }
}

fn skill_validation_errors(doc: &PersonalSkillDoc, strict: bool) -> Vec<String> {
    let mut errors = Vec::new();
    if doc.schema_version != SCHEMA_VERSION {
        errors.push("skill schemaVersion must be 1".into());
    }
    if doc.revision == 0 {
        errors.push("skill revision must be positive".into());
    }
    if let Err(error) = validate_personal_skill_id(&doc.id) {
        errors.push(error);
    }
    if doc.name.trim().is_empty() {
        errors.push("name is required".into());
    }
    for (label, value) in [
        ("name", doc.name.as_str()),
        ("purpose", doc.purpose.as_str()),
        ("instructions", doc.instructions.as_str()),
        ("inputContract", doc.input_contract.as_str()),
        ("outputContract", doc.output_contract.as_str()),
    ] {
        if value.len() > 65_536 || value.contains('\0') {
            errors.push(format!(
                "{label} is too large or contains an invalid NUL byte"
            ));
        }
    }
    match doc.status.as_str() {
        "draft" | "active" | "archived" | "quarantined" => {}
        _ => errors.push("status must be draft, active, archived, or quarantined".into()),
    }
    match doc.scope.as_str() {
        "global" if doc.project_id.is_none() => {}
        "project"
            if doc
                .project_id
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty()) => {}
        _ => errors.push("skill scope/projectId mismatch".into()),
    }
    if let Err(error) = validate_time("createdAt", &doc.created_at) {
        errors.push(error);
    }
    if let Err(error) = validate_time("updatedAt", &doc.updated_at) {
        errors.push(error);
    }
    validate_tool_names("requiredTools", &doc.required_tools, &mut errors);
    validate_tool_names(
        "permissionBoundary.allowedTools",
        &doc.permission_boundary.allowed_tools,
        &mut errors,
    );
    let allowed: BTreeSet<_> = doc
        .permission_boundary
        .allowed_tools
        .iter()
        .map(String::as_str)
        .collect();
    for tool in &doc.required_tools {
        if !allowed.contains(tool.as_str()) {
            errors.push(format!(
                "required tool {tool} is outside permissionBoundary.allowedTools"
            ));
        }
    }
    if strict || doc.status == "active" {
        for (label, value) in [
            ("purpose", doc.purpose.as_str()),
            ("instructions", doc.instructions.as_str()),
            ("inputContract", doc.input_contract.as_str()),
            ("outputContract", doc.output_contract.as_str()),
        ] {
            if value.trim().is_empty() {
                errors.push(format!("{label} is required before activation"));
            }
        }
    }
    errors.sort();
    errors.dedup();
    errors
}

fn validate_skill_shape(doc: &PersonalSkillDoc, strict: bool) -> Result<(), String> {
    let errors = skill_validation_errors(doc, strict);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn validate_profile_shape(doc: &AgentProfileDoc) -> Result<(), String> {
    if doc.schema_version != SCHEMA_VERSION || doc.revision == 0 {
        return Err("profile schemaVersion must be 1 and revision positive".into());
    }
    validate_id(&doc.id, "agent:")?;
    validate_text("displayName", &doc.display_name)?;
    validate_text("identity.name", &doc.identity.name)?;
    validate_text("role", &doc.role)?;
    validate_text("createdAt", &doc.created_at)?;
    validate_time("createdAt", &doc.created_at)?;
    validate_time("updatedAt", &doc.updated_at)?;
    validate_memory_scope(&doc.memory_scope)?;
    unique_strings("allowedTools", &doc.allowed_tools)?;
    unique_strings("skillIds", &doc.skill_ids)?;
    unique_refs("personalSkillRefs", &doc.personal_skill_refs)?;
    unique_strings(
        "delegation.allowedProfileIds",
        &doc.delegation.allowed_profile_ids,
    )?;
    unique_refs("ruleCardRefs", &doc.rule_card_refs)
}

fn validate_rule_shape(doc: &RuleCardDoc) -> Result<(), String> {
    if doc.schema_version != SCHEMA_VERSION || doc.revision == 0 {
        return Err("rule schemaVersion must be 1 and revision positive".into());
    }
    validate_id(&doc.id, "rule:")?;
    validate_text("title", &doc.title)?;
    validate_text("body", &doc.body)?;
    match doc.kind.as_str() {
        "fact" | "preference" | "constraint" | "workflow" | "conditional" => {}
        _ => return Err("invalid rule kind".into()),
    }
    match doc.scope.as_str() {
        "global" if doc.project_id.is_none() => {}
        "project"
            if doc
                .project_id
                .as_deref()
                .is_some_and(|v| !v.trim().is_empty()) => {}
        _ => return Err("rule scope/projectId mismatch".into()),
    }
    if let Some(condition) = &doc.condition {
        if let Some(projects) = &condition.project_ids {
            unique_strings("condition.projectIds", projects)?;
        }
    }
    validate_time("createdAt", &doc.created_at)?;
    validate_time("updatedAt", &doc.updated_at)
}

fn validate_project_shape(doc: &ProjectAgentConfigDoc) -> Result<(), String> {
    if doc.schema_version != SCHEMA_VERSION || doc.revision == 0 {
        return Err("project config schemaVersion must be 1 and revision positive".into());
    }
    validate_text("projectId", &doc.project_id)?;
    unique_refs("profileRefs", &doc.profile_refs)?;
    unique_refs("ruleCardRefs", &doc.rule_card_refs)?;
    for (id, override_doc) in &doc.profile_overrides {
        validate_id(id, "agent:")?;
        if let Some(scope) = &override_doc.memory_scope {
            validate_memory_scope(scope)?;
        }
        if let Some(v) = &override_doc.allowed_tools {
            unique_strings("override.allowedTools", v)?;
        }
        if let Some(v) = &override_doc.skill_ids {
            unique_strings("override.skillIds", v)?;
        }
        if let Some(v) = &override_doc.personal_skill_refs {
            unique_refs("override.personalSkillRefs", v)?;
        }
        if let Some(v) = &override_doc.rule_card_refs {
            unique_refs("override.ruleCardRefs", v)?;
        }
    }
    validate_time("createdAt", &doc.created_at)?;
    validate_time("updatedAt", &doc.updated_at)
}

fn latest_by_id<T, F>(docs: &[T], id: &str, revision: Option<u64>, parts: F) -> Option<T>
where
    T: Clone,
    F: for<'a> Fn(&'a T) -> (&'a str, u64),
{
    docs.iter()
        .filter(|d| {
            let (doc_id, rev) = parts(d);
            doc_id == id && revision.is_none_or(|wanted| wanted == rev)
        })
        .max_by_key(|d| parts(d).1)
        .cloned()
}

fn latest_profiles(docs: &[AgentProfileDoc]) -> Vec<AgentProfileDoc> {
    let mut by_id = BTreeMap::<String, AgentProfileDoc>::new();
    for doc in docs {
        if by_id
            .get(&doc.id)
            .is_none_or(|existing| existing.revision < doc.revision)
        {
            by_id.insert(doc.id.clone(), doc.clone());
        }
    }
    by_id.into_values().collect()
}

fn latest_rules(docs: &[RuleCardDoc]) -> Vec<RuleCardDoc> {
    let mut by_id = BTreeMap::<String, RuleCardDoc>::new();
    for doc in docs {
        if by_id
            .get(&doc.id)
            .is_none_or(|existing| existing.revision < doc.revision)
        {
            by_id.insert(doc.id.clone(), doc.clone());
        }
    }
    by_id.into_values().collect()
}

fn latest_skills(docs: &[PersonalSkillDoc]) -> Vec<PersonalSkillDoc> {
    let mut by_id = BTreeMap::<String, PersonalSkillDoc>::new();
    for doc in docs {
        if by_id
            .get(&doc.id)
            .is_none_or(|existing| existing.revision < doc.revision)
        {
            by_id.insert(doc.id.clone(), doc.clone());
        }
    }
    by_id.into_values().collect()
}

fn latest_project_configs(docs: &[ProjectAgentConfigDoc]) -> Vec<ProjectAgentConfigDoc> {
    let mut by_id = BTreeMap::<String, ProjectAgentConfigDoc>::new();
    for doc in docs {
        if by_id
            .get(&doc.project_id)
            .is_none_or(|existing| existing.revision < doc.revision)
        {
            by_id.insert(doc.project_id.clone(), doc.clone());
        }
    }
    by_id.into_values().collect()
}

fn pinned_profile<'a>(docs: &'a [AgentProfileDoc], r: &RevisionRef) -> Option<&'a AgentProfileDoc> {
    docs.iter()
        .find(|d| d.id == r.id && d.revision == r.revision)
}

fn pinned_rule<'a>(docs: &'a [RuleCardDoc], r: &RevisionRef) -> Option<&'a RuleCardDoc> {
    docs.iter()
        .find(|d| d.id == r.id && d.revision == r.revision)
}

fn pinned_skill<'a>(docs: &'a [PersonalSkillDoc], r: &RevisionRef) -> Option<&'a PersonalSkillDoc> {
    docs.iter()
        .find(|doc| doc.id == r.id && doc.revision == r.revision)
}

fn skill_visible_to_project(skill: &PersonalSkillDoc, project_id: &str) -> bool {
    skill.scope == "global"
        || (skill.scope == "project" && skill.project_id.as_deref() == Some(project_id))
}

fn validate_personal_skill_refs(
    label: &str,
    refs: &[RevisionRef],
    skills: &[PersonalSkillDoc],
    project_id: Option<&str>,
) -> Result<(), String> {
    for reference in refs {
        let skill = pinned_skill(skills, reference).ok_or_else(|| {
            format!(
                "{label} has dangling personal skill {}@{}",
                reference.id, reference.revision
            )
        })?;
        if skill.status != "active" {
            return Err(format!(
                "{label} references non-active personal skill {}@{} ({})",
                reference.id, reference.revision, skill.status
            ));
        }
        if let Some(project_id) = project_id {
            if !skill_visible_to_project(skill, project_id) {
                return Err(format!(
                    "{label} cannot access personal skill {}@{} from this project",
                    reference.id, reference.revision
                ));
            }
        } else if skill.scope != "global" {
            return Err(format!(
                "{label} may only attach global personal skills; use a project override for {}@{}",
                reference.id, reference.revision
            ));
        }
    }
    Ok(())
}

fn installed_skill_ids() -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for root in crate::paths::skills_dirs_read() {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.join("SKILL.md").is_file() {
                continue;
            }
            if let Some(id) = path.file_name().and_then(|value| value.to_str()) {
                if id != "_remote" {
                    ids.insert(id.to_string());
                }
            }
        }
    }
    ids
}

fn validate_skill_refs<'a>(
    refs: impl IntoIterator<Item = &'a String>,
    installed: &BTreeSet<String>,
) -> Result<(), String> {
    let missing: Vec<_> = refs
        .into_iter()
        .filter(|id| !installed.contains(id.as_str()))
        .cloned()
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("missing installed skills: {}", missing.join(", ")))
    }
}

fn validate_profile_refs(
    profiles: &[AgentProfileDoc],
    rules: &[RuleCardDoc],
    skills: &[PersonalSkillDoc],
    installed: &BTreeSet<String>,
) -> Result<(), String> {
    for profile in profiles {
        for rule_ref in &profile.rule_card_refs {
            if pinned_rule(rules, rule_ref).is_none() {
                return Err(format!(
                    "profile {} has dangling rule {}@{}",
                    profile.id, rule_ref.id, rule_ref.revision
                ));
            }
        }
        validate_skill_refs(profile.skill_ids.iter(), installed)?;
        validate_personal_skill_refs(
            &format!("profile {}", profile.id),
            &profile.personal_skill_refs,
            skills,
            None,
        )?;
        validate_personal_skill_tools(
            &format!("profile {}", profile.id),
            &profile.personal_skill_refs,
            skills,
            &profile.allowed_tools,
        )?;
    }
    Ok(())
}

fn validate_personal_skill_tools(
    label: &str,
    refs: &[RevisionRef],
    skills: &[PersonalSkillDoc],
    allowed_tools: &[String],
) -> Result<(), String> {
    let allowed: BTreeSet<_> = allowed_tools.iter().map(String::as_str).collect();
    for reference in refs {
        let skill = pinned_skill(skills, reference).ok_or_else(|| {
            format!(
                "{label} references missing personal skill {}@{}",
                reference.id, reference.revision
            )
        })?;
        let missing: Vec<_> = skill
            .required_tools
            .iter()
            .filter(|tool| !allowed.contains(tool.as_str()))
            .cloned()
            .collect();
        if !missing.is_empty() {
            return Err(format!(
                "{label} attaches personal skill {}@{} but does not allow required tools: {}",
                reference.id,
                reference.revision,
                missing.join(", ")
            ));
        }
    }
    Ok(())
}

fn validate_project_refs(
    config: &ProjectAgentConfigDoc,
    profiles: &[AgentProfileDoc],
    rules: &[RuleCardDoc],
    skills: &[PersonalSkillDoc],
    installed: &BTreeSet<String>,
) -> Result<(), String> {
    for profile_ref in &config.profile_refs {
        if pinned_profile(profiles, profile_ref).is_none() {
            return Err(format!(
                "missing pinned profile {}@{}",
                profile_ref.id, profile_ref.revision
            ));
        }
    }
    for rule_ref in &config.rule_card_refs {
        if pinned_rule(rules, rule_ref).is_none() {
            return Err(format!(
                "missing pinned rule {}@{}",
                rule_ref.id, rule_ref.revision
            ));
        }
    }
    let attached_ids: BTreeSet<_> = config.profile_refs.iter().map(|r| r.id.as_str()).collect();
    let known_profile_ids: BTreeSet<_> = latest_profiles(profiles)
        .into_iter()
        .map(|profile| profile.id)
        .collect();
    for (profile_id, override_doc) in &config.profile_overrides {
        if !attached_ids.contains(profile_id.as_str()) {
            return Err(format!(
                "profile override is not attached to project: {profile_id}"
            ));
        }
        if let Some(rule_refs) = &override_doc.rule_card_refs {
            for rule_ref in rule_refs {
                if pinned_rule(rules, rule_ref).is_none() {
                    return Err(format!(
                        "profile override {profile_id} has dangling rule {}@{}",
                        rule_ref.id, rule_ref.revision
                    ));
                }
            }
        }
        if let Some(skill_ids) = &override_doc.skill_ids {
            validate_skill_refs(skill_ids.iter(), installed)?;
        }
        if let Some(skill_refs) = &override_doc.personal_skill_refs {
            validate_personal_skill_refs(
                &format!("profile override {profile_id}"),
                skill_refs,
                skills,
                Some(&config.project_id),
            )?;
        }
        let base_profile = config
            .profile_refs
            .iter()
            .find(|reference| reference.id == *profile_id)
            .and_then(|reference| pinned_profile(profiles, reference))
            .ok_or_else(|| format!("missing pinned profile for override: {profile_id}"))?;
        let effective_tools = override_doc
            .allowed_tools
            .as_ref()
            .map(|override_tools| {
                let override_set: BTreeSet<_> = override_tools.iter().map(String::as_str).collect();
                base_profile
                    .allowed_tools
                    .iter()
                    .filter(|tool| override_set.contains(tool.as_str()))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| base_profile.allowed_tools.clone());
        let effective_skill_refs = override_doc
            .personal_skill_refs
            .as_deref()
            .unwrap_or(&base_profile.personal_skill_refs);
        validate_personal_skill_tools(
            &format!("profile override {profile_id}"),
            effective_skill_refs,
            skills,
            &effective_tools,
        )?;
        if let Some(delegation) = &override_doc.delegation {
            if let Some(targets) = &delegation.allowed_profile_ids {
                for target in targets {
                    if !known_profile_ids.contains(target) {
                        return Err(format!(
                            "profile override {profile_id} has dangling delegation target {target}"
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

fn delegation_errors(profiles: &[AgentProfileDoc]) -> Vec<String> {
    let latest = latest_profiles(profiles);
    let ids: BTreeSet<_> = latest.iter().map(|p| p.id.as_str()).collect();
    let mut errors = Vec::new();
    for profile in &latest {
        for target in &profile.delegation.allowed_profile_ids {
            if !ids.contains(target.as_str()) {
                errors.push(format!("dangling delegation {} -> {target}", profile.id));
            }
        }
    }
    fn visit(
        id: &str,
        map: &BTreeMap<&str, &AgentProfileDoc>,
        visiting: &mut BTreeSet<String>,
        visited: &mut BTreeSet<String>,
        errors: &mut Vec<String>,
    ) {
        if visited.contains(id) {
            return;
        }
        if !visiting.insert(id.to_string()) {
            errors.push(format!("delegation cycle includes {id}"));
            return;
        }
        if let Some(p) = map.get(id) {
            for next in &p.delegation.allowed_profile_ids {
                if map.contains_key(next.as_str()) {
                    visit(next, map, visiting, visited, errors);
                }
            }
        }
        visiting.remove(id);
        visited.insert(id.to_string());
    }
    let map: BTreeMap<_, _> = latest.iter().map(|p| (p.id.as_str(), p)).collect();
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    for id in map.keys() {
        visit(id, &map, &mut visiting, &mut visited, &mut errors);
    }
    errors.sort();
    errors.dedup();
    errors
}

fn memory_rank(value: &str) -> u8 {
    match value {
        "none" => 0,
        "project" => 1,
        _ => 2,
    }
}

fn most_restrictive(a: &str, b: &str) -> String {
    if memory_rank(a) <= memory_rank(b) {
        a.to_string()
    } else {
        b.to_string()
    }
}

fn intersection(left: &[String], right: &[String]) -> Vec<String> {
    let right: BTreeSet<_> = right.iter().map(String::as_str).collect();
    left.iter()
        .filter(|v| right.contains(v.as_str()))
        .cloned()
        .collect()
}

fn provenance(source: &str, id: &str, revision: u64) -> ProvenanceEntry {
    ProvenanceEntry {
        source: source.into(),
        document_id: id.into(),
        revision,
    }
}

fn resolve_with(
    project_id: &str,
    profile_id: &str,
    global: &ScopeStore,
    project: &ScopeStore,
) -> Result<EffectiveAgentConfig, String> {
    let config = project
        .project_configs
        .iter()
        .filter(|c| c.project_id == project_id)
        .max_by_key(|c| c.revision)
        .ok_or_else(|| format!("project config not found: {project_id}"))?;
    let profile_ref = config
        .profile_refs
        .iter()
        .find(|r| r.id == profile_id)
        .ok_or_else(|| format!("project has no pinned profile ref: {profile_id}"))?;
    let base = pinned_profile(&global.profiles, profile_ref)
        .ok_or_else(|| {
            format!(
                "missing pinned profile {}@{}",
                profile_ref.id, profile_ref.revision
            )
        })?
        .clone();
    let mut resolved = base.clone();
    let mut errors = delegation_errors(&global.profiles);
    let mut prov = BTreeMap::new();
    for field in [
        "displayName",
        "identity",
        "role",
        "systemInstructions",
        "model",
        "allowedTools",
        "memoryScope",
        "delegation",
        "skillIds",
        "personalSkillRefs",
        "ruleCardRefs",
    ] {
        prov.insert(
            field.into(),
            provenance("global-profile", &base.id, base.revision),
        );
    }

    let override_doc = config.profile_overrides.get(profile_id);
    if let Some(o) = override_doc {
        if let Some(v) = &o.system_instructions {
            resolved.system_instructions = v.clone();
            prov.insert(
                "systemInstructions".into(),
                provenance("project-override", &config.project_id, config.revision),
            );
        }
        if let Some(v) = &o.model {
            resolved.model = v.clone();
            prov.insert(
                "model".into(),
                provenance("project-override", &config.project_id, config.revision),
            );
        }
        if let Some(v) = &o.allowed_tools {
            resolved.allowed_tools = intersection(&resolved.allowed_tools, v);
            prov.insert(
                "allowedTools".into(),
                provenance("project-override", &config.project_id, config.revision),
            );
        }
        if let Some(v) = &o.memory_scope {
            resolved.memory_scope = most_restrictive(&resolved.memory_scope, v);
            prov.insert(
                "memoryScope".into(),
                provenance("project-override", &config.project_id, config.revision),
            );
        }
        if let Some(v) = &o.skill_ids {
            resolved.skill_ids = v.clone();
            prov.insert(
                "skillIds".into(),
                provenance("project-override", &config.project_id, config.revision),
            );
        }
        if let Some(v) = &o.personal_skill_refs {
            resolved.personal_skill_refs = v.clone();
            prov.insert(
                "personalSkillRefs".into(),
                provenance("project-override", &config.project_id, config.revision),
            );
        }
        if let Some(v) = &o.delegation {
            if let Some(enabled) = v.enabled {
                resolved.delegation.enabled = resolved.delegation.enabled && enabled;
            }
            if let Some(ids) = &v.allowed_profile_ids {
                resolved.delegation.allowed_profile_ids =
                    intersection(&resolved.delegation.allowed_profile_ids, ids);
            }
            prov.insert(
                "delegation".into(),
                provenance("project-override", &config.project_id, config.revision),
            );
        }
        if let Some(refs) = &o.rule_card_refs {
            resolved.rule_card_refs = refs.clone();
            prov.insert(
                "ruleCardRefs".into(),
                provenance("project-override", &config.project_id, config.revision),
            );
        }
    }

    if !errors.is_empty() {
        resolved.delegation.enabled = false;
        resolved.delegation.allowed_profile_ids.clear();
    }

    let mut all_rules = global.rule_cards.clone();
    all_rules.extend(project.rule_cards.clone());
    let mut refs_by_id = BTreeMap::<String, RevisionRef>::new();
    for rule_ref in &resolved.rule_card_refs {
        refs_by_id.insert(rule_ref.id.clone(), rule_ref.clone());
    }
    // Project attachments are the later/higher-precedence layer. Replacing by
    // immutable rule id guarantees that two revisions are never injected.
    for rule_ref in &config.rule_card_refs {
        refs_by_id.insert(rule_ref.id.clone(), rule_ref.clone());
    }
    let mut attached = Vec::new();
    for r in refs_by_id.into_values() {
        match pinned_rule(&all_rules, &r) {
            Some(rule)
                if rule
                    .condition
                    .as_ref()
                    .and_then(|c| c.project_ids.as_ref())
                    .is_none_or(|ids| ids.iter().any(|id| id == project_id)) =>
            {
                attached.push(rule.clone());
                prov.insert(
                    format!("ruleCards.{}@{}", r.id, r.revision),
                    provenance("rule-card", &r.id, r.revision),
                );
            }
            Some(_) => {}
            None => errors.push(format!("missing pinned rule {}@{}", r.id, r.revision)),
        }
    }
    if let Err(error) = validate_skill_refs(resolved.skill_ids.iter(), &installed_skill_ids()) {
        errors.push(error);
    }
    let mut all_skills = global.skills.clone();
    all_skills.extend(project.skills.clone());
    let mut attached_skills = Vec::new();
    for reference in &resolved.personal_skill_refs {
        let skill = pinned_skill(&all_skills, reference).ok_or_else(|| {
            format!(
                "missing pinned personal skill {}@{}",
                reference.id, reference.revision
            )
        })?;
        if skill.status != "active" {
            return Err(format!(
                "personal skill {}@{} is not active ({})",
                reference.id, reference.revision, skill.status
            ));
        }
        if !skill_visible_to_project(skill, project_id) {
            return Err(format!(
                "personal skill {}@{} is not accessible from this project",
                reference.id, reference.revision
            ));
        }
        let allowed: BTreeSet<_> = resolved.allowed_tools.iter().map(String::as_str).collect();
        let unauthorized: Vec<_> = skill
            .required_tools
            .iter()
            .filter(|tool| !allowed.contains(tool.as_str()))
            .cloned()
            .collect();
        if !unauthorized.is_empty() {
            return Err(format!(
                "personal skill {}@{} requires tools not allowed for profile {}: {}",
                reference.id,
                reference.revision,
                resolved.id,
                unauthorized.join(", ")
            ));
        }
        attached_skills.push(skill.clone());
        prov.insert(
            format!("personalSkills.{}@{}", reference.id, reference.revision),
            provenance("personal-skill", &reference.id, reference.revision),
        );
    }
    errors.sort();
    errors.dedup();
    Ok(EffectiveAgentConfig {
        profile: resolved,
        provenance: prov,
        attached_rules: attached,
        attached_skills,
        validation_errors: errors,
    })
}

fn save_profile_with(
    repo: &Repository,
    mut doc: AgentProfileDoc,
    expected_revision: Option<u64>,
) -> Result<AgentProfileDoc, String> {
    validate_profile_shape(&doc)?;
    let _guard = repo.lock()?;
    let mut store = repo.load_scope(&repo.global_path())?;
    let previous = latest_by_id(&store.profiles, &doc.id, None, |d| {
        (d.id.as_str(), d.revision)
    });
    match previous {
        None => {
            if expected_revision.is_some() || doc.revision != 1 {
                return Err("new profile must use revision 1 and no expectedRevision".into());
            }
        }
        Some(prev) => {
            if expected_revision != Some(prev.revision) {
                return Err(format!(
                    "profile revision conflict: expected {}, got {:?}",
                    prev.revision, expected_revision
                ));
            }
            doc.revision = prev.revision + 1;
            doc.created_at = prev.created_at;
        }
    }
    store.profiles.push(doc.clone());
    let graph_errors = delegation_errors(&latest_profiles(&store.profiles));
    if !graph_errors.is_empty() {
        return Err(graph_errors.join("; "));
    }
    validate_profile_refs(
        &latest_profiles(&store.profiles),
        &store.rule_cards,
        &store.skills,
        &installed_skill_ids(),
    )?;
    repo.save_scope(&repo.global_path(), &store)?;
    Ok(doc)
}

fn save_rule_with(
    repo: &Repository,
    mut doc: RuleCardDoc,
    expected_revision: Option<u64>,
) -> Result<RuleCardDoc, String> {
    validate_rule_shape(&doc)?;
    let _guard = repo.lock()?;
    let (global, project_scopes) = repo.load_all()?;
    let mut all_rules = global.rule_cards;
    for (_, scope) in project_scopes {
        all_rules.extend(scope.rule_cards);
    }
    let previous = latest_by_id(&all_rules, &doc.id, None, |d| (d.id.as_str(), d.revision));
    if let Some(previous) = &previous {
        if previous.scope != doc.scope || previous.project_id != doc.project_id {
            return Err("rule scope/projectId is immutable across revisions".into());
        }
    }
    let path = if doc.scope == "project" {
        repo.project_path(doc.project_id.as_deref().unwrap_or_default())
    } else {
        repo.global_path()
    };
    let mut store = repo.load_scope(&path)?;
    match previous {
        None if expected_revision.is_none() && doc.revision == 1 => {}
        None => return Err("new rule must use revision 1 and no expectedRevision".into()),
        Some(prev) => {
            if expected_revision != Some(prev.revision) {
                return Err(format!("rule revision conflict at {}", prev.revision));
            }
            doc.revision = prev.revision + 1;
            doc.created_at = prev.created_at;
        }
    }
    store.rule_cards.push(doc.clone());
    repo.save_scope(&path, &store)?;
    Ok(doc)
}

fn save_skill_with(
    repo: &Repository,
    mut doc: PersonalSkillDoc,
    expected_revision: Option<u64>,
) -> Result<PersonalSkillDoc, String> {
    validate_skill_shape(&doc, doc.status == "active")?;
    let _guard = repo.lock()?;
    let (global, project_scopes) = repo.load_all()?;
    let mut all_skills = global.skills;
    for (_, scope) in project_scopes {
        all_skills.extend(scope.skills);
    }
    let previous = latest_by_id(&all_skills, &doc.id, None, |skill| {
        (skill.id.as_str(), skill.revision)
    });
    if let Some(previous) = &previous {
        if previous.scope != doc.scope || previous.project_id != doc.project_id {
            return Err("skill scope/projectId is immutable across revisions".into());
        }
    }
    let path = if doc.scope == "project" {
        repo.project_path(doc.project_id.as_deref().unwrap_or_default())
    } else {
        repo.global_path()
    };
    let mut store = repo.load_scope(&path)?;
    match previous {
        None if expected_revision.is_none() && doc.revision == 1 => {}
        None => return Err("new skill must use revision 1 and no expectedRevision".into()),
        Some(previous) => {
            if expected_revision != Some(previous.revision) {
                return Err(format!("skill revision conflict at {}", previous.revision));
            }
            doc.revision = previous.revision + 1;
            doc.created_at = previous.created_at;
        }
    }
    validate_skill_shape(&doc, doc.status == "active")?;
    store.skills.push(doc.clone());
    repo.save_scope(&path, &store)?;
    Ok(doc)
}

fn save_project_with(
    repo: &Repository,
    mut doc: ProjectAgentConfigDoc,
    expected_revision: Option<u64>,
) -> Result<ProjectAgentConfigDoc, String> {
    validate_project_shape(&doc)?;
    let _guard = repo.lock()?;
    let global = repo.load_scope(&repo.global_path())?;
    let path = repo.project_path(&doc.project_id);
    let mut store = repo.load_scope(&path)?;
    let mut rules = global.rule_cards.clone();
    rules.extend(store.rule_cards.clone());
    let mut skills = global.skills.clone();
    skills.extend(store.skills.clone());
    validate_project_refs(
        &doc,
        &latest_profiles(&global.profiles),
        &rules,
        &skills,
        &installed_skill_ids(),
    )?;
    let previous = store
        .project_configs
        .iter()
        .filter(|c| c.project_id == doc.project_id)
        .max_by_key(|c| c.revision)
        .cloned();
    match previous {
        None if expected_revision.is_none() && doc.revision == 1 => {}
        None => return Err("new project config must use revision 1".into()),
        Some(prev) => {
            if expected_revision != Some(prev.revision) {
                return Err(format!("project revision conflict at {}", prev.revision));
            }
            doc.revision = prev.revision + 1;
            doc.created_at = prev.created_at;
        }
    }
    store.project_configs.push(doc.clone());
    repo.save_scope(&path, &store)?;
    Ok(doc)
}

#[tauri::command]
pub fn personal_agent_list_profiles() -> Result<Vec<AgentProfileDoc>, String> {
    let repo = Repository::production()?;
    Ok(latest_profiles(
        &repo.load_scope(&repo.global_path())?.profiles,
    ))
}

#[tauri::command]
pub fn personal_agent_get_profile(
    id: String,
    revision: Option<u64>,
) -> Result<AgentProfileDoc, String> {
    let repo = Repository::production()?;
    latest_by_id(
        &repo.load_scope(&repo.global_path())?.profiles,
        &id,
        revision,
        |d| (d.id.as_str(), d.revision),
    )
    .ok_or_else(|| format!("profile not found: {id}"))
}

#[tauri::command]
pub fn personal_agent_save_profile(
    doc: AgentProfileDoc,
    expected_revision: Option<u64>,
) -> Result<AgentProfileDoc, String> {
    save_profile_with(&Repository::production()?, doc, expected_revision)
}

#[tauri::command]
pub fn personal_agent_list_skills(
    project_id: Option<String>,
    include_private: Option<bool>,
) -> Result<Vec<PersonalSkillDoc>, String> {
    let repo = Repository::production()?;
    let global = repo.load_scope(&repo.global_path())?;
    let mut skills = global.skills;
    if let Some(project_id) = project_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let project = repo.load_scope(&repo.project_path(project_id))?;
        skills.extend(
            project
                .skills
                .into_iter()
                .filter(|skill| skill.project_id.as_deref() == Some(project_id)),
        );
    }
    if !include_private.unwrap_or(false) {
        skills.retain(|skill| !skill.private);
    }
    Ok(latest_skills(&skills))
}

#[tauri::command]
pub fn personal_agent_get_skill(
    id: String,
    revision: Option<u64>,
    project_id: String,
) -> Result<PersonalSkillDoc, String> {
    get_skill_with(&Repository::production()?, &id, revision, &project_id)
}

fn get_skill_with(
    repo: &Repository,
    id: &str,
    revision: Option<u64>,
    project_id: &str,
) -> Result<PersonalSkillDoc, String> {
    let global = repo.load_scope(&repo.global_path())?;
    let project = repo.load_scope(&repo.project_path(project_id))?;
    let mut skills = global.skills;
    skills.extend(
        project
            .skills
            .into_iter()
            .filter(|skill| skill.project_id.as_deref() == Some(project_id)),
    );
    let skill = latest_by_id(&skills, id, revision, |doc| (doc.id.as_str(), doc.revision))
        .ok_or_else(|| format!("personal skill not found: {id}"))?;
    if !skill_visible_to_project(&skill, project_id) {
        return Err("personal skill is not accessible from this project".into());
    }
    Ok(skill)
}

#[tauri::command]
pub fn personal_agent_validate_skill(
    doc: PersonalSkillDoc,
    project_id: Option<String>,
) -> SkillValidationResult {
    let mut errors = skill_validation_errors(&doc, doc.status == "active");
    if let Some(project_id) = project_id.as_deref() {
        if doc.scope == "project" && doc.project_id.as_deref() != Some(project_id) {
            errors.push("project skill does not belong to the active project".into());
        }
    }
    errors.sort();
    errors.dedup();
    SkillValidationResult {
        valid: errors.is_empty(),
        errors,
    }
}

#[tauri::command]
pub fn personal_agent_save_skill(
    doc: PersonalSkillDoc,
    expected_revision: Option<u64>,
) -> Result<PersonalSkillDoc, String> {
    save_skill_with(&Repository::production()?, doc, expected_revision)
}

#[tauri::command]
pub fn personal_agent_list_rule_cards(
    project_id: Option<String>,
    include_private: Option<bool>,
) -> Result<Vec<RuleCardDoc>, String> {
    let repo = Repository::production()?;
    let (global, projects) = repo.load_all()?;
    let mut rules = global.rule_cards;
    for (_, project) in projects {
        rules.extend(project.rule_cards.into_iter().filter(|rule| {
            project_id
                .as_deref()
                .is_none_or(|wanted| rule.project_id.as_deref() == Some(wanted))
        }));
    }
    if !include_private.unwrap_or(false) {
        rules.retain(|rule| !rule.private);
    }
    Ok(latest_rules(&rules))
}

#[tauri::command]
pub fn personal_agent_get_rule_card(
    id: String,
    revision: Option<u64>,
    project_id: String,
) -> Result<RuleCardDoc, String> {
    get_rule_card_with(&Repository::production()?, &id, revision, &project_id)
}

fn get_rule_card_with(
    repo: &Repository,
    id: &str,
    revision: Option<u64>,
    project_id: &str,
) -> Result<RuleCardDoc, String> {
    let global = repo.load_scope(&repo.global_path())?;
    let project = repo.load_scope(&repo.project_path(&project_id))?;
    let mut rules = global.rule_cards;
    rules.extend(
        project
            .rule_cards
            .iter()
            .filter(|rule| rule.project_id.as_deref() == Some(project_id))
            .cloned(),
    );
    let rule = latest_by_id(&rules, id, revision, |d| (d.id.as_str(), d.revision))
        .ok_or_else(|| format!("rule card not found: {id}"))?;
    if rule.private && rule.scope == "project" && rule.project_id.as_deref() != Some(project_id) {
        return Err("private rule card is not accessible from this project".into());
    }
    Ok(rule)
}

#[tauri::command]
pub fn personal_agent_save_rule_card(
    doc: RuleCardDoc,
    expected_revision: Option<u64>,
) -> Result<RuleCardDoc, String> {
    save_rule_with(&Repository::production()?, doc, expected_revision)
}

#[tauri::command]
pub fn personal_agent_get_project_config(
    project_id: String,
) -> Result<Option<ProjectAgentConfigDoc>, String> {
    let repo = Repository::production()?;
    let store = repo.load_scope(&repo.project_path(&project_id))?;
    Ok(store
        .project_configs
        .into_iter()
        .filter(|c| c.project_id == project_id)
        .max_by_key(|c| c.revision))
}

#[tauri::command]
pub fn personal_agent_save_project_config(
    doc: ProjectAgentConfigDoc,
    expected_revision: Option<u64>,
) -> Result<ProjectAgentConfigDoc, String> {
    save_project_with(&Repository::production()?, doc, expected_revision)
}

#[tauri::command]
pub fn personal_agent_resolve(
    project_id: String,
    profile_id: String,
) -> Result<EffectiveAgentConfig, String> {
    let repo = Repository::production()?;
    let global = repo.load_scope(&repo.global_path())?;
    let project = repo.load_scope(&repo.project_path(&project_id))?;
    resolve_with(&project_id, &profile_id, &global, &project)
}

#[tauri::command]
pub fn personal_agent_export(
    project_id: Option<String>,
    include_private: Option<bool>,
) -> Result<String, String> {
    let repo = Repository::production()?;
    export_with(
        &repo,
        project_id.as_deref(),
        include_private.unwrap_or(false),
    )
}

fn export_with(
    repo: &Repository,
    project_id: Option<&str>,
    include_private: bool,
) -> Result<String, String> {
    let global = repo.load_scope(&repo.global_path())?;
    let mut bundle = ExportBundle {
        schema_version: EXPORT_SCHEMA_VERSION,
        profiles: global.profiles,
        rule_cards: global.rule_cards,
        skills: global.skills,
        project_configs: Vec::new(),
    };
    if let Some(id) = project_id {
        let project = repo.load_scope(&repo.project_path(&id))?;
        bundle.rule_cards.extend(project.rule_cards);
        bundle.skills.extend(project.skills);
        bundle.project_configs.extend(
            project
                .project_configs
                .into_iter()
                .filter(|c| c.project_id == id),
        );
    }
    if !include_private {
        bundle.rule_cards.retain(|r| !r.private);
        bundle
            .skills
            .retain(|skill| !skill.private && skill.scope == "global");
        let exported_rules: BTreeSet<_> = bundle
            .rule_cards
            .iter()
            .map(|rule| (rule.id.as_str(), rule.revision))
            .collect();
        let exported_skills: BTreeSet<_> = bundle
            .skills
            .iter()
            .map(|skill| (skill.id.as_str(), skill.revision))
            .collect();
        for profile in &mut bundle.profiles {
            profile.rule_card_refs.retain(|rule_ref| {
                exported_rules.contains(&(rule_ref.id.as_str(), rule_ref.revision))
            });
            profile.personal_skill_refs.retain(|skill_ref| {
                exported_skills.contains(&(skill_ref.id.as_str(), skill_ref.revision))
            });
        }
        for config in &mut bundle.project_configs {
            config.rule_card_refs.retain(|rule_ref| {
                exported_rules.contains(&(rule_ref.id.as_str(), rule_ref.revision))
            });
            for override_doc in config.profile_overrides.values_mut() {
                if let Some(rule_refs) = &mut override_doc.rule_card_refs {
                    rule_refs.retain(|rule_ref| {
                        exported_rules.contains(&(rule_ref.id.as_str(), rule_ref.revision))
                    });
                }
                if let Some(skill_refs) = &mut override_doc.personal_skill_refs {
                    skill_refs.retain(|skill_ref| {
                        exported_skills.contains(&(skill_ref.id.as_str(), skill_ref.revision))
                    });
                }
            }
        }
    }
    serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())
}

fn validate_import_bundle(bundle: &ExportBundle, project_id: Option<&str>) -> Result<(), String> {
    if bundle.schema_version > EXPORT_SCHEMA_VERSION {
        return Err(format!(
            "unsupported import schema {}",
            bundle.schema_version
        ));
    }
    for profile in &bundle.profiles {
        validate_profile_shape(profile)?;
    }
    for rule in &bundle.rule_cards {
        validate_rule_shape(rule)?;
        if let Some(target) = project_id {
            if rule.scope == "project" && rule.project_id.as_deref() != Some(target) {
                return Err("import project rule does not match target project".into());
            }
        }
    }
    for skill in &bundle.skills {
        validate_skill_shape(skill, skill.status == "active")?;
        if let Some(target) = project_id {
            if skill.scope == "project" && skill.project_id.as_deref() != Some(target) {
                return Err("import project skill does not match target project".into());
            }
        }
    }
    for config in &bundle.project_configs {
        validate_project_shape(config)?;
        if let Some(target) = project_id {
            if config.project_id != target {
                return Err("import project config does not match target project".into());
            }
        }
    }
    Ok(())
}

fn quarantine_imported_skills(bundle: &mut ExportBundle) {
    for skill in &mut bundle.skills {
        if skill.status == "active" {
            skill.status = "quarantined".into();
        }
    }
    let activatable: BTreeSet<_> = bundle
        .skills
        .iter()
        .filter(|skill| skill.status == "active")
        .map(|skill| (skill.id.as_str(), skill.revision))
        .collect();
    for profile in &mut bundle.profiles {
        profile
            .personal_skill_refs
            .retain(|reference| activatable.contains(&(reference.id.as_str(), reference.revision)));
    }
    for config in &mut bundle.project_configs {
        for override_doc in config.profile_overrides.values_mut() {
            if let Some(references) = &mut override_doc.personal_skill_refs {
                references.retain(|reference| {
                    activatable.contains(&(reference.id.as_str(), reference.revision))
                });
            }
        }
    }
}

#[tauri::command]
pub fn personal_agent_import(
    payload: String,
    project_id: Option<String>,
    preview: Option<bool>,
) -> Result<ImportResult, String> {
    let mut bundle: ExportBundle =
        serde_json::from_str(&payload).map_err(|e| format!("invalid import JSON: {e}"))?;
    if bundle.schema_version <= 1 {
        bundle.schema_version = EXPORT_SCHEMA_VERSION;
        for p in &mut bundle.profiles {
            p.schema_version = SCHEMA_VERSION;
        }
        for r in &mut bundle.rule_cards {
            r.schema_version = SCHEMA_VERSION;
        }
        for c in &mut bundle.project_configs {
            c.schema_version = SCHEMA_VERSION;
        }
    }
    quarantine_imported_skills(&mut bundle);
    validate_import_bundle(&bundle, project_id.as_deref())?;
    let repo = Repository::production()?;
    import_with(
        &repo,
        bundle,
        project_id.as_deref(),
        preview.unwrap_or(false),
    )
}

fn import_with(
    repo: &Repository,
    mut bundle: ExportBundle,
    target_project: Option<&str>,
    preview: bool,
) -> Result<ImportResult, String> {
    quarantine_imported_skills(&mut bundle);
    validate_import_bundle(&bundle, target_project)?;
    let _guard = repo.lock()?;
    let mut global = repo.load_scope(&repo.global_path())?;
    let mut projects: BTreeMap<String, ScopeStore> = BTreeMap::new();
    for profile in &bundle.profiles {
        if let Some(existing) = global
            .profiles
            .iter()
            .find(|p| p.id == profile.id && p.revision == profile.revision)
        {
            if existing != profile {
                return Err(format!(
                    "immutable profile revision conflict {}@{}",
                    profile.id, profile.revision
                ));
            }
            continue;
        }
        global.profiles.push(profile.clone());
    }
    for rule in &bundle.rule_cards {
        if rule.scope == "global" {
            if let Some(existing) = global
                .rule_cards
                .iter()
                .find(|r| r.id == rule.id && r.revision == rule.revision)
            {
                if existing != rule {
                    return Err(format!(
                        "immutable rule revision conflict {}@{}",
                        rule.id, rule.revision
                    ));
                }
            } else {
                global.rule_cards.push(rule.clone());
            }
        } else {
            let project_id = rule.project_id.as_deref().unwrap_or_default();
            let store = projects
                .entry(project_id.to_string())
                .or_insert(repo.load_scope(&repo.project_path(project_id))?);
            if let Some(existing) = store
                .rule_cards
                .iter()
                .find(|r| r.id == rule.id && r.revision == rule.revision)
            {
                if existing != rule {
                    return Err(format!(
                        "immutable rule revision conflict {}@{}",
                        rule.id, rule.revision
                    ));
                }
            } else {
                store.rule_cards.push(rule.clone());
            }
        }
    }
    for skill in &bundle.skills {
        let target = if skill.scope == "global" {
            &mut global
        } else {
            let project_id = skill.project_id.as_deref().unwrap_or_default();
            projects
                .entry(project_id.to_string())
                .or_insert(repo.load_scope(&repo.project_path(project_id))?)
        };
        if let Some(existing) = target
            .skills
            .iter()
            .find(|stored| stored.id == skill.id && stored.revision == skill.revision)
        {
            if existing != skill {
                return Err(format!(
                    "immutable skill revision conflict {}@{}",
                    skill.id, skill.revision
                ));
            }
        } else {
            target.skills.push(skill.clone());
        }
    }
    for config in &bundle.project_configs {
        let store = projects
            .entry(config.project_id.clone())
            .or_insert(repo.load_scope(&repo.project_path(&config.project_id))?);
        if let Some(existing) = store
            .project_configs
            .iter()
            .find(|c| c.project_id == config.project_id && c.revision == config.revision)
        {
            if existing != config {
                return Err(format!(
                    "immutable project revision conflict {}@{}",
                    config.project_id, config.revision
                ));
            }
        } else {
            store.project_configs.push(config.clone());
        }
    }
    // Validate the fully merged snapshot before the first disk replacement.
    let graph = delegation_errors(&latest_profiles(&global.profiles));
    if !graph.is_empty() {
        return Err(graph.join("; "));
    }
    let installed = installed_skill_ids();
    validate_profile_refs(
        &latest_profiles(&global.profiles),
        &global.rule_cards,
        &global.skills,
        &installed,
    )?;
    for (project_id, store) in &projects {
        let all_rules: Vec<_> = global
            .rule_cards
            .iter()
            .chain(store.rule_cards.iter())
            .cloned()
            .collect();
        let all_skills: Vec<_> = global
            .skills
            .iter()
            .chain(store.skills.iter())
            .cloned()
            .collect();
        for config in latest_project_configs(&store.project_configs) {
            validate_project_refs(
                &config,
                &latest_profiles(&global.profiles),
                &all_rules,
                &all_skills,
                &installed,
            )?;
        }
        if project_id.trim().is_empty() {
            return Err("import contains empty projectId".into());
        }
    }
    let result = ImportResult {
        profiles: bundle.profiles.len(),
        rule_cards: bundle.rule_cards.len(),
        skills: bundle.skills.len(),
        project_configs: bundle.project_configs.len(),
        validation_errors: Vec::new(),
    };
    if preview {
        return Ok(result);
    }
    // Encrypt every new scope before replacing any file. If a later replace
    // fails, restore every earlier primary from its exact pre-import bytes.
    let mut writes = vec![(repo.global_path(), global)];
    for (project_id, store) in &projects {
        writes.push((repo.project_path(project_id), store.clone()));
    }
    repo.save_scopes_transaction(&writes)?;
    Ok(result)
}

pub(crate) fn snapshot_material(project_id: &str) -> Result<PersonalAgentSnapshotMaterial, String> {
    let repo = Repository::production()?;
    let global = repo.load_scope(&repo.global_path())?;
    let project = repo.load_scope(&repo.project_path(project_id))?;
    let project_config = project
        .project_configs
        .iter()
        .filter(|config| config.project_id == project_id)
        .max_by_key(|config| config.revision)
        .cloned()
        .ok_or_else(|| format!("project config not found: {project_id}"))?;
    let profiles = latest_profiles(&global.profiles);
    let mut all_rules = global.rule_cards.clone();
    all_rules.extend(
        project
            .rule_cards
            .into_iter()
            .filter(|rule| rule.project_id.as_deref() == Some(project_id)),
    );
    let rules = latest_rules(&all_rules);
    let mut all_skills = global.skills.clone();
    all_skills.extend(
        project
            .skills
            .into_iter()
            .filter(|skill| skill.project_id.as_deref() == Some(project_id)),
    );
    let skills = latest_skills(&all_skills);
    let installed = installed_skill_ids();
    validate_profile_refs(&profiles, &all_rules, &global.skills, &installed)?;
    validate_project_refs(
        &project_config,
        &profiles,
        &all_rules,
        &all_skills,
        &installed,
    )?;
    Ok(PersonalAgentSnapshotMaterial {
        profiles,
        rules,
        skills,
        project_config,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        std::env::temp_dir().join(format!("owllm-personal-agents-{}", uuid::Uuid::new_v4()))
    }

    fn repo() -> Repository {
        Repository { root: root() }
    }

    fn ts() -> String {
        "2026-07-24T00:00:00Z".into()
    }

    fn aid(n: u128) -> String {
        format!("agent:{}", uuid::Uuid::from_u128(n))
    }

    fn rid(n: u128) -> String {
        format!("rule:{}", uuid::Uuid::from_u128(n))
    }

    fn profile(id: &str) -> AgentProfileDoc {
        AgentProfileDoc {
            schema_version: 1,
            id: id.into(),
            revision: 1,
            display_name: "Agent".into(),
            identity: AgentIdentity {
                name: "Agent".into(),
                avatar: None,
                color: None,
            },
            role: "coder".into(),
            system_instructions: "Ship safely".into(),
            model: AgentModel::default(),
            allowed_tools: vec!["read_file".into(), "grep".into(), "shell".into()],
            memory_scope: "global".into(),
            delegation: DelegationPolicy {
                enabled: true,
                allowed_profile_ids: Vec::new(),
            },
            skill_ids: vec!["engineering-craft".into()],
            personal_skill_refs: Vec::new(),
            rule_card_refs: Vec::new(),
            created_at: ts(),
            updated_at: ts(),
        }
    }

    fn rule(id: &str, project: Option<&str>, private: bool) -> RuleCardDoc {
        RuleCardDoc {
            schema_version: 1,
            id: id.into(),
            revision: 1,
            kind: "constraint".into(),
            title: "Rule".into(),
            body: "Do not leak".into(),
            condition: None,
            scope: if project.is_some() {
                "project"
            } else {
                "global"
            }
            .into(),
            project_id: project.map(str::to_string),
            private,
            created_at: ts(),
            updated_at: ts(),
        }
    }

    fn personal_skill(
        id: &str,
        project: Option<&str>,
        status: &str,
        required_tools: Vec<String>,
    ) -> PersonalSkillDoc {
        PersonalSkillDoc {
            schema_version: 1,
            id: id.into(),
            revision: 1,
            name: "Focused skill".into(),
            purpose: "Verify a focused capability".into(),
            instructions: "Follow the input and output contracts.".into(),
            required_tools: required_tools.clone(),
            input_contract: "A short task string".into(),
            output_contract: "A concise result".into(),
            permission_boundary: SkillPermissionBoundary {
                allowed_tools: required_tools,
            },
            scope: if project.is_some() {
                "project".into()
            } else {
                "global".into()
            },
            project_id: project.map(str::to_string),
            private: true,
            status: status.into(),
            created_at: ts(),
            updated_at: ts(),
        }
    }

    fn project(project_id: &str, p: &AgentProfileDoc) -> ProjectAgentConfigDoc {
        ProjectAgentConfigDoc {
            schema_version: 1,
            project_id: project_id.into(),
            revision: 1,
            profile_refs: vec![RevisionRef {
                id: p.id.clone(),
                revision: p.revision,
            }],
            rule_card_refs: Vec::new(),
            profile_overrides: BTreeMap::new(),
            created_at: ts(),
            updated_at: ts(),
        }
    }

    #[test]
    fn defaults_precedence_and_provenance_are_deterministic() {
        let mut p = profile(&aid(1));
        let rule_v1 = rule(&rid(99), None, false);
        let mut rule_v2 = rule_v1.clone();
        rule_v2.revision = 2;
        rule_v2.body = "Project-selected revision".into();
        rule_v2.updated_at = "2026-07-24T00:01:00Z".into();
        p.rule_card_refs.push(RevisionRef {
            id: rule_v1.id.clone(),
            revision: 1,
        });
        let mut config = project("A", &p);
        config.rule_card_refs.push(RevisionRef {
            id: rule_v2.id.clone(),
            revision: 2,
        });
        config.profile_overrides.insert(
            p.id.clone(),
            AgentProfileOverride {
                system_instructions: Some("Project instructions".into()),
                model: Some(AgentModel {
                    provider: Some("openai".into()),
                    model_id: Some("gpt".into()),
                }),
                allowed_tools: Some(vec!["read_file".into(), "shell".into()]),
                memory_scope: Some("project".into()),
                ..AgentProfileOverride::default()
            },
        );
        let global = ScopeStore {
            profiles: vec![p.clone()],
            rule_cards: vec![rule_v1, rule_v2.clone()],
            ..ScopeStore::default()
        };
        let project_scope = ScopeStore {
            project_configs: vec![config],
            ..ScopeStore::default()
        };
        let effective = resolve_with("A", &p.id, &global, &project_scope).unwrap();
        assert_eq!(
            effective.profile.system_instructions,
            "Project instructions"
        );
        assert_eq!(effective.profile.allowed_tools, vec!["read_file", "shell"]);
        assert!(!effective
            .profile
            .allowed_tools
            .contains(&"grep".to_string()));
        assert_eq!(effective.profile.memory_scope, "project");
        assert_eq!(
            effective.provenance["systemInstructions"].source,
            "project-override"
        );
        assert_eq!(
            effective.provenance["allowedTools"].source,
            "project-override"
        );
        assert_eq!(effective.attached_rules.len(), 1);
        assert_eq!(effective.attached_rules[0].revision, 2);
        assert_eq!(
            effective.provenance[&format!("ruleCards.{}@2", rule_v2.id)].revision,
            2
        );
        assert!(!effective
            .provenance
            .contains_key(&format!("ruleCards.{}@1", rule_v2.id)));
        let wire = serde_json::to_value(&effective).unwrap();
        assert_eq!(wire["id"], p.id);
        assert!(wire.get("profile").is_none());
        assert!(wire.get("attachedRules").is_some());
        assert!(wire.get("attachedRuleCards").is_none());
    }

    #[test]
    fn delegation_intersects_and_cycles_fail_closed() {
        let mut a = profile(&aid(1));
        let mut b = profile(&aid(2));
        a.delegation.allowed_profile_ids = vec![b.id.clone()];
        b.delegation.allowed_profile_ids = vec![a.id.clone()];
        let mut config = project("A", &a);
        config.profile_overrides.insert(
            a.id.clone(),
            AgentProfileOverride {
                delegation: Some(DelegationOverride {
                    enabled: Some(true),
                    allowed_profile_ids: Some(vec![b.id.clone(), aid(3)]),
                }),
                ..AgentProfileOverride::default()
            },
        );
        let profile_id = a.id.clone();
        let effective = resolve_with(
            "A",
            &profile_id,
            &ScopeStore {
                profiles: vec![a, b],
                ..ScopeStore::default()
            },
            &ScopeStore {
                project_configs: vec![config],
                ..ScopeStore::default()
            },
        )
        .unwrap();
        assert!(!effective.profile.delegation.enabled);
        assert!(effective.profile.delegation.allowed_profile_ids.is_empty());
        assert!(effective
            .validation_errors
            .iter()
            .any(|e| e.contains("cycle")));
    }

    #[test]
    fn revisions_are_append_only_pins_remain_resolvable_and_conflicts_fail() {
        let repo = repo();
        let p1 = save_profile_with(&repo, profile(&aid(1)), None).unwrap();
        let mut edit = p1.clone();
        edit.display_name = "Agent v2".into();
        edit.updated_at = "2026-07-24T00:01:00Z".into();
        let p2 = save_profile_with(&repo, edit, Some(1)).unwrap();
        assert_eq!(p2.revision, 2);
        let global = repo.load_scope(&repo.global_path()).unwrap();
        assert!(pinned_profile(
            &global.profiles,
            &RevisionRef {
                id: p1.id.clone(),
                revision: 1
            }
        )
        .is_some());
        let conflict = save_profile_with(&repo, p2, Some(1)).unwrap_err();
        assert!(conflict.contains("conflict"));
        let _ = fs::remove_dir_all(repo.root);
    }

    #[test]
    fn stale_profile_and_project_revisions_do_not_lock_future_writes_or_imports() {
        let repo = repo();
        let mut stale = profile(&aid(11));
        stale.skill_ids = vec!["removed-skill".into()];
        let mut latest = stale.clone();
        latest.revision = 2;
        latest.skill_ids = vec!["engineering-craft".into()];
        latest.updated_at = "2026-07-24T00:02:00Z".into();
        repo.save_scope(
            &repo.global_path(),
            &ScopeStore {
                profiles: vec![stale, latest.clone()],
                ..ScopeStore::default()
            },
        )
        .unwrap();

        let mut edit = latest.clone();
        edit.display_name = "Latest remains writable".into();
        let saved = save_profile_with(&repo, edit, Some(2)).unwrap();
        assert_eq!(saved.revision, 3);

        let valid = project("A", &saved);
        let mut stale_config = valid.clone();
        stale_config.profile_overrides.insert(
            saved.id.clone(),
            AgentProfileOverride {
                skill_ids: Some(vec!["removed-skill".into()]),
                ..AgentProfileOverride::default()
            },
        );
        let mut latest_config = valid;
        latest_config.revision = 2;
        latest_config.updated_at = "2026-07-24T00:03:00Z".into();
        repo.save_scope(
            &repo.project_path("A"),
            &ScopeStore {
                project_configs: vec![stale_config, latest_config.clone()],
                ..ScopeStore::default()
            },
        )
        .unwrap();
        let preview = import_with(
            &repo,
            ExportBundle {
                schema_version: 1,
                profiles: Vec::new(),
                rule_cards: Vec::new(),
                skills: Vec::new(),
                project_configs: vec![latest_config],
            },
            Some("A"),
            true,
        )
        .unwrap();
        assert_eq!(preview.project_configs, 1);
        let _ = fs::remove_dir_all(repo.root);
    }

    #[test]
    fn private_project_rule_lookup_requires_the_owning_project() {
        let repo = repo();
        let private = save_rule_with(&repo, rule(&rid(44), Some("A"), true), None).unwrap();
        assert_eq!(
            get_rule_card_with(&repo, &private.id, None, "A")
                .unwrap()
                .id,
            private.id
        );
        assert!(get_rule_card_with(&repo, &private.id, None, "B")
            .unwrap_err()
            .contains("not found"));
        let _ = fs::remove_dir_all(repo.root);
    }

    #[test]
    fn v0_migrates_and_corrupt_primary_recovers_backup() {
        let repo = repo();
        let path = repo.global_path();
        let mut store = ScopeStore {
            schema_version: 0,
            profiles: vec![profile(&aid(1))],
            ..ScopeStore::default()
        };
        store.profiles[0].schema_version = 0;
        repo.save_scope(&path, &store).unwrap();
        // A second write creates the backup. Then corrupt the primary.
        repo.save_scope(&path, &store).unwrap();
        fs::write(&path, b"not-json").unwrap();
        let loaded = repo.load_scope(&path).unwrap();
        assert_eq!(loaded.schema_version, STORE_SCHEMA_VERSION);
        assert_eq!(loaded.profiles[0].schema_version, SCHEMA_VERSION);
        let _ = fs::remove_dir_all(repo.root);
    }

    #[test]
    fn restart_survival_and_project_isolation() {
        let repo = repo();
        let p = save_profile_with(&repo, profile(&aid(1)), None).unwrap();
        let pa = project("A", &p);
        let pb = project("B", &p);
        save_project_with(&repo, pa, None).unwrap();
        save_project_with(&repo, pb, None).unwrap();
        save_rule_with(&repo, rule(&rid(1), Some("A"), true), None).unwrap();
        drop(repo.clone());
        let reopened = Repository {
            root: repo.root.clone(),
        };
        let a = reopened.load_scope(&reopened.project_path("A")).unwrap();
        let b = reopened.load_scope(&reopened.project_path("B")).unwrap();
        assert_eq!(a.rule_cards.len(), 1);
        assert!(b.rule_cards.is_empty());
        assert_eq!(a.project_configs[0].project_id, "A");
        assert_eq!(b.project_configs[0].project_id, "B");
        let _ = fs::remove_dir_all(repo.root);
    }

    #[test]
    fn export_privacy_preview_and_import_validation_are_atomic() {
        let source_repo = repo();
        let mut p = profile(&aid(1));
        let private = rule(&rid(1), Some("A"), true);
        let private_global = rule(&rid(2), None, true);
        save_rule_with(&source_repo, private_global.clone(), None).unwrap();
        p.rule_card_refs.push(RevisionRef {
            id: private_global.id.clone(),
            revision: private_global.revision,
        });
        save_profile_with(&source_repo, p.clone(), None).unwrap();
        save_rule_with(&source_repo, private.clone(), None).unwrap();
        let mut project_doc = project("A", &p);
        let private_ref = RevisionRef {
            id: private.id.clone(),
            revision: private.revision,
        };
        project_doc.rule_card_refs.push(private_ref.clone());
        project_doc.profile_overrides.insert(
            p.id.clone(),
            AgentProfileOverride {
                rule_card_refs: Some(vec![private_ref]),
                ..AgentProfileOverride::default()
            },
        );
        save_project_with(&source_repo, project_doc, None).unwrap();
        let default_export = export_with(&source_repo, Some("A"), false).unwrap();
        assert!(!default_export.contains("Do not leak"));
        let public_bundle: ExportBundle = serde_json::from_str(&default_export).unwrap();
        assert!(public_bundle.profiles[0].rule_card_refs.is_empty());
        assert!(public_bundle.project_configs[0].rule_card_refs.is_empty());
        assert!(public_bundle.project_configs[0].profile_overrides[&p.id]
            .rule_card_refs
            .as_ref()
            .unwrap()
            .is_empty());
        let private_export = export_with(&source_repo, Some("A"), true).unwrap();
        assert!(private_export.contains("Do not leak"));

        let preview_repo = repo();
        let import_profile = profile(&aid(3));
        let bundle = ExportBundle {
            schema_version: 1,
            profiles: vec![import_profile.clone()],
            rule_cards: vec![private],
            skills: Vec::new(),
            project_configs: vec![project("A", &import_profile)],
        };
        let preview = import_with(&preview_repo, bundle.clone(), Some("A"), true).unwrap();
        assert_eq!(preview.project_configs, 1);
        assert!(!preview_repo.global_path().exists());

        let err = import_with(&preview_repo, bundle, Some("B"), false).unwrap_err();
        assert!(err.contains("does not match target project"));
        assert!(!preview_repo.global_path().exists());

        let public = rule(&rid(3), None, false);
        let ok = ExportBundle {
            schema_version: 1,
            profiles: vec![import_profile],
            rule_cards: vec![public],
            skills: Vec::new(),
            project_configs: Vec::new(),
        };
        let result = import_with(&preview_repo, ok, None, false).unwrap();
        assert_eq!(result.profiles, 1);
        let raw = fs::read(preview_repo.global_path()).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("Ship safely"));
        let _ = fs::remove_dir_all(source_repo.root);
        let _ = fs::remove_dir_all(preview_repo.root);
    }

    #[test]
    fn personal_skill_activation_rejects_unsafe_ids_and_tool_boundary_escape() {
        let mut unsafe_id = personal_skill("../escape", None, "active", vec![]);
        assert!(validate_skill_shape(&unsafe_id, true)
            .unwrap_err()
            .contains("personal__"));
        unsafe_id.id = "personal__browser".into();
        unsafe_id.required_tools = vec!["browser_click".into()];
        unsafe_id.permission_boundary.allowed_tools.clear();
        assert!(validate_skill_shape(&unsafe_id, true)
            .unwrap_err()
            .contains("outside permissionBoundary"));
        unsafe_id.permission_boundary.allowed_tools = vec!["browser_click".into()];
        assert!(validate_skill_shape(&unsafe_id, true).is_ok());
        let mut edit_skill = unsafe_id;
        edit_skill.required_tools = vec!["edit_file".into()];
        edit_skill.permission_boundary.allowed_tools = vec!["edit_file".into()];
        assert!(validate_skill_shape(&edit_skill, true).is_ok());
    }

    #[test]
    fn profile_save_rejects_attached_skill_when_required_tool_is_removed() {
        let repo = repo();
        let skill = save_skill_with(
            &repo,
            personal_skill(
                "personal__browser",
                None,
                "active",
                vec!["browser_snapshot".into()],
            ),
            None,
        )
        .unwrap();
        let mut agent = profile(&aid(20));
        agent.personal_skill_refs = vec![RevisionRef {
            id: skill.id.clone(),
            revision: skill.revision,
        }];
        assert!(save_profile_with(&repo, agent.clone(), None)
            .unwrap_err()
            .contains("does not allow required tools"));
        agent.allowed_tools = vec!["browser_snapshot".into()];
        assert!(save_profile_with(&repo, agent, None).is_ok());
        let _ = fs::remove_dir_all(repo.root);
    }

    #[test]
    fn incomplete_draft_validates_and_saves_but_same_document_cannot_activate() {
        let repo = repo();
        let mut draft = personal_skill("personal__draft", None, "draft", vec![]);
        draft.purpose.clear();
        draft.instructions.clear();
        draft.input_contract.clear();
        draft.output_contract.clear();
        assert!(skill_validation_errors(&draft, false).is_empty());
        assert!(save_skill_with(&repo, draft.clone(), None).is_ok());

        draft.status = "active".into();
        let errors = skill_validation_errors(&draft, true);
        assert!(errors
            .iter()
            .any(|error| error == "purpose is required before activation"));
        assert!(save_skill_with(&repo, draft, Some(1)).is_err());
        let _ = fs::remove_dir_all(repo.root);
    }

    #[test]
    fn export_uses_personal_skills_and_import_accepts_legacy_skills_alias() {
        let skill = personal_skill("personal__contract", None, "draft", vec![]);
        let bundle = ExportBundle {
            schema_version: EXPORT_SCHEMA_VERSION,
            profiles: Vec::new(),
            rule_cards: Vec::new(),
            skills: vec![skill.clone()],
            project_configs: Vec::new(),
        };
        let encoded = serde_json::to_value(&bundle).unwrap();
        assert_eq!(encoded["personalSkills"][0]["id"], skill.id);
        assert!(encoded.get("skills").is_none());

        let legacy = serde_json::json!({
            "schemaVersion": 1,
            "profiles": [],
            "ruleCards": [],
            "skills": [skill],
            "projectConfigs": []
        });
        let decoded: ExportBundle = serde_json::from_value(legacy).unwrap();
        assert_eq!(decoded.skills.len(), 1);
        assert_eq!(decoded.skills[0].id, "personal__contract");
    }

    #[test]
    fn private_project_skill_lookup_is_project_isolated() {
        let repo = repo();
        let skill = personal_skill("personal__private", Some("A"), "active", vec![]);
        save_skill_with(&repo, skill.clone(), None).unwrap();
        assert_eq!(
            get_skill_with(&repo, &skill.id, Some(1), "A").unwrap(),
            skill
        );
        assert!(get_skill_with(&repo, &skill.id, Some(1), "B").is_err());
        let _ = fs::remove_dir_all(repo.root);
    }

    #[test]
    fn private_skills_are_stripped_and_imported_active_skills_are_quarantined() {
        let repo = repo();
        let skill = personal_skill("personal__private_export", Some("A"), "active", vec![]);
        save_skill_with(&repo, skill.clone(), None).unwrap();
        let public_export: ExportBundle =
            serde_json::from_str(&export_with(&repo, Some("A"), false).unwrap()).unwrap();
        assert!(public_export.skills.is_empty());

        let mut bundle = ExportBundle {
            schema_version: EXPORT_SCHEMA_VERSION,
            profiles: Vec::new(),
            rule_cards: Vec::new(),
            skills: vec![personal_skill("personal__imported", None, "active", vec![])],
            project_configs: Vec::new(),
        };
        quarantine_imported_skills(&mut bundle);
        assert_eq!(bundle.skills[0].status, "quarantined");
        let _ = fs::remove_dir_all(repo.root);
    }

    #[test]
    fn lock_detects_concurrent_writer() {
        let repo = repo();
        let _guard = repo.lock().unwrap();
        let start = Instant::now();
        let err = repo.lock().err().expect("second lock must conflict");
        assert!(err.contains("busy"));
        assert!(start.elapsed() >= Duration::from_secs(5));
        let _ = fs::remove_dir_all(repo.root);
    }

    #[test]
    fn multi_scope_write_rolls_back_an_earlier_replacement() {
        let repo = repo();
        fs::create_dir_all(&repo.root).unwrap();
        let bad_parent = repo.root.join("not-a-directory");
        fs::write(&bad_parent, b"block directory creation").unwrap();
        let writes = vec![
            (
                repo.global_path(),
                ScopeStore {
                    profiles: vec![profile(&aid(1))],
                    ..ScopeStore::default()
                },
            ),
            (bad_parent.join("store.enc"), ScopeStore::default()),
        ];
        let error = repo.save_scopes_transaction(&writes).unwrap_err();
        assert!(error.contains("rolled back"));
        assert!(!repo.global_path().exists());
        let _ = fs::remove_dir_all(repo.root);
    }
}

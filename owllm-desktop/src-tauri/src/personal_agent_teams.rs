//! Persistent named personal-agent teams and immutable asynchronous run snapshots.
//!
//! Team definitions are append-only revisions.  Runs are single transactional
//! aggregates: state, immutable snapshot, event sequence, and idempotency
//! metadata are replaced atomically under one process lock.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use once_cell::sync::Lazy;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Manager;

use crate::personal_agents::{
    snapshot_material, AgentProfileDoc, PersonalSkillDoc, RevisionRef, RuleCardDoc,
};

const SCHEMA_VERSION: u32 = 1;
const DEFAULT_EVENT_DAYS: u32 = 30;
const MAX_EVENT_DAYS: u32 = 365;
const DEFAULT_OUTPUT_DAYS: u32 = 7;
const MAX_OUTPUT_DAYS: u32 = 90;
const MAX_HANDOFFS: u32 = 100;
const MAX_DEPTH: u32 = 10;
const MAX_PARALLEL: u32 = 16;
const MAX_RUNTIME_TOOL_STEPS: usize = 8;
const STORE_AAD: &[u8] = b"owllm-personal-agent-teams-v1";

static STORE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static ACTIVE_RUNS: Lazy<Mutex<BTreeMap<String, ActiveRunControl>>> =
    Lazy::new(|| Mutex::new(BTreeMap::new()));

#[derive(Clone)]
struct ActiveRunControl {
    abort: tokio::task::AbortHandle,
    finished: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersonalAgentTeamMember {
    pub member_id: String,
    pub profile_id: String,
    pub role: String,
    #[serde(default)]
    pub may_delegate_to_member_ids: Vec<String>,
    pub context_access: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DelegationBudget {
    pub max_handoffs: u32,
    pub max_depth: u32,
    pub max_parallel: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamContextPolicy {
    pub shared_enabled: bool,
    pub project_enabled: bool,
    pub private_enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamRetentionPolicy {
    #[serde(default = "default_event_days")]
    pub event_days: u32,
    #[serde(default = "default_output_days")]
    pub output_days: u32,
}

impl Default for TeamRetentionPolicy {
    fn default() -> Self {
        Self {
            event_days: DEFAULT_EVENT_DAYS,
            output_days: DEFAULT_OUTPUT_DAYS,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersonalAgentTeamDoc {
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub name: String,
    pub description: String,
    pub archived: bool,
    pub coordinator_profile_id: String,
    pub members: Vec<PersonalAgentTeamMember>,
    pub delegation_budget: DelegationBudget,
    pub context_policy: TeamContextPolicy,
    #[serde(default)]
    pub skill_refs: Vec<RevisionRef>,
    #[serde(default)]
    pub retention_policy: TeamRetentionPolicy,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamRef {
    pub id: String,
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfigRef {
    pub project_id: String,
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct SkillPin {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PinnedTeamAgent {
    pub member_id: String,
    pub role: String,
    pub context_access: String,
    pub may_delegate_to_member_ids: Vec<String>,
    pub profile_ref: RevisionRef,
    pub profile: AgentProfileDoc,
    pub rule_refs: Vec<RevisionRef>,
    #[serde(default)]
    pub rule_cards: Vec<RuleCardDoc>,
    pub skill_pins: Vec<SkillPin>,
    #[serde(default)]
    pub skill_instructions: Vec<String>,
    #[serde(default)]
    pub context_snapshot: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunSnapshot {
    pub schema_version: u32,
    pub snapshot_hash: String,
    pub team_ref: TeamRef,
    pub project_config_ref: ProjectConfigRef,
    pub agents: Vec<PinnedTeamAgent>,
    pub rule_refs: Vec<RevisionRef>,
    pub skill_pins: Vec<SkillPin>,
    pub delegation_budget: DelegationBudget,
    pub context_policy: TeamContextPolicy,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamRun {
    pub schema_version: u32,
    pub run_id: String,
    pub client_request_id: String,
    pub project_id: String,
    pub team_id: String,
    pub status: String,
    pub snapshot_hash: String,
    pub objective: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_of_run_id: Option<String>,
    pub last_event_seq: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersonalAgentTraceEvent {
    pub schema_version: u32,
    pub run_id: String,
    pub seq: u64,
    pub ts: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_member_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default)]
    pub applied_rule_refs: Vec<RevisionRef>,
    #[serde(default)]
    pub applied_skill_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunEventsPage {
    pub run_id: String,
    pub events: Vec<PersonalAgentTraceEvent>,
    pub next_after_seq: u64,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTeam {
    doc: PersonalAgentTeamDoc,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunAggregate {
    run: TeamRun,
    snapshot: TeamRunSnapshot,
    request_hash: String,
    #[serde(default)]
    retention_policy: TeamRetentionPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input: Option<Value>,
    #[serde(default)]
    events: Vec<PersonalAgentTraceEvent>,
    next_seq: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunCreateRequest {
    pub client_request_id: String,
    pub project_id: String,
    pub team_id: String,
    #[serde(default)]
    pub expected_team_revision: Option<u64>,
    pub objective: String,
    #[serde(default)]
    pub input: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunRecoverRequest {
    pub client_request_id: String,
    pub project_id: String,
    pub run_id: String,
    pub strategy: String,
    #[serde(default)]
    pub task_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamStore {
    #[serde(default = "schema_one")]
    schema_version: u32,
    #[serde(default)]
    teams: Vec<StoredTeam>,
    #[serde(default)]
    runs: Vec<RunAggregate>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamCipherEnvelope {
    schema_version: u32,
    nonce: String,
    ciphertext: String,
}

#[derive(Clone)]
struct TeamRepository {
    root: PathBuf,
}

fn schema_one() -> u32 {
    SCHEMA_VERSION
}
fn default_event_days() -> u32 {
    DEFAULT_EVENT_DAYS
}
fn default_output_days() -> u32 {
    DEFAULT_OUTPUT_DAYS
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn terminal(status: &str) -> bool {
    matches!(status, "succeeded" | "failed" | "cancelled")
}
fn hash_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn canonical_hash<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_vec(value)
        .map(|bytes| hash_bytes(&bytes))
        .map_err(|error| error.to_string())
}

impl TeamRepository {
    fn production() -> Result<Self, String> {
        Ok(Self {
            root: crate::paths::user_data_root()
                .ok_or_else(|| "personal-agent teams: user-data directory unavailable".to_string())?
                .join("personal-agent-teams"),
        })
    }

    fn path(&self) -> PathBuf {
        self.root.join("store.enc")
    }

    fn key_path(&self) -> PathBuf {
        self.root.join("data-key.bin")
    }

    fn data_key(&self) -> Result<[u8; 32], String> {
        if let Ok(wrapped) = fs::read(self.key_path()) {
            let raw = crate::crypt::unprotect(&wrapped)?;
            return raw
                .as_slice()
                .try_into()
                .map_err(|_| "personal-agent teams: invalid data-key length".to_string());
        }
        fs::create_dir_all(&self.root)
            .map_err(|error| format!("create personal-agent team root: {error}"))?;
        let mut raw = [0u8; 32];
        OsRng.fill_bytes(&mut raw);
        let wrapped = crate::crypt::protect(&raw)?;
        fs::write(self.key_path(), wrapped)
            .map_err(|error| format!("write personal-agent team key: {error}"))?;
        restrict_owner_only(&self.key_path())?;
        Ok(raw)
    }

    fn load(&self) -> Result<TeamStore, String> {
        let mut store = match fs::read(self.path()) {
            Ok(bytes) => {
                let envelope: TeamCipherEnvelope = serde_json::from_slice(&bytes)
                    .map_err(|error| format!("read personal-agent team envelope: {error}"))?;
                if envelope.schema_version != SCHEMA_VERSION {
                    return Err(format!(
                        "unsupported personal-agent team store schema {}",
                        envelope.schema_version
                    ));
                }
                let nonce = B64
                    .decode(envelope.nonce)
                    .map_err(|error| format!("decode team nonce: {error}"))?;
                let ciphertext = B64
                    .decode(envelope.ciphertext)
                    .map_err(|error| format!("decode team ciphertext: {error}"))?;
                if nonce.len() != 12 {
                    return Err("personal-agent team nonce has invalid length".into());
                }
                let key = self.data_key()?;
                let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
                let plain = cipher
                    .decrypt(
                        Nonce::from_slice(&nonce),
                        aes_gcm::aead::Payload {
                            msg: &ciphertext,
                            aad: STORE_AAD,
                        },
                    )
                    .map_err(|_| "personal-agent team store authentication failed".to_string())?;
                serde_json::from_slice(&plain)
                    .map_err(|error| format!("read personal-agent team store: {error}"))?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => TeamStore {
                schema_version: SCHEMA_VERSION,
                ..TeamStore::default()
            },
            Err(error) => return Err(format!("read personal-agent team store: {error}")),
        };
        if purge_store_retention(&mut store, chrono::Utc::now()) {
            self.save(&store)?;
        }
        Ok(store)
    }

    fn save(&self, store: &TeamStore) -> Result<(), String> {
        fs::create_dir_all(&self.root)
            .map_err(|error| format!("create personal-agent team root: {error}"))?;
        let mut persisted = store.clone();
        purge_store_retention(&mut persisted, chrono::Utc::now());
        let plain = serde_json::to_vec(&persisted).map_err(|error| error.to_string())?;
        let key = self.data_key()?;
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                aes_gcm::aead::Payload {
                    msg: &plain,
                    aad: STORE_AAD,
                },
            )
            .map_err(|_| "personal-agent team encryption failed".to_string())?;
        let bytes = serde_json::to_vec(&TeamCipherEnvelope {
            schema_version: SCHEMA_VERSION,
            nonce: B64.encode(nonce),
            ciphertext: B64.encode(ciphertext),
        })
        .map_err(|error| error.to_string())?;
        let tmp = self
            .root
            .join(format!(".store-{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&tmp, bytes).map_err(|error| format!("write team store temp: {error}"))?;
        restrict_owner_only(&tmp)?;
        let path = self.path();
        let backup = self.root.join("store.enc.bak");
        if path.exists() {
            let _ = fs::remove_file(&backup);
            fs::rename(&path, &backup)
                .map_err(|error| format!("backup personal-agent team store: {error}"))?;
        }
        fs::rename(&tmp, &path).map_err(|error| {
            let _ = fs::remove_file(&tmp);
            if backup.exists() {
                let _ = fs::rename(&backup, &path);
            }
            format!("replace team store: {error}")
        })?;
        restrict_owner_only(&path)
    }
}

#[cfg(unix)]
fn restrict_owner_only(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("restrict {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn restrict_owner_only(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 160 {
        Err(format!(
            "{label} must be non-empty and at most 160 characters"
        ))
    } else {
        Ok(())
    }
}

fn validate_team(doc: &PersonalAgentTeamDoc) -> Result<(), String> {
    if doc.schema_version != SCHEMA_VERSION || doc.revision == 0 {
        return Err("team schemaVersion must be 1 and revision positive".into());
    }
    validate_id(&doc.id, "team id")?;
    validate_id(&doc.name, "team name")?;
    validate_id(&doc.coordinator_profile_id, "coordinatorProfileId")?;
    let mut skill_ids = BTreeSet::new();
    for skill_ref in &doc.skill_refs {
        if !skill_ref.id.starts_with("personal__")
            || skill_ref.revision == 0
            || !skill_ids.insert(skill_ref.id.as_str())
        {
            return Err(
                "skillRefs must contain one positive personal__ revision per skill id".into(),
            );
        }
    }
    if doc.members.is_empty() {
        return Err("team must contain at least one member".into());
    }
    let member_ids: BTreeSet<_> = doc
        .members
        .iter()
        .map(|member| member.member_id.as_str())
        .collect();
    if member_ids.len() != doc.members.len() {
        return Err("memberId values must be unique".into());
    }
    let profile_ids: BTreeSet<_> = doc
        .members
        .iter()
        .map(|member| member.profile_id.as_str())
        .collect();
    if profile_ids.len() != doc.members.len() {
        return Err("a profile can appear only once in a team".into());
    }
    let coordinators: Vec<_> = doc
        .members
        .iter()
        .filter(|member| member.role == "coordinator")
        .collect();
    if coordinators.len() != 1 || coordinators[0].profile_id != doc.coordinator_profile_id {
        return Err("team must have exactly one coordinator matching coordinatorProfileId".into());
    }
    for member in &doc.members {
        validate_id(&member.member_id, "memberId")?;
        validate_id(&member.profile_id, "profileId")?;
        if !matches!(member.role.as_str(), "coordinator" | "specialist") {
            return Err("member role must be coordinator or specialist".into());
        }
        if !matches!(
            member.context_access.as_str(),
            "shared" | "project" | "private"
        ) {
            return Err("contextAccess must be shared, project, or private".into());
        }
        let context_allowed = match member.context_access.as_str() {
            "shared" => doc.context_policy.shared_enabled,
            "project" => doc.context_policy.project_enabled,
            "private" => doc.context_policy.private_enabled,
            _ => false,
        };
        if !context_allowed {
            return Err(format!(
                "{} context is disabled for member {}",
                member.context_access, member.member_id
            ));
        }
        if member.context_access == "private" && member.role != "coordinator" {
            return Err("only the coordinator may use private context".into());
        }
        let mut unique = BTreeSet::new();
        for target in &member.may_delegate_to_member_ids {
            if target == &member.member_id
                || !member_ids.contains(target.as_str())
                || !unique.insert(target)
            {
                return Err(format!(
                    "invalid delegation target {target} for {}",
                    member.member_id
                ));
            }
        }
    }
    let budget = &doc.delegation_budget;
    if budget.max_handoffs > MAX_HANDOFFS
        || budget.max_depth > MAX_DEPTH
        || budget.max_parallel == 0
        || budget.max_parallel > MAX_PARALLEL
    {
        return Err("delegationBudget exceeds supported bounds".into());
    }
    let retention = &doc.retention_policy;
    if retention.event_days == 0
        || retention.event_days > MAX_EVENT_DAYS
        || retention.output_days == 0
        || retention.output_days > MAX_OUTPUT_DAYS
    {
        return Err("retentionPolicy exceeds supported bounds".into());
    }
    chrono::DateTime::parse_from_rfc3339(&doc.created_at)
        .map_err(|_| "createdAt must be RFC3339".to_string())?;
    chrono::DateTime::parse_from_rfc3339(&doc.updated_at)
        .map_err(|_| "updatedAt must be RFC3339".to_string())?;
    Ok(())
}

fn runtime_tool_names() -> BTreeSet<&'static str> {
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
    ]
    .into_iter()
    .collect()
}

fn validate_execution_profile(profile: &AgentProfileDoc) -> Result<(), String> {
    let provider = profile
        .model
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("profile {} has no pinned provider", profile.id))?
        .to_ascii_lowercase();
    let model_id = profile
        .model
        .model_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("profile {} has no pinned modelId", profile.id))?;
    let unsupported_tools: Vec<_> = profile
        .allowed_tools
        .iter()
        .filter(|tool| !runtime_tool_names().contains(tool.as_str()))
        .cloned()
        .collect();
    if !unsupported_tools.is_empty() {
        return Err(format!(
            "profile {} allows tools unsupported by the personal-team runtime: {}",
            profile.id,
            unsupported_tools.join(", ")
        ));
    }
    let api_only_provider = matches!(
        provider.as_str(),
        "deepseek" | "xai" | "groq" | "perplexity" | "mistral" | "together"
    );
    if matches!(provider.as_str(), "local" | "tuned") || api_only_provider {
        return Ok(());
    }
    if matches!(
        provider.as_str(),
        "anthropic" | "openai" | "moonshot" | "kimi" | "gemini"
    ) && model_id.starts_with("api/")
    {
        return Ok(());
    }
    Err(format!(
        "profile {} selects a subscription CLI that cannot be both hard tool-restricted and actively cancelled; choose an API model or local model",
        profile.id
    ))
}

fn latest_team(store: &TeamStore, team_id: &str) -> Option<PersonalAgentTeamDoc> {
    store
        .teams
        .iter()
        .filter(|stored| stored.doc.id == team_id)
        .map(|stored| &stored.doc)
        .max_by_key(|doc| doc.revision)
        .cloned()
}

fn latest_teams(store: &TeamStore) -> Vec<PersonalAgentTeamDoc> {
    let mut latest = BTreeMap::<String, PersonalAgentTeamDoc>::new();
    for stored in &store.teams {
        if latest
            .get(&stored.doc.id)
            .is_none_or(|doc| doc.revision < stored.doc.revision)
        {
            latest.insert(stored.doc.id.clone(), stored.doc.clone());
        }
    }
    latest.into_values().collect()
}

fn filter_teams_for_profiles(
    teams: &mut Vec<PersonalAgentTeamDoc>,
    profile_ids: &BTreeSet<String>,
) {
    teams.retain(|team| {
        team.members
            .iter()
            .all(|member| profile_ids.contains(&member.profile_id))
    });
}

fn redact_value(value: &Value) -> Value {
    let mut out = Map::new();
    let values = match value {
        Value::Object(values) => values,
        _ => {
            let raw = value.to_string();
            out.insert(
                "valueSha256".into(),
                Value::String(hash_bytes(raw.as_bytes())),
            );
            out.insert("valueLen".into(), json!(raw.len()));
            return Value::Object(out);
        }
    };
    for (key, value) in values {
        let lower = key.to_ascii_lowercase();
        let sensitive = lower.contains("token")
            || lower.contains("password")
            || lower.contains("credential")
            || lower.contains("prompt")
            || lower.contains("memory")
            || lower.contains("private")
            || lower == "output"
            || lower == "error";
        if sensitive || value.is_array() || value.is_object() {
            let raw = value.to_string();
            out.insert(
                format!("{key}Sha256"),
                Value::String(hash_bytes(raw.as_bytes())),
            );
            out.insert(format!("{key}Len"), json!(raw.len()));
        } else {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}

fn append_event(
    aggregate: &mut RunAggregate,
    kind: &str,
    agent_member_id: Option<&str>,
    task_id: Option<&str>,
    rule_refs: Vec<RevisionRef>,
    skill_ids: Vec<String>,
    data: Value,
) {
    let redacted = redact_value(&data);
    let (handoff, output, error) = if kind == "delegation.created" {
        (Some(redacted), None, None)
    } else if kind == "task.failed" {
        (None, None, Some(redacted))
    } else if matches!(kind, "task.progress" | "task.output") {
        (None, Some(redacted), None)
    } else {
        (None, None, None)
    };
    let event = PersonalAgentTraceEvent {
        schema_version: SCHEMA_VERSION,
        run_id: aggregate.run.run_id.clone(),
        seq: aggregate.next_seq,
        ts: now(),
        kind: kind.into(),
        agent_member_id: agent_member_id.map(str::to_string),
        task_id: task_id.map(str::to_string),
        parent_task_id: None,
        status: Some(aggregate.run.status.clone()),
        applied_rule_refs: rule_refs,
        applied_skill_ids: skill_ids,
        handoff,
        output,
        error,
    };
    aggregate.run.last_event_seq = aggregate.next_seq;
    aggregate.next_seq += 1;
    aggregate.events.push(event);
}

fn retained_events(
    aggregate: &RunAggregate,
    at: chrono::DateTime<chrono::Utc>,
) -> Vec<PersonalAgentTraceEvent> {
    aggregate
        .events
        .iter()
        .filter_map(|event| {
            let timestamp = chrono::DateTime::parse_from_rfc3339(&event.ts)
                .ok()?
                .with_timezone(&chrono::Utc);
            let age = at.signed_duration_since(timestamp);
            if age.num_days() >= i64::from(aggregate.retention_policy.event_days) {
                return None;
            }
            let mut event = event.clone();
            if age.num_days() >= i64::from(aggregate.retention_policy.output_days) {
                event.output = None;
            }
            Some(event)
        })
        .collect()
}

fn purge_store_retention(store: &mut TeamStore, at: chrono::DateTime<chrono::Utc>) -> bool {
    let mut changed = false;
    for aggregate in &mut store.runs {
        aggregate.events.retain_mut(|event| {
            let Ok(timestamp) = chrono::DateTime::parse_from_rfc3339(&event.ts) else {
                return true;
            };
            let age = at.signed_duration_since(timestamp.with_timezone(&chrono::Utc));
            if age.num_days() >= i64::from(aggregate.retention_policy.event_days) {
                changed = true;
                return false;
            }
            if age.num_days() >= i64::from(aggregate.retention_policy.output_days)
                && event.output.take().is_some()
            {
                changed = true;
            }
            true
        });
    }
    changed
}

fn skill_material(skill_id: &str) -> Result<(SkillPin, String), String> {
    for root in crate::paths::skills_dirs_read() {
        let path = root.join(skill_id).join("SKILL.md");
        if let Ok(bytes) = fs::read(&path) {
            let body = String::from_utf8(bytes.clone())
                .map_err(|_| format!("skill is not UTF-8: {skill_id}"))?;
            return Ok((
                SkillPin {
                    id: skill_id.to_string(),
                    revision: None,
                    sha256: hash_bytes(&bytes),
                },
                body,
            ));
        }
    }
    Err(format!("installed skill not found: {skill_id}"))
}

fn personal_skill_material(
    skills: &[PersonalSkillDoc],
    reference: &RevisionRef,
    project_id: &str,
    allowed_tools: &BTreeSet<&str>,
) -> Result<(SkillPin, String), String> {
    let skill = skills
        .iter()
        .find(|skill| skill.id == reference.id && skill.revision == reference.revision)
        .ok_or_else(|| {
            format!(
                "pinned personal skill not found: {}@{}",
                reference.id, reference.revision
            )
        })?;
    if skill.status != "active" {
        return Err(format!(
            "personal skill {}@{} is not active ({})",
            reference.id, reference.revision, skill.status
        ));
    }
    if skill.scope == "project" && skill.project_id.as_deref() != Some(project_id) {
        return Err(format!(
            "personal skill {}@{} is not accessible from this project",
            reference.id, reference.revision
        ));
    }
    let missing_tools: Vec<_> = skill
        .required_tools
        .iter()
        .filter(|tool| !allowed_tools.contains(tool.as_str()))
        .cloned()
        .collect();
    if !missing_tools.is_empty() {
        return Err(format!(
            "personal skill {}@{} requires tools not allowed by this profile: {}",
            reference.id,
            reference.revision,
            missing_tools.join(", ")
        ));
    }
    let bytes = serde_json::to_vec(skill).map_err(|error| error.to_string())?;
    let instructions = format!(
        "# {}\n\nPurpose: {}\n\nInput contract:\n{}\n\nOutput contract:\n{}\n\nInstructions:\n{}",
        skill.name, skill.purpose, skill.input_contract, skill.output_contract, skill.instructions
    );
    Ok((
        SkillPin {
            id: skill.id.clone(),
            revision: Some(skill.revision),
            sha256: hash_bytes(&bytes),
        },
        instructions,
    ))
}

fn exact_rule<'a>(rules: &'a [RuleCardDoc], reference: &RevisionRef) -> Option<&'a RuleCardDoc> {
    rules
        .iter()
        .find(|rule| rule.id == reference.id && rule.revision == reference.revision)
}

fn apply_override(
    profile: &mut AgentProfileDoc,
    override_doc: Option<&crate::personal_agents::AgentProfileOverride>,
) {
    let Some(override_doc) = override_doc else {
        return;
    };
    if let Some(value) = &override_doc.system_instructions {
        profile.system_instructions = value.clone();
    }
    if let Some(value) = &override_doc.model {
        profile.model = value.clone();
    }
    if let Some(value) = &override_doc.allowed_tools {
        let allowed: BTreeSet<_> = value.iter().collect();
        profile.allowed_tools.retain(|tool| allowed.contains(tool));
    }
    if let Some(value) = &override_doc.memory_scope {
        profile.memory_scope = value.clone();
    }
    if let Some(value) = &override_doc.delegation {
        if let Some(enabled) = value.enabled {
            profile.delegation.enabled = profile.delegation.enabled && enabled;
        }
        if let Some(ids) = &value.allowed_profile_ids {
            let allowed: BTreeSet<_> = ids.iter().collect();
            profile
                .delegation
                .allowed_profile_ids
                .retain(|id| allowed.contains(id));
        }
    }
    if let Some(value) = &override_doc.skill_ids {
        profile.skill_ids = value.clone();
    }
    if let Some(value) = &override_doc.personal_skill_refs {
        profile.personal_skill_refs = value.clone();
    }
    if let Some(value) = &override_doc.rule_card_refs {
        profile.rule_card_refs = value.clone();
    }
}

fn build_snapshot(
    team: &PersonalAgentTeamDoc,
    project_id: &str,
) -> Result<TeamRunSnapshot, String> {
    let material = snapshot_material(project_id)?;
    let profiles: BTreeMap<_, _> = material
        .profiles
        .iter()
        .map(|profile| (profile.id.as_str(), profile))
        .collect();
    let mut agents = Vec::new();
    let mut all_rule_refs = BTreeMap::<String, RevisionRef>::new();
    let mut all_skill_pins = BTreeMap::<String, SkillPin>::new();
    for member in &team.members {
        let mut profile = profiles
            .get(member.profile_id.as_str())
            .ok_or_else(|| format!("latest profile not found: {}", member.profile_id))?
            .to_owned()
            .clone();
        apply_override(
            &mut profile,
            material
                .project_config
                .profile_overrides
                .get(&member.profile_id),
        );
        validate_execution_profile(&profile)?;
        if !member.may_delegate_to_member_ids.is_empty() && !profile.delegation.enabled {
            return Err(format!(
                "profile {} is not allowed to delegate",
                member.profile_id
            ));
        }
        for target_member_id in &member.may_delegate_to_member_ids {
            let target_profile_id = team
                .members
                .iter()
                .find(|candidate| candidate.member_id == *target_member_id)
                .map(|candidate| candidate.profile_id.as_str())
                .ok_or_else(|| format!("delegation target not found: {target_member_id}"))?;
            if !profile
                .delegation
                .allowed_profile_ids
                .iter()
                .any(|allowed| allowed == target_profile_id)
            {
                return Err(format!(
                    "profile {} may not delegate to profile {}",
                    member.profile_id, target_profile_id
                ));
            }
        }
        let mut rule_refs = BTreeMap::<String, RevisionRef>::new();
        for reference in profile
            .rule_card_refs
            .iter()
            .chain(material.project_config.rule_card_refs.iter())
        {
            let rule = exact_rule(&material.rules, reference).ok_or_else(|| {
                format!(
                    "pinned rule not found: {}@{}",
                    reference.id, reference.revision
                )
            })?;
            if rule.private
                && (rule.project_id.as_deref() != Some(project_id)
                    || member.context_access != "private"
                    || !team.context_policy.private_enabled)
            {
                continue;
            }
            rule_refs.insert(reference.id.clone(), reference.clone());
        }
        let mut skill_materials = Vec::new();
        for id in &profile.skill_ids {
            let (pin, instructions) = skill_material(id)?;
            all_skill_pins.insert(pin.id.clone(), pin.clone());
            skill_materials.push((pin, instructions));
        }
        let mut personal_refs = BTreeMap::<String, RevisionRef>::new();
        for reference in profile
            .personal_skill_refs
            .iter()
            .chain(team.skill_refs.iter())
        {
            personal_refs.insert(reference.id.clone(), reference.clone());
        }
        for reference in personal_refs.into_values() {
            let allowed_tools: BTreeSet<_> =
                profile.allowed_tools.iter().map(String::as_str).collect();
            let (pin, instructions) =
                personal_skill_material(&material.skills, &reference, project_id, &allowed_tools)?;
            all_skill_pins.insert(pin.id.clone(), pin.clone());
            skill_materials.push((pin, instructions));
        }
        skill_materials.sort_by(|left, right| left.0.cmp(&right.0));
        let (pins, skill_instructions): (Vec<_>, Vec<_>) = skill_materials.into_iter().unzip();
        for reference in rule_refs.values() {
            all_rule_refs.insert(reference.id.clone(), reference.clone());
        }
        let profile_id = profile.id.clone();
        let context_snapshot = crate::memory::personal_agent_context_snapshot(
            project_id,
            &profile_id,
            match member.context_access.as_str() {
                "shared" => team.context_policy.shared_enabled,
                "project" => team.context_policy.project_enabled,
                "private" => team.context_policy.project_enabled,
                _ => false,
            },
            member.context_access == "private" && team.context_policy.private_enabled,
        )?;
        agents.push(PinnedTeamAgent {
            member_id: member.member_id.clone(),
            role: member.role.clone(),
            context_access: member.context_access.clone(),
            may_delegate_to_member_ids: member.may_delegate_to_member_ids.clone(),
            profile_ref: RevisionRef {
                id: profile.id.clone(),
                revision: profile.revision,
            },
            profile,
            rule_cards: rule_refs
                .values()
                .filter_map(|reference| {
                    material
                        .rules
                        .iter()
                        .find(|rule| rule.id == reference.id && rule.revision == reference.revision)
                        .cloned()
                })
                .collect(),
            rule_refs: rule_refs.into_values().collect(),
            skill_pins: pins,
            skill_instructions,
            context_snapshot,
        });
    }
    agents.sort_by(|left, right| left.member_id.cmp(&right.member_id));
    let mut snapshot = TeamRunSnapshot {
        schema_version: SCHEMA_VERSION,
        snapshot_hash: String::new(),
        team_ref: TeamRef {
            id: team.id.clone(),
            revision: team.revision,
        },
        project_config_ref: ProjectConfigRef {
            project_id: project_id.to_string(),
            revision: material.project_config.revision,
        },
        agents,
        rule_refs: all_rule_refs.into_values().collect(),
        skill_pins: all_skill_pins.into_values().collect(),
        delegation_budget: team.delegation_budget.clone(),
        context_policy: team.context_policy.clone(),
        created_at: now(),
    };
    let mut hash_value = serde_json::to_value(&snapshot).map_err(|error| error.to_string())?;
    if let Value::Object(map) = &mut hash_value {
        map.remove("snapshotHash");
    }
    snapshot.snapshot_hash = canonical_hash(&hash_value)?;
    Ok(snapshot)
}

#[derive(Clone)]
struct ModelCall {
    app: Option<tauri::AppHandle>,
    agent: PinnedTeamAgent,
    system_prompt: String,
    user_message: String,
}

type ModelFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;

trait ModelExecutor: Send + Sync {
    fn execute(&self, call: ModelCall) -> ModelFuture;
}

struct RuntimeModelExecutor;

fn bare_model_id(model_id: &str) -> (&str, bool) {
    if let Some(value) = model_id.strip_prefix("api/") {
        (value, true)
    } else if let Some(value) = model_id.strip_prefix("sub/") {
        (value, false)
    } else {
        (model_id, false)
    }
}

async fn openai_compatible_completion(
    url: &str,
    key_name: Option<&str>,
    model: &str,
    system_prompt: &str,
    user_message: &str,
) -> Result<String, String> {
    let mut request = reqwest::Client::new().post(url).json(&json!({
        "model": model,
        "stream": false,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message}
        ]
    }));
    if let Some(key_name) = key_name {
        let key = crate::accounts::accounts_get_secret(key_name.to_string())
            .ok_or_else(|| format!("{key_name} is not configured"))?;
        request = request.bearer_auth(key);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("model endpoint returned {status}: {body}"));
    }
    body.pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "model response did not contain assistant content".to_string())
}

async fn anthropic_api_completion(
    model: &str,
    system_prompt: &str,
    user_message: &str,
) -> Result<String, String> {
    let key = crate::accounts::accounts_get_secret("ANTHROPIC_API_KEY".into())
        .ok_or_else(|| "ANTHROPIC_API_KEY is not configured".to_string())?;
    let response = reqwest::Client::new()
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&json!({
            "model": model,
            "max_tokens": 4096,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_message}]
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("Anthropic returned {status}: {body}"));
    }
    body.pointer("/content/0/text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Anthropic response did not contain assistant content".to_string())
}

async fn gemini_api_completion(
    model: &str,
    system_prompt: &str,
    user_message: &str,
) -> Result<String, String> {
    let key = crate::accounts::accounts_get_secret("GEMINI_API_KEY".into())
        .ok_or_else(|| "GEMINI_API_KEY is not configured".to_string())?;
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
    );
    let response = reqwest::Client::new()
        .post(url)
        .json(&json!({
            "system_instruction": {"parts": [{"text": system_prompt}]},
            "contents": [{"role": "user", "parts": [{"text": user_message}]}]
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("Gemini returned {status}: {body}"));
    }
    body.pointer("/candidates/0/content/parts/0/text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Gemini response did not contain assistant content".to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeToolEnvelope {
    tool_call: RuntimeToolCall,
}

#[derive(Deserialize)]
struct RuntimeToolCall {
    name: String,
    #[serde(default)]
    arguments: Value,
}

fn parse_runtime_tool_call(text: &str) -> Result<Option<RuntimeToolCall>, String> {
    let trimmed = text.trim();
    let json_text = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|value| value.strip_suffix("```"))
        .map(str::trim)
        .unwrap_or(trimmed);
    if !json_text.contains("\"toolCall\"") {
        return Ok(None);
    }
    serde_json::from_str::<RuntimeToolEnvelope>(json_text)
        .map(|envelope| Some(envelope.tool_call))
        .map_err(|error| format!("model returned a malformed tool call: {error}"))
}

fn tool_arg_str<'a>(arguments: &'a Value, name: &str) -> Result<&'a str, String> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("tool argument {name} must be a string"))
}

fn tool_arg_u64(arguments: &Value, name: &str) -> Result<u64, String> {
    arguments
        .get(name)
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|raw| raw.parse().ok()))
        })
        .ok_or_else(|| format!("tool argument {name} must be an unsigned integer"))
}

fn browser_params(arguments: &Value) -> Value {
    arguments
        .as_object()
        .cloned()
        .map(Value::Object)
        .unwrap_or_else(|| json!({}))
}

fn execute_runtime_tool(app: tauri::AppHandle, call: &RuntimeToolCall) -> Result<String, String> {
    let args = browser_params(&call.arguments);
    match call.name.as_str() {
        "browser_open" => crate::browser::browser_open_tab(
            app,
            tool_arg_str(&args, "url")?.to_string(),
            args.get("activate").and_then(Value::as_bool),
        ),
        "browser_tabs" => crate::browser::browser_list_tabs(app),
        "browser_tab_select" => {
            crate::browser::browser_select_tab(app, tool_arg_u64(&args, "tab_id")?)
        }
        "browser_tab_close" => {
            crate::browser::browser_close_tab(app, tool_arg_u64(&args, "tab_id")?)
        }
        "browser_device" => {
            crate::browser::browser_set_device(app, tool_arg_str(&args, "device")?.to_string())
        }
        "browser_close" => crate::browser::browser_stop(app),
        "browser_navigate" => {
            let url = tool_arg_str(&args, "url")?.to_string();
            let mut params = args;
            if let Value::Object(map) = &mut params {
                map.insert("url".into(), Value::String(url));
            }
            crate::browser::browser_cmd(app, "navigate".into(), params)
        }
        "browser_snapshot" => crate::browser::browser_cmd(app, "snapshot".into(), args),
        "browser_click" => crate::browser::browser_cmd(app, "click".into(), args),
        "browser_fill" => crate::browser::browser_cmd(app, "fill".into(), args),
        "browser_press" => crate::browser::browser_cmd(app, "press".into(), args),
        "browser_scroll" => crate::browser::browser_cmd(app, "scroll".into(), args),
        "browser_select" => crate::browser::browser_cmd(app, "select".into(), args),
        "browser_screenshot" => crate::browser::browser_cmd(app, "screenshot".into(), args),
        "browser_get_text" => crate::browser::browser_cmd(app, "get_text".into(), args),
        "browser_back" => crate::browser::browser_cmd(app, "back".into(), args),
        "browser_reload" => crate::browser::browser_cmd(app, "reload".into(), args),
        other => Err(format!(
            "personal-team runtime tool is not supported: {other}"
        )),
    }
}

fn runtime_tool_protocol(allowed_tools: &[String]) -> String {
    if allowed_tools.is_empty() {
        return String::new();
    }
    format!(
        "\n\nYou may call ONLY these runtime tools: {}.\n\
         To call one, respond with exactly one JSON object and no prose:\n\
         {{\"toolCall\":{{\"name\":\"browser_snapshot\",\"arguments\":{{\"tab_id\":1}}}}}}\n\
         The application will return the tool result and ask you to continue. \
         Otherwise, respond normally with the final answer.",
        allowed_tools.join(", ")
    )
}

async fn runtime_model_completion(
    call: &ModelCall,
    system_prompt: &str,
    user_message: &str,
) -> Result<String, String> {
    let provider = call
        .agent
        .profile
        .model
        .provider
        .as_deref()
        .unwrap_or("local")
        .to_ascii_lowercase();
    let configured_model = call
        .agent
        .profile
        .model
        .model_id
        .as_deref()
        .ok_or_else(|| format!("profile {} has no pinned modelId", call.agent.profile.id))?;
    let (model, force_api) = bare_model_id(configured_model);
    match provider.as_str() {
        "local" | "tuned" => {
            let app = call
                .app
                .clone()
                .ok_or_else(|| "runtime AppHandle is unavailable".to_string())?;
            let status =
                crate::server::server_status(app.state::<crate::server::ServerState>()).await?;
            if !status.running {
                return Err("the pinned local model server is not running".into());
            }
            if status.model_id.as_deref() != Some(model) {
                return Err(format!(
                    "pinned local model {model} is not active (active: {})",
                    status.model_id.as_deref().unwrap_or("none")
                ));
            }
            openai_compatible_completion(
                &format!(
                    "http://127.0.0.1:{}/v1/chat/completions",
                    status
                        .port
                        .ok_or_else(|| "local server has no port".to_string())?
                ),
                None,
                model,
                system_prompt,
                user_message,
            )
            .await
        }
        "anthropic" if force_api => {
            anthropic_api_completion(model, system_prompt, user_message).await
        }
        "anthropic" => Err("subscription CLI execution is disabled for personal teams because it cannot be actively cancelled".into()),
        "openai" if force_api => {
            openai_compatible_completion(
                "https://api.openai.com/v1/chat/completions",
                Some("OPENAI_API_KEY"),
                model,
                system_prompt,
                user_message,
            )
            .await
        }
        "openai" => Err("subscription CLI execution is disabled for personal teams because it cannot be actively cancelled".into()),
        "moonshot" | "kimi" if force_api => {
            openai_compatible_completion(
                "https://api.moonshot.ai/v1/chat/completions",
                Some("MOONSHOT_API_KEY"),
                model,
                system_prompt,
                user_message,
            )
            .await
        }
        "moonshot" | "kimi" => Err("subscription CLI execution is disabled for personal teams because it cannot be actively cancelled".into()),
        "gemini" if force_api => gemini_api_completion(model, system_prompt, user_message).await,
        "gemini" => Err("subscription CLI execution is disabled for personal teams because it cannot be actively cancelled".into()),
        "deepseek" => {
            openai_compatible_completion(
                "https://api.deepseek.com/v1/chat/completions",
                Some("DEEPSEEK_API_KEY"),
                model,
                system_prompt,
                user_message,
            )
            .await
        }
        "xai" => {
            openai_compatible_completion(
                "https://api.x.ai/v1/chat/completions",
                Some("XAI_API_KEY"),
                model,
                system_prompt,
                user_message,
            )
            .await
        }
        "groq" => {
            openai_compatible_completion(
                "https://api.groq.com/openai/v1/chat/completions",
                Some("GROQ_API_KEY"),
                model,
                system_prompt,
                user_message,
            )
            .await
        }
        "perplexity" => {
            openai_compatible_completion(
                "https://api.perplexity.ai/chat/completions",
                Some("PERPLEXITY_API_KEY"),
                model,
                system_prompt,
                user_message,
            )
            .await
        }
        "mistral" => {
            openai_compatible_completion(
                "https://api.mistral.ai/v1/chat/completions",
                Some("MISTRAL_API_KEY"),
                model,
                system_prompt,
                user_message,
            )
            .await
        }
        "together" => {
            openai_compatible_completion(
                "https://api.together.xyz/v1/chat/completions",
                Some("TOGETHER_API_KEY"),
                model,
                system_prompt,
                user_message,
            )
            .await
        }
        other => Err(format!("unsupported pinned model provider: {other}")),
    }
}

impl ModelExecutor for RuntimeModelExecutor {
    fn execute(&self, call: ModelCall) -> ModelFuture {
        Box::pin(async move {
            let allowed_tools = call
                .agent
                .profile
                .allowed_tools
                .iter()
                .filter(|tool| runtime_tool_names().contains(tool.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            let system_prompt = format!(
                "{}{}",
                call.system_prompt,
                runtime_tool_protocol(&allowed_tools)
            );
            let mut conversation = call.user_message.clone();
            for step in 0..=MAX_RUNTIME_TOOL_STEPS {
                let reply = runtime_model_completion(&call, &system_prompt, &conversation).await?;
                let Some(tool_call) = parse_runtime_tool_call(&reply)? else {
                    return Ok(reply);
                };
                if step == MAX_RUNTIME_TOOL_STEPS {
                    return Err(format!(
                        "personal-team runtime exceeded {MAX_RUNTIME_TOOL_STEPS} tool calls"
                    ));
                }
                if !allowed_tools.iter().any(|tool| tool == &tool_call.name) {
                    return Err(format!(
                        "agent {} attempted unauthorized tool {}",
                        call.agent.profile.id, tool_call.name
                    ));
                }
                let app = call
                    .app
                    .clone()
                    .ok_or_else(|| "runtime AppHandle is unavailable".to_string())?;
                let tool_result = execute_runtime_tool(app, &tool_call)?;
                conversation.push_str(&format!(
                    "\n\nAssistant requested tool:\n{}\n\nTool result for {}:\n{}\n\nContinue the task. Call another authorized tool if needed, otherwise return the final answer.",
                    reply,
                    tool_call.name,
                    tool_result.chars().take(8_000).collect::<String>()
                ));
            }
            Err("personal-team runtime tool loop ended unexpectedly".into())
        })
    }
}

fn agent_system_prompt(agent: &PinnedTeamAgent, context_policy: &TeamContextPolicy) -> String {
    let rules = agent
        .rule_cards
        .iter()
        .map(|rule| format!("- {}@{}: {}", rule.id, rule.revision, rule.body))
        .collect::<Vec<_>>()
        .join("\n");
    let skills = agent
        .skill_pins
        .iter()
        .zip(agent.skill_instructions.iter())
        .map(|(pin, body)| {
            let revision = pin
                .revision
                .map(|revision| format!("@{revision}"))
                .unwrap_or_default();
            format!("## {}{} ({})\n{}", pin.id, revision, pin.sha256, body)
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let context = agent
        .context_snapshot
        .iter()
        .map(|entry| format!("- {entry}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "You are {}. Role: {}.\n{}\n\nAllowed tools (deny all others): {}\n\nPinned rule cards:\n{}\n\nPinned skills:\n{}\n\nPinned context snapshot:\n{}\n\nContext policy: shared={}, project={}, private={}. Never expose private rule or memory contents in diagnostics.",
        agent.profile.identity.name,
        agent.profile.role,
        agent.profile.system_instructions,
        agent.profile.allowed_tools.join(", "),
        rules,
        skills,
        context,
        context_policy.shared_enabled,
        context_policy.project_enabled,
        context_policy.private_enabled
    )
}

fn safe_output(agent: &PinnedTeamAgent, text: &str) -> String {
    let mut value = text.chars().take(20_000).collect::<String>();
    for secret in agent
        .rule_cards
        .iter()
        .filter(|rule| rule.private)
        .map(|rule| rule.body.as_str())
        .chain(std::iter::once(agent.profile.system_instructions.as_str()))
        .chain(agent.skill_instructions.iter().map(String::as_str))
        .chain(agent.context_snapshot.iter().map(String::as_str))
    {
        if !secret.is_empty() {
            value = value.replace(secret, "[redacted]");
        }
    }
    value
}

fn trace_output(agent: &PinnedTeamAgent, text: &str) -> Value {
    if agent.context_access == "private" {
        json!({
            "redacted": true,
            "len": text.len(),
            "sha256": hash_bytes(text.as_bytes())
        })
    } else {
        json!({"text": safe_output(agent, text)})
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanAssignment {
    member_id: String,
    task: String,
}

#[derive(Deserialize)]
struct CoordinatorPlan {
    #[serde(default)]
    assignments: Vec<PlanAssignment>,
}

fn parse_coordinator_plan(text: &str) -> Result<CoordinatorPlan, String> {
    let start = text
        .find('{')
        .ok_or_else(|| "coordinator plan did not contain JSON".to_string())?;
    let end = text
        .rfind('}')
        .ok_or_else(|| "coordinator plan did not contain complete JSON".to_string())?;
    serde_json::from_str(&text[start..=end])
        .map_err(|error| format!("invalid coordinator plan JSON: {error}"))
}

fn with_run_mut<T>(
    repo: &TeamRepository,
    run_id: &str,
    mutate: impl FnOnce(&mut RunAggregate) -> Result<T, String>,
) -> Result<T, String> {
    let _lock = STORE_LOCK.lock().map_err(|_| "team store lock poisoned")?;
    let mut store = repo.load()?;
    let aggregate = store
        .runs
        .iter_mut()
        .find(|aggregate| aggregate.run.run_id == run_id)
        .ok_or_else(|| format!("run not found: {run_id}"))?;
    let result = mutate(aggregate)?;
    repo.save(&store)?;
    Ok(result)
}

fn mark_run_failed(repo: &TeamRepository, run_id: &str, error: &str) -> Result<(), String> {
    with_run_mut(repo, run_id, |aggregate| {
        if terminal(&aggregate.run.status) || aggregate.run.status == "cancelling" {
            return Ok(());
        }
        aggregate.run.status = "failed".into();
        aggregate.run.finished_at = Some(now());
        append_event(
            aggregate,
            "task.failed",
            None,
            None,
            vec![],
            vec![],
            json!({"error": error}),
        );
        append_event(
            aggregate,
            "run.failed",
            None,
            None,
            vec![],
            vec![],
            json!({}),
        );
        Ok(())
    })
}

fn execute_run(
    repo: TeamRepository,
    run_id: String,
    app: tauri::AppHandle,
    executor: Arc<dyn ModelExecutor>,
) {
    start_run(repo, run_id, Some(app), executor);
}

fn start_run(
    repo: TeamRepository,
    run_id: String,
    app: Option<tauri::AppHandle>,
    executor: Arc<dyn ModelExecutor>,
) {
    let worker_repo = repo.clone();
    let worker_run_id = run_id.clone();
    let worker = tauri::async_runtime::spawn(async move {
        execute_run_inner(&worker_repo, &worker_run_id, app, executor.as_ref()).await
    });
    let finished = Arc::new(AtomicBool::new(false));
    let notify = Arc::new(tokio::sync::Notify::new());
    match ACTIVE_RUNS.lock() {
        Ok(mut active) => {
            active.insert(
                run_id.clone(),
                ActiveRunControl {
                    abort: worker.inner().abort_handle(),
                    finished: finished.clone(),
                    notify: notify.clone(),
                },
            );
        }
        Err(_) => {
            worker.abort();
            let _ = mark_run_failed(&repo, &run_id, "active-run registry is unavailable");
            return;
        }
    }
    tauri::async_runtime::spawn(async move {
        match worker.await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let cancelling = repo
                    .load()
                    .ok()
                    .and_then(|store| {
                        store
                            .runs
                            .into_iter()
                            .find(|aggregate| aggregate.run.run_id == run_id)
                    })
                    .is_some_and(|aggregate| aggregate.run.status == "cancelling");
                if !cancelling {
                    let _ = mark_run_failed(&repo, &run_id, &error);
                }
            }
            Err(error) => {
                let cancelling = repo
                    .load()
                    .ok()
                    .and_then(|store| {
                        store
                            .runs
                            .into_iter()
                            .find(|aggregate| aggregate.run.run_id == run_id)
                    })
                    .is_some_and(|aggregate| aggregate.run.status == "cancelling");
                if !cancelling {
                    let _ = mark_run_failed(&repo, &run_id, &error.to_string());
                }
            }
        }
        finished.store(true, Ordering::Release);
        notify.notify_waiters();
        if let Ok(mut active) = ACTIVE_RUNS.lock() {
            active.remove(&run_id);
        }
    });
}

pub(crate) fn resume_pending(app: tauri::AppHandle) {
    let Ok(repo) = TeamRepository::production() else {
        return;
    };
    let queued = {
        let Ok(_lock) = STORE_LOCK.lock() else {
            return;
        };
        let Ok(mut store) = repo.load() else {
            return;
        };
        let mut queued = Vec::new();
        for aggregate in &mut store.runs {
            match aggregate.run.status.as_str() {
                "queued" => queued.push(aggregate.run.run_id.clone()),
                "running" => {
                    aggregate.run.status = "failed".into();
                    aggregate.run.finished_at = Some(now());
                    append_event(
                        aggregate,
                        "task.failed",
                        None,
                        None,
                        vec![],
                        vec![],
                        json!({"error": "app restarted during model execution"}),
                    );
                    append_event(
                        aggregate,
                        "run.failed",
                        None,
                        None,
                        vec![],
                        vec![],
                        json!({}),
                    );
                }
                "cancelling" => {
                    aggregate.run.status = "cancelled".into();
                    aggregate.run.finished_at = Some(now());
                    append_event(
                        aggregate,
                        "run.cancelled",
                        None,
                        None,
                        vec![],
                        vec![],
                        json!({}),
                    );
                }
                _ => {}
            }
        }
        if repo.save(&store).is_err() {
            return;
        }
        queued
    };
    for run_id in queued {
        execute_run(
            repo.clone(),
            run_id,
            app.clone(),
            Arc::new(RuntimeModelExecutor),
        );
    }
}

async fn execute_run_inner(
    repo: &TeamRepository,
    run_id: &str,
    app: Option<tauri::AppHandle>,
    executor: &dyn ModelExecutor,
) -> Result<(), String> {
    let (snapshot, objective, input, coordinator) = with_run_mut(repo, run_id, |aggregate| {
        if terminal(&aggregate.run.status) || aggregate.run.status == "cancelling" {
            return Err("run is already terminal or cancelling".into());
        }
        aggregate.run.status = "running".into();
        aggregate.run.started_at = Some(now());
        append_event(
            aggregate,
            "run.started",
            None,
            None,
            vec![],
            vec![],
            json!({}),
        );
        let coordinator = aggregate
            .snapshot
            .agents
            .iter()
            .find(|agent| agent.role == "coordinator")
            .cloned()
            .ok_or_else(|| "snapshot has no coordinator".to_string())?;
        Ok((
            aggregate.snapshot.clone(),
            aggregate.run.objective.clone(),
            aggregate.input.clone(),
            coordinator,
        ))
    })?;
    let coordinator_task = format!("task:{run_id}:coordinator");
    with_run_mut(repo, run_id, |aggregate| {
        if aggregate.run.status != "running" {
            return Err("run stopped before coordinator planning".into());
        }
        append_event(
            aggregate,
            "task.started",
            Some(&coordinator.member_id),
            Some(&coordinator_task),
            coordinator.rule_refs.clone(),
            coordinator
                .skill_pins
                .iter()
                .map(|pin| pin.id.clone())
                .collect(),
            json!({"phase": "planning"}),
        );
        Ok(())
    })?;
    let candidate_lines = snapshot
        .agents
        .iter()
        .filter(|agent| agent.role == "specialist")
        .map(|agent| format!("- {}: {}", agent.member_id, agent.profile.role))
        .collect::<Vec<_>>()
        .join("\n");
    let planning_prompt = format!(
        "Objective:\n{objective}\n\nInput:\n{}\n\nAvailable specialists:\n{candidate_lines}\n\nReturn ONLY JSON: {{\"assignments\":[{{\"memberId\":\"...\",\"task\":\"...\"}}]}}. Use only necessary specialists.",
        input.as_ref().map(Value::to_string).unwrap_or_default()
    );
    let planning_result = executor
        .execute(ModelCall {
            app: app.clone(),
            agent: coordinator.clone(),
            system_prompt: agent_system_prompt(&coordinator, &snapshot.context_policy),
            user_message: planning_prompt,
        })
        .await?;
    let allowed_targets: BTreeSet<_> = coordinator
        .may_delegate_to_member_ids
        .iter()
        .cloned()
        .collect();
    let mut assignments = match parse_coordinator_plan(&planning_result) {
        Ok(plan) => plan.assignments,
        Err(error) => {
            with_run_mut(repo, run_id, |aggregate| {
                if aggregate.run.status != "running" {
                    return Err("run cancelled during coordinator planning".into());
                }
                append_event(
                    aggregate,
                    "task.failed",
                    Some(&coordinator.member_id),
                    Some(&coordinator_task),
                    coordinator.rule_refs.clone(),
                    coordinator
                        .skill_pins
                        .iter()
                        .map(|pin| pin.id.clone())
                        .collect(),
                    json!({"error": error}),
                );
                append_event(
                    aggregate,
                    "recovery.started",
                    Some(&coordinator.member_id),
                    Some(&coordinator_task),
                    vec![],
                    vec![],
                    json!({"strategy": "coordinatorOnly"}),
                );
                Ok(())
            })?;
            Vec::new()
        }
    };
    let members: BTreeMap<_, _> = snapshot
        .agents
        .iter()
        .filter(|agent| agent.role == "specialist")
        .map(|agent| (agent.member_id.clone(), agent.clone()))
        .collect();
    let mut seen = BTreeSet::new();
    assignments.retain(|assignment| {
        !assignment.task.trim().is_empty()
            && allowed_targets.contains(&assignment.member_id)
            && members.contains_key(&assignment.member_id)
            && seen.insert(assignment.member_id.clone())
    });
    if snapshot.delegation_budget.max_depth == 0 {
        assignments.clear();
    }
    assignments.truncate(snapshot.delegation_budget.max_handoffs as usize);

    let mut specialist_outputs = Vec::<(PinnedTeamAgent, String)>::new();
    let max_parallel = snapshot.delegation_budget.max_parallel.max(1) as usize;
    for batch in assignments.chunks(max_parallel) {
        let mut calls = Vec::new();
        for (offset, assignment) in batch.iter().enumerate() {
            let specialist = members
                .get(&assignment.member_id)
                .cloned()
                .ok_or_else(|| "validated specialist disappeared".to_string())?;
            let task_id = format!("task:{run_id}:{}", specialist.member_id);
            with_run_mut(repo, run_id, |aggregate| {
                if aggregate.run.status != "running" {
                    return Err("run cancelled before delegation".into());
                }
                append_event(
                    aggregate,
                    "delegation.created",
                    Some(&coordinator.member_id),
                    Some(&task_id),
                    vec![],
                    vec![],
                    json!({"toMemberId": specialist.member_id, "depth": 1, "handoff": offset + 1}),
                );
                append_event(
                    aggregate,
                    "task.started",
                    Some(&specialist.member_id),
                    Some(&task_id),
                    specialist.rule_refs.clone(),
                    specialist
                        .skill_pins
                        .iter()
                        .map(|pin| pin.id.clone())
                        .collect(),
                    json!({"depth": 1}),
                );
                Ok(())
            })?;
            let call = ModelCall {
                app: app.clone(),
                agent: specialist.clone(),
                system_prompt: agent_system_prompt(&specialist, &snapshot.context_policy),
                user_message: format!(
                    "Team objective:\n{objective}\n\nYour assigned task:\n{}",
                    assignment.task
                ),
            };
            calls.push(async move { (specialist, executor.execute(call).await) });
        }
        for (specialist, first_result) in futures_util::future::join_all(calls).await {
            let task_id = format!("task:{run_id}:{}", specialist.member_id);
            let result = match first_result {
                Ok(output) => Ok(output),
                Err(first_error) => {
                    with_run_mut(repo, run_id, |aggregate| {
                        if aggregate.run.status != "running" {
                            return Err("run cancelled during specialist call".into());
                        }
                        append_event(
                            aggregate,
                            "task.failed",
                            Some(&specialist.member_id),
                            Some(&task_id),
                            specialist.rule_refs.clone(),
                            specialist
                                .skill_pins
                                .iter()
                                .map(|pin| pin.id.clone())
                                .collect(),
                            json!({"error": first_error}),
                        );
                        append_event(
                            aggregate,
                            "recovery.started",
                            Some(&specialist.member_id),
                            Some(&task_id),
                            vec![],
                            vec![],
                            json!({"attempt": 1}),
                        );
                        Ok(())
                    })?;
                    executor
                        .execute(ModelCall {
                            app: app.clone(),
                            agent: specialist.clone(),
                            system_prompt: agent_system_prompt(
                                &specialist,
                                &snapshot.context_policy,
                            ),
                            user_message: format!(
                                "Retry the assigned work for objective: {objective}. Return a concise result."
                            ),
                        })
                        .await
                }
            };
            let output = result.map_err(|error| {
                format!(
                    "specialist {} failed after recovery: {error}",
                    specialist.member_id
                )
            })?;
            if app.is_some() {
                let _ = crate::memory::agent_memory_append(
                    snapshot.project_config_ref.project_id.clone(),
                    specialist.profile.id.clone(),
                    "Personal-agent team delegated task".into(),
                    output.clone(),
                )
                .await;
            }
            let trace = trace_output(&specialist, &output);
            with_run_mut(repo, run_id, |aggregate| {
                if aggregate.run.status != "running" {
                    return Err("run cancelled during specialist call".into());
                }
                append_event(
                    aggregate,
                    "task.progress",
                    Some(&specialist.member_id),
                    Some(&task_id),
                    vec![],
                    vec![],
                    json!({"percent": 100}),
                );
                append_event(
                    aggregate,
                    "task.output",
                    Some(&specialist.member_id),
                    Some(&task_id),
                    specialist.rule_refs.clone(),
                    specialist
                        .skill_pins
                        .iter()
                        .map(|pin| pin.id.clone())
                        .collect(),
                    trace,
                );
                Ok(())
            })?;
            specialist_outputs.push((specialist, output));
        }
    }

    let synthesis_input = if specialist_outputs.is_empty() {
        format!(
            "Complete this objective directly without delegation:\n{objective}\n\nInput:\n{}",
            input.as_ref().map(Value::to_string).unwrap_or_default()
        )
    } else {
        format!(
            "Synthesize the final answer for objective:\n{objective}\n\nSpecialist results:\n{}",
            specialist_outputs
                .iter()
                .map(|(agent, output)| format!("## {}\n{}", agent.member_id, output))
                .collect::<Vec<_>>()
                .join("\n\n")
        )
    };
    let persist_memory = app.is_some();
    let final_output = executor
        .execute(ModelCall {
            app,
            agent: coordinator.clone(),
            system_prompt: agent_system_prompt(&coordinator, &snapshot.context_policy),
            user_message: synthesis_input,
        })
        .await?;
    if persist_memory {
        let _ = crate::memory::agent_memory_append(
            snapshot.project_config_ref.project_id.clone(),
            coordinator.profile.id.clone(),
            objective.clone(),
            final_output.clone(),
        )
        .await;
    }
    let trace = trace_output(&coordinator, &final_output);
    with_run_mut(repo, run_id, |aggregate| {
        if aggregate.run.status != "running" {
            return Err("run cancelled during coordinator synthesis".into());
        }
        append_event(
            aggregate,
            "task.output",
            Some(&coordinator.member_id),
            Some(&coordinator_task),
            coordinator.rule_refs.clone(),
            coordinator
                .skill_pins
                .iter()
                .map(|pin| pin.id.clone())
                .collect(),
            trace,
        );
        aggregate.run.status = "succeeded".into();
        aggregate.run.finished_at = Some(now());
        append_event(
            aggregate,
            "run.succeeded",
            Some(&coordinator.member_id),
            None,
            vec![],
            vec![],
            json!({}),
        );
        Ok(())
    })
}

fn create_run_with(
    repo: &TeamRepository,
    request: &TeamRunCreateRequest,
    recovery_of_run_id: Option<String>,
    snapshot_override: Option<TeamRunSnapshot>,
    idempotency_extra: Option<Value>,
) -> Result<(TeamRun, bool), String> {
    validate_id(&request.project_id, "projectId")?;
    validate_id(&request.client_request_id, "clientRequestId")?;
    if request.objective.trim().is_empty() || request.objective.len() > 100_000 {
        return Err("objective must be non-empty and at most 100000 characters".into());
    }
    let request_hash = canonical_hash(&json!({
        "request": request,
        "recoveryOfRunId": recovery_of_run_id,
        "recovery": idempotency_extra,
    }))?;
    let _lock = STORE_LOCK.lock().map_err(|_| "team store lock poisoned")?;
    let mut store = repo.load()?;
    if let Some(existing) = store.runs.iter().find(|aggregate| {
        aggregate.run.project_id == request.project_id
            && aggregate.run.client_request_id == request.client_request_id
    }) {
        if existing.request_hash == request_hash {
            return Ok((existing.run.clone(), false));
        }
        return Err("clientRequestId conflict: payload differs from original request".into());
    }
    let (snapshot, retention_policy) = match snapshot_override {
        Some(snapshot) => {
            let retention = latest_team(&store, &request.team_id)
                .map(|team| team.retention_policy)
                .unwrap_or_default();
            (snapshot, retention)
        }
        None => {
            let team = latest_team(&store, &request.team_id)
                .ok_or_else(|| format!("team not found: {}", request.team_id))?;
            if team.archived {
                return Err("archived team cannot start runs".into());
            }
            if request
                .expected_team_revision
                .is_some_and(|expected| expected != team.revision)
            {
                return Err(format!("team revision conflict at {}", team.revision));
            }
            let retention = team.retention_policy.clone();
            (build_snapshot(&team, &request.project_id)?, retention)
        }
    };
    let timestamp = now();
    let mut aggregate = RunAggregate {
        run: TeamRun {
            schema_version: SCHEMA_VERSION,
            run_id: format!("run:{}", uuid::Uuid::new_v4()),
            client_request_id: request.client_request_id.clone(),
            project_id: request.project_id.clone(),
            team_id: request.team_id.clone(),
            status: "queued".into(),
            snapshot_hash: snapshot.snapshot_hash.clone(),
            objective: request.objective.clone(),
            created_at: timestamp,
            started_at: None,
            finished_at: None,
            recovery_of_run_id,
            last_event_seq: 0,
        },
        snapshot,
        request_hash,
        retention_policy,
        input: request.input.clone(),
        events: Vec::new(),
        next_seq: 1,
    };
    append_event(
        &mut aggregate,
        "run.created",
        None,
        None,
        vec![],
        vec![],
        json!({}),
    );
    if aggregate.run.recovery_of_run_id.is_some() {
        let source_run_id = aggregate.run.recovery_of_run_id.clone();
        append_event(
            &mut aggregate,
            "recovery.started",
            None,
            None,
            vec![],
            vec![],
            json!({"sourceRunId": source_run_id}),
        );
    }
    let run = aggregate.run.clone();
    store.runs.push(aggregate);
    repo.save(&store)?;
    Ok((run, true))
}

#[tauri::command]
pub fn personal_agent_team_list(
    project_id: Option<String>,
    include_archived: Option<bool>,
) -> Result<Vec<PersonalAgentTeamDoc>, String> {
    let _lock = STORE_LOCK.lock().map_err(|_| "team store lock poisoned")?;
    let mut teams = latest_teams(&TeamRepository::production()?.load()?);
    if let Some(project_id) = project_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let material = snapshot_material(project_id)?;
        let allowed_profiles: BTreeSet<_> = material
            .profiles
            .iter()
            .map(|profile| profile.id.clone())
            .collect();
        filter_teams_for_profiles(&mut teams, &allowed_profiles);
    }
    if !include_archived.unwrap_or(false) {
        teams.retain(|team| !team.archived);
    }
    Ok(teams)
}

#[tauri::command]
pub fn personal_agent_team_get(
    team_id: String,
    revision: Option<u64>,
) -> Result<PersonalAgentTeamDoc, String> {
    let _lock = STORE_LOCK.lock().map_err(|_| "team store lock poisoned")?;
    let store = TeamRepository::production()?.load()?;
    store
        .teams
        .iter()
        .filter(|stored| {
            stored.doc.id == team_id
                && revision.is_none_or(|revision| stored.doc.revision == revision)
        })
        .map(|stored| &stored.doc)
        .max_by_key(|doc| doc.revision)
        .cloned()
        .ok_or_else(|| format!("team not found: {team_id}"))
}

#[tauri::command]
pub fn personal_agent_team_save(
    doc: PersonalAgentTeamDoc,
    expected_revision: Option<u64>,
) -> Result<PersonalAgentTeamDoc, String> {
    save_team_with(&TeamRepository::production()?, doc, expected_revision)
}

fn save_team_with(
    repo: &TeamRepository,
    mut doc: PersonalAgentTeamDoc,
    expected_revision: Option<u64>,
) -> Result<PersonalAgentTeamDoc, String> {
    validate_team(&doc)?;
    let _lock = STORE_LOCK.lock().map_err(|_| "team store lock poisoned")?;
    let mut store = repo.load()?;
    match latest_team(&store, &doc.id) {
        None if expected_revision.is_none() && doc.revision == 1 => {}
        None => return Err("new team must use revision 1 and no expectedRevision".into()),
        Some(previous) => {
            if expected_revision != Some(previous.revision) {
                return Err(format!("team revision conflict at {}", previous.revision));
            }
            doc.revision = previous.revision + 1;
            doc.created_at = previous.created_at;
        }
    }
    doc.updated_at = now();
    validate_team(&doc)?;
    store.teams.push(StoredTeam { doc: doc.clone() });
    repo.save(&store)?;
    Ok(doc)
}

#[tauri::command]
pub fn personal_agent_team_clone(
    team_id: String,
    revision: Option<u64>,
    new_name: String,
    new_id: Option<String>,
) -> Result<PersonalAgentTeamDoc, String> {
    clone_team_with(
        &TeamRepository::production()?,
        &team_id,
        revision,
        &new_name,
        new_id,
    )
}

fn clone_team_with(
    repo: &TeamRepository,
    team_id: &str,
    revision: Option<u64>,
    new_name: &str,
    new_id: Option<String>,
) -> Result<PersonalAgentTeamDoc, String> {
    let _lock = STORE_LOCK.lock().map_err(|_| "team store lock poisoned")?;
    let mut store = repo.load()?;
    let new_id = new_id.unwrap_or_else(|| format!("team:{}", uuid::Uuid::new_v4()));
    if latest_team(&store, &new_id).is_some() {
        return Err(format!("team already exists: {new_id}"));
    }
    let mut cloned = store
        .teams
        .iter()
        .filter(|stored| {
            stored.doc.id == team_id
                && revision.is_none_or(|revision| stored.doc.revision == revision)
        })
        .map(|stored| &stored.doc)
        .max_by_key(|doc| doc.revision)
        .cloned()
        .ok_or_else(|| "team not found".to_string())?;
    cloned.id = new_id;
    cloned.revision = 1;
    cloned.name = new_name.to_string();
    cloned.archived = false;
    cloned.created_at = now();
    cloned.updated_at = cloned.created_at.clone();
    validate_team(&cloned)?;
    store.teams.push(StoredTeam {
        doc: cloned.clone(),
    });
    repo.save(&store)?;
    Ok(cloned)
}

#[tauri::command]
pub fn personal_agent_team_archive(
    team_id: String,
    expected_revision: u64,
    archived: bool,
) -> Result<PersonalAgentTeamDoc, String> {
    archive_team_with(
        &TeamRepository::production()?,
        &team_id,
        expected_revision,
        archived,
    )
}

fn archive_team_with(
    repo: &TeamRepository,
    team_id: &str,
    expected_revision: u64,
    archived: bool,
) -> Result<PersonalAgentTeamDoc, String> {
    let _lock = STORE_LOCK.lock().map_err(|_| "team store lock poisoned")?;
    let mut store = repo.load()?;
    let previous = latest_team(&store, &team_id).ok_or_else(|| "team not found".to_string())?;
    if previous.revision != expected_revision {
        return Err(format!("team revision conflict at {}", previous.revision));
    }
    if previous.archived == archived {
        return Ok(previous);
    }
    let mut next = previous;
    next.revision += 1;
    next.archived = archived;
    next.updated_at = now();
    store.teams.push(StoredTeam { doc: next.clone() });
    repo.save(&store)?;
    Ok(next)
}

#[tauri::command]
pub fn personal_agent_team_run_create(
    app: tauri::AppHandle,
    request: TeamRunCreateRequest,
) -> Result<TeamRun, String> {
    let repo = TeamRepository::production()?;
    let (run, created) = create_run_with(&repo, &request, None, None, None)?;
    if created {
        execute_run(
            repo,
            run.run_id.clone(),
            app,
            Arc::new(RuntimeModelExecutor),
        );
    }
    Ok(run)
}

#[tauri::command]
pub fn personal_agent_team_run_get(project_id: String, run_id: String) -> Result<TeamRun, String> {
    run_get_with(&TeamRepository::production()?, &project_id, &run_id)
}

fn run_get_with(repo: &TeamRepository, project_id: &str, run_id: &str) -> Result<TeamRun, String> {
    validate_id(&project_id, "projectId")?;
    let _lock = STORE_LOCK.lock().map_err(|_| "team store lock poisoned")?;
    repo.load()?
        .runs
        .into_iter()
        .find(|aggregate| aggregate.run.run_id == run_id && aggregate.run.project_id == project_id)
        .map(|aggregate| aggregate.run)
        .ok_or_else(|| format!("run not found: {run_id}"))
}

#[tauri::command]
pub fn personal_agent_team_run_list(
    project_id: String,
    team_id: Option<String>,
    statuses: Option<Vec<String>>,
    limit: Option<usize>,
) -> Result<Vec<TeamRun>, String> {
    validate_id(&project_id, "projectId")?;
    let allowed_statuses: Option<BTreeSet<String>> = statuses.map(|values| {
        values
            .into_iter()
            .filter(|status| {
                matches!(
                    status.as_str(),
                    "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled"
                )
            })
            .collect()
    });
    let _lock = STORE_LOCK.lock().map_err(|_| "team store lock poisoned")?;
    let mut runs: Vec<_> = TeamRepository::production()?
        .load()?
        .runs
        .into_iter()
        .filter(|aggregate| {
            aggregate.run.project_id == project_id
                && team_id
                    .as_ref()
                    .is_none_or(|team_id| aggregate.run.team_id == *team_id)
                && allowed_statuses
                    .as_ref()
                    .is_none_or(|statuses| statuses.contains(&aggregate.run.status))
        })
        .map(|aggregate| aggregate.run)
        .collect();
    runs.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    runs.truncate(limit.unwrap_or(100).clamp(1, 1000));
    Ok(runs)
}

#[tauri::command]
pub fn personal_agent_team_run_events(
    project_id: String,
    run_id: String,
    after_seq: Option<u64>,
    limit: Option<usize>,
) -> Result<TeamRunEventsPage, String> {
    run_events_with(
        &TeamRepository::production()?,
        &project_id,
        &run_id,
        after_seq,
        limit,
    )
}

fn run_events_with(
    repo: &TeamRepository,
    project_id: &str,
    run_id: &str,
    after_seq: Option<u64>,
    limit: Option<usize>,
) -> Result<TeamRunEventsPage, String> {
    validate_id(&project_id, "projectId")?;
    let _lock = STORE_LOCK.lock().map_err(|_| "team store lock poisoned")?;
    let store = repo.load()?;
    let aggregate = store
        .runs
        .iter()
        .find(|aggregate| aggregate.run.run_id == run_id && aggregate.run.project_id == project_id)
        .ok_or_else(|| format!("run not found: {run_id}"))?;
    let max = limit.unwrap_or(200).clamp(1, 1000);
    let retained = retained_events(aggregate, chrono::Utc::now());
    let events: Vec<_> = retained
        .iter()
        .filter(|event| event.seq > after_seq.unwrap_or(0))
        .take(max)
        .cloned()
        .collect();
    let next_after_seq = events
        .last()
        .map_or(after_seq.unwrap_or(0), |event| event.seq);
    Ok(TeamRunEventsPage {
        run_id: run_id.to_string(),
        has_more: aggregate
            .events
            .iter()
            .any(|event| event.seq > next_after_seq)
            && retained.iter().any(|event| event.seq > next_after_seq),
        next_after_seq,
        events,
    })
}

#[tauri::command]
pub async fn personal_agent_team_run_cancel(
    project_id: String,
    run_id: String,
    reason: Option<String>,
) -> Result<TeamRun, String> {
    cancel_run_with(&TeamRepository::production()?, &project_id, &run_id, reason).await
}

async fn cancel_run_with(
    repo: &TeamRepository,
    project_id: &str,
    run_id: &str,
    reason: Option<String>,
) -> Result<TeamRun, String> {
    validate_id(project_id, "projectId")?;
    let initial = with_run_mut(repo, run_id, |aggregate| {
        if aggregate.run.project_id != project_id {
            return Err("run not found in project".into());
        }
        if terminal(&aggregate.run.status) {
            return Ok(aggregate.run.clone());
        }
        if aggregate.run.status != "cancelling" {
            aggregate.run.status = "cancelling".into();
            append_event(
                aggregate,
                "cancel.requested",
                None,
                None,
                vec![],
                vec![],
                json!({"reason": reason}),
            );
        }
        Ok(aggregate.run.clone())
    })?;
    if terminal(&initial.status) {
        return Ok(initial);
    }
    let control = ACTIVE_RUNS
        .lock()
        .ok()
        .and_then(|active| active.get(run_id).cloned());
    if let Some(control) = control {
        control.abort.abort();
        while !control.finished.load(Ordering::Acquire) {
            let notified = control.notify.notified();
            if control.finished.load(Ordering::Acquire) {
                break;
            }
            notified.await;
        }
    }
    with_run_mut(repo, run_id, |aggregate| {
        if aggregate.run.project_id != project_id {
            return Err("run not found in project".into());
        }
        if terminal(&aggregate.run.status) {
            return Ok(aggregate.run.clone());
        }
        if aggregate.run.status != "cancelling" {
            return Err("run changed state while cancellation was pending".into());
        }
        aggregate.run.status = "cancelled".into();
        aggregate.run.finished_at = Some(now());
        append_event(
            aggregate,
            "run.cancelled",
            None,
            None,
            vec![],
            vec![],
            json!({}),
        );
        Ok(aggregate.run.clone())
    })
}

#[tauri::command]
pub fn personal_agent_team_run_recover(
    app: tauri::AppHandle,
    request: TeamRunRecoverRequest,
) -> Result<TeamRun, String> {
    validate_id(&request.client_request_id, "clientRequestId")?;
    validate_id(&request.project_id, "projectId")?;
    if request.strategy != "retryFailed" {
        return Err(
            "strategy must be retryFailed; checkpoint resume is not available until execution checkpoints are persisted"
                .into(),
        );
    }
    let repo = TeamRepository::production()?;
    let (create_request, snapshot) = {
        let _lock = STORE_LOCK.lock().map_err(|_| "team store lock poisoned")?;
        let store = repo.load()?;
        let source = store
            .runs
            .iter()
            .find(|aggregate| {
                aggregate.run.run_id == request.run_id
                    && aggregate.run.project_id == request.project_id
            })
            .ok_or_else(|| format!("run not found: {}", request.run_id))?;
        if !matches!(source.run.status.as_str(), "failed" | "cancelled") {
            return Err("only failed or cancelled runs can be recovered".into());
        }
        (
            TeamRunCreateRequest {
                client_request_id: request.client_request_id.clone(),
                project_id: request.project_id.clone(),
                team_id: source.run.team_id.clone(),
                expected_team_revision: None,
                objective: source.run.objective.clone(),
                input: source.input.clone(),
            },
            source.snapshot.clone(),
        )
    };
    let (run, created) = create_run_with(
        &repo,
        &create_request,
        Some(request.run_id.clone()),
        Some(snapshot),
        Some(json!({"strategy": request.strategy, "taskId": request.task_id})),
    )?;
    if created {
        execute_run(
            repo,
            run.run_id.clone(),
            app,
            Arc::new(RuntimeModelExecutor),
        );
    }
    Ok(run)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn repo() -> TeamRepository {
        TeamRepository {
            root: std::env::temp_dir().join(format!("owllm-team-tests-{}", uuid::Uuid::new_v4())),
        }
    }

    fn member(id: &str, profile: &str, role: &str) -> PersonalAgentTeamMember {
        PersonalAgentTeamMember {
            member_id: id.into(),
            profile_id: profile.into(),
            role: role.into(),
            may_delegate_to_member_ids: Vec::new(),
            context_access: "project".into(),
        }
    }

    fn team(profile_id: &str) -> PersonalAgentTeamDoc {
        PersonalAgentTeamDoc {
            schema_version: 1,
            id: "team:test".into(),
            revision: 1,
            name: "Test".into(),
            description: "Test team".into(),
            archived: false,
            coordinator_profile_id: profile_id.into(),
            members: vec![member("coordinator", profile_id, "coordinator")],
            delegation_budget: DelegationBudget {
                max_handoffs: 4,
                max_depth: 2,
                max_parallel: 2,
            },
            context_policy: TeamContextPolicy {
                shared_enabled: true,
                project_enabled: true,
                private_enabled: false,
            },
            skill_refs: vec![],
            retention_policy: TeamRetentionPolicy {
                event_days: 30,
                output_days: 7,
            },
            created_at: "2026-07-24T00:00:00Z".into(),
            updated_at: "2026-07-24T00:00:00Z".into(),
        }
    }

    fn profile_doc(id: &str, allowed_profile_ids: Vec<String>) -> AgentProfileDoc {
        AgentProfileDoc {
            schema_version: 1,
            id: id.into(),
            revision: 1,
            display_name: id.into(),
            identity: crate::personal_agents::AgentIdentity {
                name: id.into(),
                avatar: None,
                color: None,
            },
            role: "coder".into(),
            system_instructions: "Use pinned instructions".into(),
            model: crate::personal_agents::AgentModel {
                provider: Some("mock".into()),
                model_id: Some("mock-model".into()),
            },
            allowed_tools: vec![],
            memory_scope: "project".into(),
            delegation: crate::personal_agents::DelegationPolicy {
                enabled: !allowed_profile_ids.is_empty(),
                allowed_profile_ids,
            },
            skill_ids: vec![],
            personal_skill_refs: vec![],
            rule_card_refs: vec![],
            created_at: "2026-07-24T00:00:00Z".into(),
            updated_at: "2026-07-24T00:00:00Z".into(),
        }
    }

    fn pinned_agent(
        member_id: &str,
        role: &str,
        profile: AgentProfileDoc,
        targets: Vec<String>,
    ) -> PinnedTeamAgent {
        PinnedTeamAgent {
            member_id: member_id.into(),
            role: role.into(),
            context_access: "project".into(),
            may_delegate_to_member_ids: targets,
            profile_ref: RevisionRef {
                id: profile.id.clone(),
                revision: profile.revision,
            },
            profile,
            rule_refs: vec![],
            rule_cards: vec![],
            skill_pins: vec![],
            skill_instructions: vec![],
            context_snapshot: vec![],
        }
    }

    fn aggregate_with_agents(responses_hash: &str) -> RunAggregate {
        let specialist_profile = profile_doc("agent:specialist", vec![]);
        let coordinator_profile =
            profile_doc("agent:coordinator", vec![specialist_profile.id.clone()]);
        let snapshot = TeamRunSnapshot {
            schema_version: 1,
            snapshot_hash: responses_hash.into(),
            team_ref: TeamRef {
                id: "team:test".into(),
                revision: 1,
            },
            project_config_ref: ProjectConfigRef {
                project_id: "project-a".into(),
                revision: 1,
            },
            agents: vec![
                pinned_agent(
                    "coordinator",
                    "coordinator",
                    coordinator_profile,
                    vec!["specialist".into()],
                ),
                pinned_agent("specialist", "specialist", specialist_profile, vec![]),
            ],
            rule_refs: vec![],
            skill_pins: vec![],
            delegation_budget: DelegationBudget {
                max_handoffs: 1,
                max_depth: 1,
                max_parallel: 1,
            },
            context_policy: TeamContextPolicy {
                shared_enabled: true,
                project_enabled: true,
                private_enabled: false,
            },
            created_at: "2026-07-24T00:00:00Z".into(),
        };
        RunAggregate {
            run: TeamRun {
                schema_version: 1,
                run_id: "run:test".into(),
                client_request_id: "request:test".into(),
                project_id: "project-a".into(),
                team_id: "team:test".into(),
                status: "queued".into(),
                snapshot_hash: responses_hash.into(),
                objective: "Produce a real answer".into(),
                created_at: "2026-07-24T00:00:00Z".into(),
                started_at: None,
                finished_at: None,
                recovery_of_run_id: None,
                last_event_seq: 0,
            },
            snapshot,
            request_hash: "request-hash".into(),
            retention_policy: TeamRetentionPolicy::default(),
            input: Some(json!({"source": "test"})),
            events: vec![],
            next_seq: 1,
        }
    }

    fn aggregate_with_unique_run(responses_hash: &str) -> (RunAggregate, String) {
        let mut aggregate = aggregate_with_agents(responses_hash);
        let run_id = format!("run:{}", uuid::Uuid::new_v4());
        aggregate.run.run_id = run_id.clone();
        for event in &mut aggregate.events {
            event.run_id = run_id.clone();
        }
        (aggregate, run_id)
    }

    struct MockExecutor {
        replies: Arc<Mutex<VecDeque<Result<String, String>>>>,
    }

    impl MockExecutor {
        fn new(replies: Vec<Result<&str, &str>>) -> Self {
            Self {
                replies: Arc::new(Mutex::new(
                    replies
                        .into_iter()
                        .map(|reply| reply.map(str::to_string).map_err(str::to_string))
                        .collect(),
                )),
            }
        }
    }

    impl ModelExecutor for MockExecutor {
        fn execute(&self, _call: ModelCall) -> ModelFuture {
            let result = self
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err("unexpected model call".into()));
            Box::pin(async move { result })
        }
    }

    struct DropSignal(Arc<AtomicBool>);

    impl Drop for DropSignal {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    struct BlockingExecutor {
        dropped: Arc<AtomicBool>,
    }

    impl ModelExecutor for BlockingExecutor {
        fn execute(&self, _call: ModelCall) -> ModelFuture {
            let guard = DropSignal(self.dropped.clone());
            Box::pin(async move {
                let _guard = guard;
                std::future::pending::<Result<String, String>>().await
            })
        }
    }

    #[test]
    fn team_validation_enforces_coordinator_and_bounds() {
        let profile = "agent:00000000-0000-0000-0000-000000000001";
        assert!(validate_team(&team(profile)).is_ok());
        let mut invalid = team(profile);
        invalid.members[0].role = "specialist".into();
        assert!(validate_team(&invalid).unwrap_err().contains("exactly one"));
        let mut invalid = team(profile);
        invalid.retention_policy.event_days = 366;
        assert!(validate_team(&invalid).is_err());
    }

    #[test]
    fn private_context_is_coordinator_only_and_private_output_is_not_stored_verbatim() {
        let profile = "agent:00000000-0000-0000-0000-000000000001";
        let mut invalid = team(profile);
        invalid.context_policy.private_enabled = true;
        let mut specialist = member(
            "specialist",
            "agent:00000000-0000-0000-0000-000000000002",
            "specialist",
        );
        specialist.context_access = "private".into();
        invalid.members.push(specialist);
        assert!(validate_team(&invalid)
            .unwrap_err()
            .contains("only the coordinator"));

        let mut agent = pinned_agent(
            "coordinator",
            "coordinator",
            profile_doc("agent:private", vec![]),
            vec![],
        );
        agent.context_access = "private".into();
        let trace = trace_output(&agent, "private free-form output");
        assert_eq!(trace.get("redacted"), Some(&json!(true)));
        assert!(trace.get("sha256").is_some());
        assert!(!trace.to_string().contains("private free-form output"));
    }

    #[test]
    fn execution_profiles_allow_bounded_browser_tools_and_reject_unrestricted_paths() {
        let mut local = profile_doc("agent:local", vec![]);
        local.model.provider = Some("local".into());
        local.model.model_id = Some("local/model".into());
        assert!(validate_execution_profile(&local).is_ok());

        local.allowed_tools = vec!["browser_click".into()];
        assert!(validate_execution_profile(&local).is_ok());
        local.allowed_tools = vec!["edit_file".into()];
        assert!(validate_execution_profile(&local)
            .unwrap_err()
            .contains("unsupported"));

        let mut subscription = profile_doc("agent:subscription", vec![]);
        subscription.model.provider = Some("anthropic".into());
        subscription.model.model_id = Some("claude-subscription".into());
        assert!(validate_execution_profile(&subscription)
            .unwrap_err()
            .contains("subscription CLI"));

        subscription.model.model_id = Some("api/claude".into());
        assert!(validate_execution_profile(&subscription).is_ok());
    }

    #[test]
    fn run_and_event_wire_shapes_match_the_frontend_contract() {
        let aggregate = aggregate_with_agents("snapshot-hash");
        let run = serde_json::to_value(&aggregate.run).unwrap();
        for key in [
            "schemaVersion",
            "runId",
            "clientRequestId",
            "projectId",
            "teamId",
            "status",
            "snapshotHash",
            "objective",
            "createdAt",
            "lastEventSeq",
        ] {
            assert!(run.get(key).is_some(), "missing {key}");
        }
        assert!(run.get("id").is_none());
        assert!(run.get("requestHash").is_none());
        let mut aggregate = aggregate;
        append_event(
            &mut aggregate,
            "task.progress",
            Some("coordinator"),
            Some("task:1"),
            vec![],
            vec![],
            json!({"percent": 50}),
        );
        let event = serde_json::to_value(&aggregate.events[0]).unwrap();
        for key in [
            "schemaVersion",
            "runId",
            "seq",
            "ts",
            "kind",
            "appliedRuleRefs",
            "appliedSkillIds",
        ] {
            assert!(event.get(key).is_some(), "missing {key}");
        }
        assert!(event.get("eventType").is_none());
        assert!(event.get("data").is_none());
    }

    #[test]
    fn store_roundtrip_preserves_append_only_team_revisions() {
        let repo = repo();
        let mut store = TeamStore {
            schema_version: 1,
            ..TeamStore::default()
        };
        let profile = "agent:00000000-0000-0000-0000-000000000001";
        let first = team(profile);
        let mut second = first.clone();
        second.revision = 2;
        second.name = "Renamed".into();
        store.teams.push(StoredTeam { doc: first });
        store.teams.push(StoredTeam {
            doc: second.clone(),
        });
        repo.save(&store).unwrap();
        let loaded = repo.load().unwrap();
        assert_eq!(latest_team(&loaded, "team:test"), Some(second));
        assert_eq!(loaded.teams.len(), 2);
        let raw = fs::read(repo.path()).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("Renamed"));
    }

    #[test]
    fn team_crud_clone_archive_unarchive_and_restart_reuse_are_versioned() {
        let repo = repo();
        let profile = "agent:00000000-0000-0000-0000-000000000001";
        let first = save_team_with(&repo, team(profile), None).unwrap();
        let mut edit = first.clone();
        edit.name = "Renamed".into();
        let second = save_team_with(&repo, edit, Some(1)).unwrap();
        assert_eq!(second.revision, 2);
        assert!(save_team_with(&repo, second.clone(), Some(1))
            .unwrap_err()
            .contains("conflict"));
        let cloned = clone_team_with(
            &repo,
            &second.id,
            Some(2),
            "Clone",
            Some("team:clone".into()),
        )
        .unwrap();
        assert_eq!(cloned.revision, 1);
        let archived = archive_team_with(&repo, &second.id, 2, true).unwrap();
        assert!(archived.archived);
        let unarchived = archive_team_with(&repo, &second.id, archived.revision, false).unwrap();
        assert!(!unarchived.archived);
        let reopened = TeamRepository {
            root: repo.root.clone(),
        }
        .load()
        .unwrap();
        assert_eq!(latest_team(&reopened, &second.id), Some(unarchived));
        assert_eq!(latest_team(&reopened, "team:clone"), Some(cloned));
        let _ = fs::remove_dir_all(repo.root);
    }

    #[test]
    fn events_are_monotonic_redacted_and_cursor_replay_has_no_duplicates() {
        let profile = "agent:00000000-0000-0000-0000-000000000001";
        let snapshot = TeamRunSnapshot {
            schema_version: 1,
            snapshot_hash: "hash".into(),
            team_ref: TeamRef {
                id: "team:test".into(),
                revision: 1,
            },
            project_config_ref: ProjectConfigRef {
                project_id: "p".into(),
                revision: 1,
            },
            agents: vec![],
            rule_refs: vec![],
            skill_pins: vec![],
            delegation_budget: team(profile).delegation_budget,
            context_policy: team(profile).context_policy,
            created_at: "2026-07-24T00:00:00Z".into(),
        };
        let mut aggregate = RunAggregate {
            run: TeamRun {
                schema_version: 1,
                run_id: "run:1".into(),
                client_request_id: "request".into(),
                project_id: "p".into(),
                team_id: "team:test".into(),
                status: "running".into(),
                snapshot_hash: "hash".into(),
                objective: "task".into(),
                created_at: "2026-07-24T00:00:00Z".into(),
                started_at: Some("2026-07-24T00:00:00Z".into()),
                finished_at: None,
                recovery_of_run_id: None,
                last_event_seq: 0,
            },
            snapshot,
            request_hash: "request-hash".into(),
            retention_policy: TeamRetentionPolicy::default(),
            input: None,
            events: vec![],
            next_seq: 1,
        };
        append_event(
            &mut aggregate,
            "task.output",
            Some("a"),
            Some("t"),
            vec![],
            vec![],
            json!({"output":"private value","token":"secret"}),
        );
        append_event(
            &mut aggregate,
            "task.progress",
            Some("a"),
            Some("t"),
            vec![],
            vec![],
            json!({"percent":100}),
        );
        let wire = serde_json::to_string(&aggregate.events).unwrap();
        assert!(!wire.contains("private value"));
        assert!(!wire.contains("secret"));
        assert_eq!(
            aggregate
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(
            aggregate
                .events
                .iter()
                .filter(|event| event.seq > 1)
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![2]
        );
    }

    #[tokio::test]
    async fn real_executor_path_uses_model_results_and_never_fabricates_success() {
        let repo = repo();
        repo.save(&TeamStore {
            schema_version: 1,
            teams: vec![],
            runs: vec![aggregate_with_agents("snapshot-hash")],
        })
        .unwrap();
        let executor = MockExecutor::new(vec![
            Ok(r#"{"assignments":[{"memberId":"specialist","task":"Research"}]}"#),
            Ok("real specialist result"),
            Ok("real coordinator synthesis"),
        ]);
        execute_run_inner(&repo, "run:test", None, &executor)
            .await
            .unwrap();
        let stored = repo.load().unwrap();
        let aggregate = &stored.runs[0];
        assert_eq!(aggregate.run.status, "succeeded");
        let wire = serde_json::to_string(&aggregate.events).unwrap();
        assert!(wire.contains("real specialist result"));
        assert!(wire.contains("real coordinator synthesis"));
        assert!(!wire.contains("completed pinned task"));
        assert_eq!(
            aggregate
                .events
                .iter()
                .filter(|event| event.kind == "delegation.created")
                .count(),
            1
        );
        let _ = fs::remove_dir_all(repo.root);
    }

    #[tokio::test]
    async fn model_failure_cannot_be_reported_as_success() {
        let repo = repo();
        repo.save(&TeamStore {
            schema_version: 1,
            teams: vec![],
            runs: vec![aggregate_with_agents("snapshot-hash")],
        })
        .unwrap();
        let executor = MockExecutor::new(vec![
            Ok(r#"{"assignments":[{"memberId":"specialist","task":"Research"}]}"#),
            Err("first failure"),
            Err("retry failure"),
        ]);
        let error = execute_run_inner(&repo, "run:test", None, &executor)
            .await
            .unwrap_err();
        mark_run_failed(&repo, "run:test", &error).unwrap();
        let stored = repo.load().unwrap();
        let aggregate = &stored.runs[0];
        assert_eq!(aggregate.run.status, "failed");
        assert!(aggregate
            .events
            .iter()
            .any(|event| event.kind == "run.failed"));
        assert!(!aggregate
            .events
            .iter()
            .any(|event| event.kind == "run.succeeded"));
        let wire = serde_json::to_string(&aggregate.events).unwrap();
        assert!(!wire.contains("first failure"));
        assert!(!wire.contains("retry failure"));
        let _ = fs::remove_dir_all(repo.root);
    }

    #[test]
    fn retention_physically_purges_events_and_outputs_from_persisted_store() {
        let repo = repo();
        let mut aggregate = aggregate_with_agents("snapshot-hash");
        aggregate.retention_policy = TeamRetentionPolicy {
            event_days: 30,
            output_days: 7,
        };
        let at = chrono::Utc::now();
        aggregate.events.push(PersonalAgentTraceEvent {
            schema_version: 1,
            run_id: "run:test".into(),
            seq: 1,
            ts: (at - chrono::Duration::days(8)).to_rfc3339(),
            kind: "task.output".into(),
            agent_member_id: None,
            task_id: None,
            parent_task_id: None,
            status: Some("running".into()),
            applied_rule_refs: vec![],
            applied_skill_ids: vec![],
            handoff: None,
            output: Some(json!({"text": "expire me"})),
            error: None,
        });
        aggregate.events.push(PersonalAgentTraceEvent {
            seq: 2,
            ts: (at - chrono::Duration::days(31)).to_rfc3339(),
            ..aggregate.events[0].clone()
        });
        repo.save(&TeamStore {
            schema_version: 1,
            teams: vec![],
            runs: vec![aggregate],
        })
        .unwrap();
        let persisted = repo.load().unwrap();
        assert_eq!(persisted.runs[0].events.len(), 1);
        assert!(persisted.runs[0].events[0].output.is_none());
        let reopened = TeamRepository {
            root: repo.root.clone(),
        }
        .load()
        .unwrap();
        assert_eq!(reopened.runs[0].events.len(), 1);
        assert!(reopened.runs[0].events[0].output.is_none());
        let _ = fs::remove_dir_all(repo.root);
    }

    #[test]
    fn run_creation_is_idempotent_per_project_and_conflicts_on_changed_payload() {
        let repo = repo();
        let request = TeamRunCreateRequest {
            client_request_id: "request:test".into(),
            project_id: "project-a".into(),
            team_id: "team:test".into(),
            expected_team_revision: None,
            objective: "Produce a real answer".into(),
            input: Some(json!({"source": "test"})),
        };
        let mut aggregate = aggregate_with_agents("snapshot-hash");
        aggregate.request_hash = canonical_hash(&json!({
            "request": &request,
            "recoveryOfRunId": Option::<String>::None,
            "recovery": Option::<Value>::None,
        }))
        .unwrap();
        repo.save(&TeamStore {
            schema_version: 1,
            teams: vec![],
            runs: vec![aggregate],
        })
        .unwrap();
        let (same, created) = create_run_with(&repo, &request, None, None, None).unwrap();
        assert!(!created);
        assert_eq!(same.run_id, "run:test");
        let mut changed = request;
        changed.objective = "Different objective".into();
        assert!(create_run_with(&repo, &changed, None, None, None)
            .unwrap_err()
            .contains("payload differs"));
        let _ = fs::remove_dir_all(repo.root);
    }

    #[tokio::test]
    async fn cancellation_is_idempotent_terminal_and_prevents_success() {
        let repo = repo();
        let (aggregate, run_id) = aggregate_with_unique_run("snapshot-hash");
        repo.save(&TeamStore {
            schema_version: 1,
            teams: vec![],
            runs: vec![aggregate],
        })
        .unwrap();
        let cancelled = cancel_run_with(&repo, "project-a", &run_id, Some("user stop".into()))
            .await
            .unwrap();
        assert_eq!(cancelled.status, "cancelled");
        let again = cancel_run_with(&repo, "project-a", &run_id, None)
            .await
            .unwrap();
        assert_eq!(again.status, "cancelled");
        let stored = repo.load().unwrap();
        assert_eq!(
            stored.runs[0]
                .events
                .iter()
                .filter(|event| event.kind == "run.cancelled")
                .count(),
            1
        );
        assert!(!stored.runs[0]
            .events
            .iter()
            .any(|event| event.kind == "run.succeeded"));
        let _ = fs::remove_dir_all(repo.root);
    }

    #[tokio::test]
    async fn active_cancellation_drops_provider_work_before_terminal_event() {
        let repo = repo();
        let (aggregate, run_id) = aggregate_with_unique_run("snapshot-hash");
        repo.save(&TeamStore {
            schema_version: 1,
            teams: vec![],
            runs: vec![aggregate],
        })
        .unwrap();
        let dropped = Arc::new(AtomicBool::new(false));
        start_run(
            repo.clone(),
            run_id.clone(),
            None,
            Arc::new(BlockingExecutor {
                dropped: dropped.clone(),
            }),
        );
        for _ in 0..100 {
            if repo
                .load()
                .unwrap()
                .runs
                .iter()
                .any(|aggregate| aggregate.run.status == "running")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let cancelled = cancel_run_with(&repo, "project-a", &run_id, Some("stop".into()))
            .await
            .unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert!(dropped.load(Ordering::Acquire));
        let stored = repo.load().unwrap();
        let aggregate = &stored.runs[0];
        assert_eq!(aggregate.run.status, "cancelled");
        assert_eq!(
            aggregate
                .events
                .iter()
                .filter(|event| event.kind == "run.cancelled")
                .count(),
            1
        );
        assert!(!aggregate.events.iter().any(|event| {
            matches!(
                event.kind.as_str(),
                "task.output" | "run.succeeded" | "tool.started" | "tool.completed"
            )
        }));
        let _ = fs::remove_dir_all(repo.root);
    }

    #[tokio::test]
    async fn run_access_is_project_scoped_for_get_events_and_cancel() {
        let repo = repo();
        let (mut aggregate, run_id) = aggregate_with_unique_run("snapshot-hash");
        append_event(
            &mut aggregate,
            "task.progress",
            Some("coordinator"),
            Some("task:1"),
            vec![],
            vec![],
            json!({"percent": 50}),
        );
        repo.save(&TeamStore {
            schema_version: 1,
            teams: vec![],
            runs: vec![aggregate],
        })
        .unwrap();
        assert!(run_get_with(&repo, "project-b", &run_id).is_err());
        assert!(run_events_with(&repo, "project-b", &run_id, None, None).is_err());
        assert!(cancel_run_with(&repo, "project-b", &run_id, None)
            .await
            .is_err());
        assert_eq!(
            run_get_with(&repo, "project-a", &run_id)
                .unwrap()
                .project_id,
            "project-a"
        );
        assert_eq!(
            run_events_with(&repo, "project-a", &run_id, None, None)
                .unwrap()
                .events
                .len(),
            1
        );
        let _ = fs::remove_dir_all(repo.root);
    }

    #[test]
    fn team_listing_filters_out_profiles_not_available_to_the_project() {
        let mut teams = vec![team("agent:allowed"), team("agent:denied")];
        teams[1].id = "team:denied".into();
        let allowed = BTreeSet::from(["agent:allowed".to_string()]);
        filter_teams_for_profiles(&mut teams, &allowed);
        assert_eq!(teams.len(), 1);
        assert_eq!(teams[0].id, "team:test");
    }

    #[test]
    fn personal_team_skill_pins_exact_revision_and_enforces_required_tools() {
        let mut skill = PersonalSkillDoc {
            schema_version: 1,
            id: "personal__review".into(),
            revision: 2,
            name: "Review".into(),
            purpose: "Review a result".into(),
            instructions: "Return findings only.".into(),
            required_tools: vec![],
            input_contract: "Result text".into(),
            output_contract: "Findings".into(),
            permission_boundary: crate::personal_agents::SkillPermissionBoundary::default(),
            scope: "project".into(),
            project_id: Some("project-a".into()),
            private: true,
            status: "active".into(),
            created_at: "2026-07-24T00:00:00Z".into(),
            updated_at: "2026-07-24T00:00:00Z".into(),
        };
        let reference = RevisionRef {
            id: skill.id.clone(),
            revision: 2,
        };
        let no_tools = BTreeSet::new();
        let (pin, _) =
            personal_skill_material(&[skill.clone()], &reference, "project-a", &no_tools).unwrap();
        assert_eq!(pin.revision, Some(2));
        assert!(
            personal_skill_material(&[skill.clone()], &reference, "project-b", &no_tools).is_err()
        );
        skill.required_tools = vec!["browser_snapshot".into()];
        skill.permission_boundary.allowed_tools = skill.required_tools.clone();
        assert!(
            personal_skill_material(&[skill.clone()], &reference, "project-a", &no_tools)
                .unwrap_err()
                .contains("not allowed")
        );
        let browser_tools = BTreeSet::from(["browser_snapshot"]);
        assert!(personal_skill_material(&[skill], &reference, "project-a", &browser_tools).is_ok());
    }

    #[test]
    fn exact_rule_lookup_does_not_drift_to_a_newer_revision() {
        let first = crate::personal_agents::RuleCardDoc {
            schema_version: 1,
            id: "rule:test".into(),
            revision: 1,
            kind: "fact".into(),
            title: "Pinned".into(),
            body: "public revision".into(),
            condition: None,
            scope: "global".into(),
            project_id: None,
            private: false,
            created_at: "2026-07-24T00:00:00Z".into(),
            updated_at: "2026-07-24T00:00:00Z".into(),
        };
        let mut second = first.clone();
        second.revision = 2;
        second.body = "new private revision".into();
        second.private = true;
        let reference = RevisionRef {
            id: first.id.clone(),
            revision: 1,
        };
        let rules = vec![first.clone(), second];
        assert_eq!(exact_rule(&rules, &reference), Some(&first));
    }

    #[test]
    fn runtime_tool_protocol_rejects_unauthorized_and_malformed_calls() {
        let parsed = parse_runtime_tool_call(
            r#"{"toolCall":{"name":"browser_snapshot","arguments":{"tab_id":7}}}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(parsed.name, "browser_snapshot");
        assert_eq!(tool_arg_u64(&parsed.arguments, "tab_id").unwrap(), 7);
        assert!(parse_runtime_tool_call("ordinary final answer")
            .unwrap()
            .is_none());
        assert!(parse_runtime_tool_call(r#"{"toolCall":{"name":7}}"#).is_err());
    }

    #[test]
    fn stored_snapshot_remains_pinned_after_team_edits_and_restart() {
        let repo = repo();
        let aggregate = aggregate_with_agents("snapshot-hash");
        let profile = "agent:00000000-0000-0000-0000-000000000001";
        let first = team(profile);
        let mut second = first.clone();
        second.revision = 2;
        second.name = "Edited after run creation".into();
        repo.save(&TeamStore {
            schema_version: 1,
            teams: vec![StoredTeam { doc: first }, StoredTeam { doc: second }],
            runs: vec![aggregate],
        })
        .unwrap();
        let reopened = TeamRepository {
            root: repo.root.clone(),
        }
        .load()
        .unwrap();
        assert_eq!(reopened.runs[0].snapshot.team_ref.revision, 1);
        assert_eq!(reopened.runs[0].snapshot.snapshot_hash, "snapshot-hash");
        assert_eq!(latest_team(&reopened, "team:test").unwrap().revision, 2);
        let _ = fs::remove_dir_all(repo.root);
    }
}

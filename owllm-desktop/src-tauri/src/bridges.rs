// Bridge configs — persisted to `~/.owllm/bridge_config.json`, the
// SAME path the legacy PySide6 app uses. Reading/writing through the
// same file means a user can flip between the Python app and OwLLM
// Desktop without re-entering bot tokens.
//
// Schema mirrors LLM/desktop_app/messaging/bridge_config_store.py:
//
//   {
//     "telegram": { "bot_token", "allowed_chat_ids", "project_id",
//                   "auto_approve" },
//     "whatsapp": { "access_token", "phone_number_id", "verify_token",
//                   "webhook_port", "webhook_host", "allowed_senders",
//                   "project_id", "auto_approve" }
//   }
//
// Start/Stop is NOT wired here. The Python bridge processes are a
// follow-up — current cut is config-persistence-only so users at
// least see their settings round-trip cleanly. A toast-style
// "bridges are coming" message is the UI's responsibility.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct TelegramConfig {
    #[serde(default)]
    pub bot_token: String,
    #[serde(default)]
    pub allowed_chat_ids: Vec<i64>,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub auto_approve: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct WhatsAppConfig {
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub phone_number_id: String,
    #[serde(default)]
    pub verify_token: String,
    #[serde(default = "default_webhook_port")]
    pub webhook_port: u16,
    #[serde(default = "default_webhook_host")]
    pub webhook_host: String,
    #[serde(default)]
    pub allowed_senders: Vec<String>,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub auto_approve: bool,
}

impl Default for WhatsAppConfig {
    fn default() -> Self {
        Self {
            access_token: String::new(),
            phone_number_id: String::new(),
            verify_token: String::new(),
            webhook_port: default_webhook_port(),
            webhook_host: default_webhook_host(),
            allowed_senders: Vec::new(),
            project_id: String::new(),
            auto_approve: false,
        }
    }
}

fn default_webhook_port() -> u16 { 8911 }
fn default_webhook_host() -> String { "0.0.0.0".to_string() }

/// Discord — connects OUTBOUND via the gateway WebSocket (no public URL).
/// `allowed_channel_ids` are Discord snowflakes (kept as strings: they exceed
/// JS safe-integer range). Empty = any channel/DM the bot can see.
#[derive(Default, Serialize, Deserialize, Clone)]
pub struct DiscordConfig {
    #[serde(default)]
    pub bot_token: String,
    #[serde(default)]
    pub allowed_channel_ids: Vec<String>,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub auto_approve: bool,
}

/// Slack — connects OUTBOUND via Socket Mode (no public URL). Needs an
/// app-level token (xapp-…, connections:write) to open the socket and a bot
/// token (xoxb-…) to post. `allowed_channel_ids` are channel ids (C…/G…/D…);
/// empty = any channel the bot is in.
#[derive(Default, Serialize, Deserialize, Clone)]
pub struct SlackConfig {
    #[serde(default)]
    pub app_token: String,
    #[serde(default)]
    pub bot_token: String,
    #[serde(default)]
    pub allowed_channel_ids: Vec<String>,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub auto_approve: bool,
}

/// Email — IMAP receive + SMTP send. No public URL. Use a DEDICATED mailbox:
/// the bridge marks inbound mail \Seen as it processes it. `allowed_senders`
/// are bare addresses; empty = accept any sender.
#[derive(Serialize, Deserialize, Clone)]
pub struct EmailConfig {
    #[serde(default)]
    pub imap_host: String,
    #[serde(default = "default_imap_port")]
    pub imap_port: u16,
    #[serde(default)]
    pub smtp_host: String,
    #[serde(default = "default_smtp_port")]
    pub smtp_port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// Reply-from address; defaults to `username` when empty.
    #[serde(default)]
    pub from_addr: String,
    #[serde(default)]
    pub allowed_senders: Vec<String>,
    #[serde(default = "default_poll_seconds")]
    pub poll_seconds: u32,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub auto_approve: bool,
}

fn default_imap_port() -> u16 { 993 }
fn default_smtp_port() -> u16 { 587 }
fn default_poll_seconds() -> u32 { 30 }

impl Default for EmailConfig {
    fn default() -> Self {
        Self {
            imap_host: String::new(),
            imap_port: default_imap_port(),
            smtp_host: String::new(),
            smtp_port: default_smtp_port(),
            username: String::new(),
            password: String::new(),
            from_addr: String::new(),
            allowed_senders: Vec::new(),
            poll_seconds: default_poll_seconds(),
            project_id: String::new(),
            auto_approve: false,
        }
    }
}

/// LINE — INBOUND webhook (needs a public URL). `channel_access_token` posts
/// replies; `channel_secret` authenticates inbound POSTs via the
/// X-Line-Signature header (verified in webhook.rs when set). `allowed_users`
/// are LINE userIds; empty = any.
#[derive(Default, Serialize, Deserialize, Clone)]
pub struct LineConfig {
    #[serde(default)]
    pub channel_access_token: String,
    #[serde(default)]
    pub channel_secret: String,
    #[serde(default)]
    pub allowed_users: Vec<String>,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub auto_approve: bool,
}

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct BridgeConfigs {
    #[serde(default)]
    pub telegram: TelegramConfig,
    #[serde(default)]
    pub whatsapp: WhatsAppConfig,
    #[serde(default)]
    pub discord: DiscordConfig,
    #[serde(default)]
    pub slack: SlackConfig,
    #[serde(default)]
    pub email: EmailConfig,
    #[serde(default)]
    pub line: LineConfig,
}

fn config_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".owllm").join("bridge_config.json"))
}

#[tauri::command]
pub async fn load_bridge_configs() -> Result<BridgeConfigs, String> {
    let Some(path) = config_path() else {
        return Ok(BridgeConfigs::default());
    };
    if !path.is_file() {
        return Ok(BridgeConfigs::default());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    // Empty / corrupt file -> defaults, never error to the user.
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

#[tauri::command]
pub async fn save_telegram_config(cfg: TelegramConfig) -> Result<(), String> {
    let mut current = load_bridge_configs().await?;
    current.telegram = cfg;
    write(&current)
}

#[tauri::command]
pub async fn save_whatsapp_config(cfg: WhatsAppConfig) -> Result<(), String> {
    let mut current = load_bridge_configs().await?;
    current.whatsapp = cfg;
    write(&current)
}

#[tauri::command]
pub async fn save_discord_config(cfg: DiscordConfig) -> Result<(), String> {
    let mut current = load_bridge_configs().await?;
    current.discord = cfg;
    write(&current)
}

#[tauri::command]
pub async fn save_slack_config(cfg: SlackConfig) -> Result<(), String> {
    let mut current = load_bridge_configs().await?;
    current.slack = cfg;
    write(&current)
}

#[tauri::command]
pub async fn save_email_config(cfg: EmailConfig) -> Result<(), String> {
    let mut current = load_bridge_configs().await?;
    current.email = cfg;
    write(&current)
}

#[tauri::command]
pub async fn save_line_config(cfg: LineConfig) -> Result<(), String> {
    let mut current = load_bridge_configs().await?;
    current.line = cfg;
    write(&current)
}

fn write(c: &BridgeConfigs) -> Result<(), String> {
    let Some(path) = config_path() else {
        return Err("no home directory".to_string());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(c)
        .map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_python_bridge_config_store() {
        let cfg = BridgeConfigs::default();
        // webhook_port 8911 + host 0.0.0.0 mirrors bridge_config_store.py:43-44
        assert_eq!(cfg.whatsapp.webhook_port, 8911);
        assert_eq!(cfg.whatsapp.webhook_host, "0.0.0.0");
        assert_eq!(cfg.telegram.auto_approve, false);
    }

    #[test]
    fn round_trip_through_json() {
        let original = BridgeConfigs {
            telegram: TelegramConfig {
                bot_token: "abc:def".into(),
                allowed_chat_ids: vec![123, 456],
                project_id: "p1".into(),
                auto_approve: true,
            },
            whatsapp: WhatsAppConfig {
                access_token: "EAA...".into(),
                phone_number_id: "999".into(),
                verify_token: "vt".into(),
                webhook_port: 8911,
                webhook_host: "0.0.0.0".into(),
                allowed_senders: vec!["+15551234567".into()],
                project_id: "p1".into(),
                auto_approve: false,
            },
            ..Default::default()
        };
        let s = serde_json::to_string(&original).unwrap();
        let back: BridgeConfigs = serde_json::from_str(&s).unwrap();
        assert_eq!(back.telegram.bot_token, "abc:def");
        assert_eq!(back.telegram.allowed_chat_ids, vec![123, 456]);
        assert_eq!(back.whatsapp.access_token, "EAA...");
        assert!(back.telegram.auto_approve);
    }

    #[test]
    fn legacy_python_json_parses() {
        // Exact shape bridge_config_store.py writes — must round-trip
        // cleanly so OwLLM Desktop and the legacy Python app stay
        // interoperable.
        let raw = r#"{
            "telegram": {
                "bot_token": "x",
                "allowed_chat_ids": [1, 2],
                "project_id": "p",
                "auto_approve": false
            },
            "whatsapp": {
                "access_token": "y",
                "phone_number_id": "12345",
                "verify_token": "v",
                "webhook_port": 8911,
                "webhook_host": "0.0.0.0",
                "allowed_senders": ["+15550001111"],
                "project_id": "p",
                "auto_approve": true
            }
        }"#;
        let parsed: BridgeConfigs = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.telegram.allowed_chat_ids, vec![1, 2]);
        assert_eq!(parsed.whatsapp.allowed_senders, vec!["+15550001111".to_string()]);
        assert!(parsed.whatsapp.auto_approve);
    }
}

//! Plan and step types — mirrors `bootstrap_go/plan/plan.go` so the
//! JSON wire format is identical across both implementations.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One executable step in a bootstrap plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    /// Action name — matches a key in the executor dispatch.
    pub action: String,

    /// Arbitrary action-specific arguments. Always a JSON object in
    /// practice; we store it as `Value` so adding new args doesn't
    /// require touching this struct.
    #[serde(default = "default_args")]
    pub args: Value,

    /// Optional human-readable reason the model emitted. Shown in
    /// logs and in `ask_user` prompts. Defaults to empty.
    #[serde(default)]
    pub reason: String,

    /// Optional fallback step if this one fails (forward-compat with
    /// the Go side; not yet consumed by the executor).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<Box<Step>>,
}

fn default_args() -> Value {
    Value::Object(serde_json::Map::new())
}

impl Default for Step {
    fn default() -> Self {
        Self {
            action: String::new(),
            args: default_args(),
            reason: String::new(),
            fallback: None,
        }
    }
}

impl Step {
    /// Test helper: `Step::action("set_env").with_args(json!({ ... }))`.
    /// Reduces test verbosity vs the full struct literal.
    pub fn new(action: impl Into<String>) -> Self {
        Self {
            action: action.into(),
            ..Default::default()
        }
    }

    pub fn with_args(mut self, args: Value) -> Self {
        self.args = args;
        self
    }

    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = reason.into();
        self
    }
}

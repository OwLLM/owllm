//! Plan and step types — minimal version so individual executors
//! can land without waiting for the full plan parser (Phase R4).
//!
//! `Step::args` is a JSON object (`serde_json::Value`) rather than a
//! typed struct so the action dispatcher can pass arbitrary
//! action-specific args through without bloating this module. Each
//! executor knows the args it expects and reads them via the helpers
//! in [`crate::args`].

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One executable step in a bootstrap plan.
///
/// Mirrors the Go `plan.Step` struct so the JSON wire format is
/// identical across both implementations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    /// Action name — matches a key in [`crate::exec::stubs::Executor::dispatch`].
    pub action: String,

    /// Arbitrary action-specific arguments. Always an object in
    /// practice; we store it as `Value` so adding new args doesn't
    /// require touching this struct.
    #[serde(default = "default_args")]
    pub args: Value,
}

fn default_args() -> Value {
    Value::Object(serde_json::Map::new())
}

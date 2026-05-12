//! Tolerant JSON parser for the supervisor's structured plan output.
//!
//! Port of `bootstrap_go/plan/plan.go::ParseSteps` and its helpers.
//! The model output is supposed to be either a `{"steps": [...]}`
//! envelope OR a bare array OR a single step. In practice models
//! wrap output in markdown fences, add trailing prose, or emit a
//! single object — the parser tries each shape in order and falls
//! back to balanced-brace recovery if the input contains noise.

use anyhow::{anyhow, Result};
use serde::Deserialize;

use crate::plan::Step;

/// Try the strict JSON shapes first; fall back to balanced-brace
/// recovery for fenced / prose-wrapped output.
pub fn parse_steps(text: &str) -> Result<Vec<Step>> {
    let cleaned = strip_fences(text);

    // Shape 1: { "steps": [ ... ] } — also accepts an extra "profile"
    // sibling that the model sometimes emits for context.
    #[derive(Deserialize)]
    struct WithSteps {
        steps: Vec<Step>,
    }
    if let Ok(env) = serde_json::from_str::<WithSteps>(cleaned) {
        if !env.steps.is_empty() {
            return Ok(env.steps);
        }
    }

    // Shape 2: bare JSON array
    if let Ok(arr) = serde_json::from_str::<Vec<Step>>(cleaned) {
        if !arr.is_empty() {
            return Ok(arr);
        }
    }

    // Shape 3: single Step object (the runtime supervisor's diagnose
    // path emits this when the model only proposed one action).
    if let Ok(single) = serde_json::from_str::<Step>(cleaned) {
        if !single.action.is_empty() {
            return Ok(vec![single]);
        }
    }

    // Shape 4: balanced-brace recovery — find the first {...} block
    // and parse it. Handles trailing prose, leading apology lines,
    // chatty preambles, etc.
    if let Some(obj) = extract_first_object(cleaned) {
        if let Ok(env) = serde_json::from_str::<WithSteps>(&obj) {
            if !env.steps.is_empty() {
                return Ok(env.steps);
            }
        }
        if let Ok(single) = serde_json::from_str::<Step>(&obj) {
            if !single.action.is_empty() {
                return Ok(vec![single]);
            }
        }
    }
    Err(anyhow!("could not parse plan from model output"))
}

/// Strip an outer ` ``` ` fenced code block (with or without a
/// language tag) and trim surrounding whitespace.
pub fn strip_fences(s: &str) -> &str {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix("```") {
        // Drop everything up to the first newline (handles ```json,
        // ```text, etc.). If there's no newline, we still strip the
        // fence — the body might be on the same line.
        let after_header = match rest.find('\n') {
            Some(idx) => &rest[idx + 1..],
            None => rest,
        };
        let trimmed = after_header.trim_end_matches('\n');
        let body = trimmed.strip_suffix("```").unwrap_or(trimmed);
        return body.trim();
    }
    s
}

/// Return the first top-level balanced `{ ... }` block as a slice of
/// the input. Returns `None` if no balanced block exists.
///
/// Operates on byte indices and assumes ASCII braces (`{` = 0x7B,
/// `}` = 0x7D), which are single bytes even in UTF-8 input. We
/// iterate char_indices to keep multi-byte char alignment correct.
pub fn extract_first_object(s: &str) -> Option<String> {
    let mut start: Option<usize> = None;
    let mut depth: i32 = 0;
    for (i, ch) in s.char_indices() {
        if ch == '{' {
            if start.is_none() {
                start = Some(i);
            }
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                if let Some(s_idx) = start {
                    return Some(s[s_idx..i + 1].to_string());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_array_parses() {
        let s = r#"[{"action":"create_venv","args":{"python_version":"3.11"}}]"#;
        let steps = parse_steps(s).expect("parses");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].action, "create_venv");
    }

    #[test]
    fn steps_envelope_parses() {
        let s = r#"{"profile":"cuda121","steps":[{"action":"install_pkg","args":{"name":"torch"}}]}"#;
        let steps = parse_steps(s).expect("parses");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].args["name"], "torch");
    }

    #[test]
    fn single_step_object_parses() {
        let s = r#"{"action":"abort","args":{"reason":"x"}}"#;
        let steps = parse_steps(s).expect("parses");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].action, "abort");
    }

    #[test]
    fn markdown_fence_stripped() {
        let s = "```json\n{\"action\":\"install_pkg\",\"args\":{}}\n```";
        let steps = parse_steps(s).expect("parses");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].action, "install_pkg");
    }

    #[test]
    fn fence_without_language_tag() {
        let s = "```\n{\"action\":\"abort\",\"args\":{}}\n```";
        let steps = parse_steps(s).expect("parses");
        assert_eq!(steps[0].action, "abort");
    }

    #[test]
    fn trailing_prose_recovered() {
        let s = "{\"action\":\"abort\",\"args\":{}}\n\nThis was hard to map.";
        let steps = parse_steps(s).expect("parses");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].action, "abort");
    }

    #[test]
    fn leading_prose_recovered() {
        // Brace-recovery should grab the JSON even when the model
        // prefixes a chatty preamble.
        let s = "Sure! Here's what I'd do:\n{\"action\":\"abort\",\"args\":{}}";
        let steps = parse_steps(s).expect("parses");
        assert_eq!(steps[0].action, "abort");
    }

    #[test]
    fn garbage_returns_error() {
        assert!(parse_steps("not json at all").is_err());
    }

    #[test]
    fn empty_steps_returns_error() {
        assert!(parse_steps(r#"{"steps": []}"#).is_err());
    }

    #[test]
    fn empty_bare_array_returns_error() {
        assert!(parse_steps("[]").is_err());
    }

    #[test]
    fn extract_first_object_handles_nested() {
        let input = "noise {a: {nested: 1}} trailing";
        let got = extract_first_object(input).expect("found");
        assert_eq!(got, "{a: {nested: 1}}");
    }

    #[test]
    fn extract_first_object_none_when_unbalanced() {
        assert!(extract_first_object("{ no closer").is_none());
        assert!(extract_first_object("no braces here").is_none());
    }
}

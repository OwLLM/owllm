//! pip requirement-string builder. Mirrors `buildPipSpec` from
//! `bootstrap_go/exec/install_pkg.go`. Used by both `install_pkg` and
//! `swap_wheel` so they stay consistent on how a (name, version,
//! extras) tuple is rendered to a pip CLI arg.

/// Compose a pip requirement string.
///
/// Examples:
///
/// ```text
/// build_pip_spec("torch", "", &[])                 == "torch"
/// build_pip_spec("torch", "2.5.1", &[])            == "torch==2.5.1"
/// build_pip_spec("torch", "2.5.1+cu121", &[])      == "torch==2.5.1+cu121"
/// build_pip_spec("foo",   "",         &["a", "b"]) == "foo[a,b]"
/// build_pip_spec("foo",   "1.0",      &["a"])      == "foo[a]==1.0"
/// ```
///
/// If the `name` already contains an inline version marker
/// (`= < > ~ !`), pass it through unchanged — the model has already
/// encoded the spec and we shouldn't double-suffix it.
pub fn build_pip_spec(name: &str, version: &str, extras: &[String]) -> String {
    let has_inline_version = name.contains(['=', '<', '>', '~', '!']);
    if has_inline_version {
        return name.to_string();
    }
    let mut out = String::from(name);
    if !extras.is_empty() {
        out.push('[');
        out.push_str(&extras.join(","));
        out.push(']');
    }
    if !version.is_empty() {
        out.push_str("==");
        out.push_str(version);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_name() {
        assert_eq!(build_pip_spec("torch", "", &[]), "torch");
    }

    #[test]
    fn name_and_version() {
        assert_eq!(build_pip_spec("torch", "2.5.1", &[]), "torch==2.5.1");
    }

    #[test]
    fn name_and_local_version() {
        assert_eq!(
            build_pip_spec("torch", "2.5.1+cu121", &[]),
            "torch==2.5.1+cu121"
        );
    }

    #[test]
    fn name_with_extras() {
        let extras = vec!["a".to_string(), "b".to_string()];
        assert_eq!(build_pip_spec("foo", "", &extras), "foo[a,b]");
    }

    #[test]
    fn name_with_extras_and_version() {
        let extras = vec!["a".to_string()];
        assert_eq!(build_pip_spec("foo", "1.0", &extras), "foo[a]==1.0");
    }

    #[test]
    fn inline_version_passes_through() {
        assert_eq!(build_pip_spec("torch>=2.4", "", &[]), "torch>=2.4");
    }

    #[test]
    fn inline_version_wins_over_explicit_version() {
        // If the model emits both `name: "torch==2.5.1"` and
        // `version: "ignored"`, the inline spec passes through.
        assert_eq!(build_pip_spec("torch==2.5.1", "ignored", &[]), "torch==2.5.1");
    }
}

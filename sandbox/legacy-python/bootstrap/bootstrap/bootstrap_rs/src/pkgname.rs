//! Pip distribution-name stripping. Mirrors `strippedPackageName`
//! from `bootstrap_go/exec/swap_wheel.go`.
//!
//! Used by `uninstall_pkg` (pip uninstall takes a bare distribution
//! name) and by `swap_wheel` (uninstall + re-install at a specific
//! version).

/// Returns just the distribution name, stripping any version markers
/// or extras that the model may have inlined into `name`.
///
/// Examples:
///
/// ```text
/// stripped_package_name("torch==2.5.1+cu121") == "torch"
/// stripped_package_name("torch>=2.4")         == "torch"
/// stripped_package_name("foo[a,b]")           == "foo"
/// stripped_package_name("torch")              == "torch"
/// ```
pub fn stripped_package_name(name: &str) -> String {
    let mut out = name.to_string();

    // Strip extras first ("foo[a,b]==1" -> "foo==1" -> later "foo").
    if let Some(open) = out.find('[') {
        if let Some(close_rel) = out[open..].find(']') {
            let close = open + close_rel;
            out.replace_range(open..=close, "");
        }
    }

    // Strip everything from the first version marker onward. Order
    // matters: longer markers must be checked first so "==" isn't
    // mistaken for two "=" or for ">=" vs ">".
    const MARKERS: &[&str] = &["==", ">=", "<=", "~=", "!=", ">", "<"];
    let mut cut: Option<usize> = None;
    for m in MARKERS {
        if let Some(idx) = out.find(m) {
            cut = Some(match cut {
                Some(existing) => existing.min(idx),
                None => idx,
            });
        }
    }
    if let Some(idx) = cut {
        out.truncate(idx);
    }

    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_equals_version() {
        assert_eq!(stripped_package_name("torch==2.5.1+cu121"), "torch");
    }

    #[test]
    fn strips_inequality_marker() {
        assert_eq!(stripped_package_name("torch>=2.4"), "torch");
        assert_eq!(stripped_package_name("torch<2.6"), "torch");
        assert_eq!(stripped_package_name("torch~=2.5"), "torch");
        assert_eq!(stripped_package_name("torch!=2.5.0"), "torch");
    }

    #[test]
    fn strips_extras_brackets() {
        assert_eq!(stripped_package_name("foo[a,b]"), "foo");
    }

    #[test]
    fn strips_extras_and_version() {
        assert_eq!(stripped_package_name("foo[a,b]==1.0"), "foo");
    }

    #[test]
    fn bare_name_unchanged() {
        assert_eq!(stripped_package_name("torch"), "torch");
    }

    #[test]
    fn trims_whitespace() {
        assert_eq!(stripped_package_name("  torch  "), "torch");
    }
}

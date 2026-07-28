// The single security-decision chokepoint.
//
// `authorize` is a PURE function of (command kind, per-controller policy). It is
// the only place that decides whether a remote command may run. Keeping it pure
// makes it exhaustively unit-testable and impossible to accidentally bypass with
// I/O or state. Every caller in the executor path routes through it.

use super::protocol::{Authorization, CommandKind, PermissionPolicy};

/// Decide whether `kind` is permitted under `policy`.
///
/// - `Diagnostics` is read-only and ALWAYS allowed (it is the default mode).
/// - `Shell` / `Wsl` need their toggle; otherwise denied.
/// - `FileWrite` / `Admin` are dangerous: even with the toggle on they return
///   `RequiresApproval` (a fresh target-side human OK), never a bare `Allowed`.
///
/// The `match` is exhaustive: adding a new `CommandKind` without a decision here
/// is a compile error, so a new surface can never ship ungated.
pub fn authorize(kind: CommandKind, policy: &PermissionPolicy) -> Authorization {
    use Authorization::*;
    use CommandKind::*;
    match kind {
        Diagnostics => Allowed,
        Shell => {
            if policy.allow_shell {
                Allowed
            } else {
                Denied
            }
        }
        Wsl => {
            if policy.allow_wsl {
                Allowed
            } else {
                Denied
            }
        }
        // Interactive PTY shell session = the shell tier.
        SessionOpen | SessionWrite | SessionRead | SessionResize | SessionClose => {
            if policy.allow_shell {
                Allowed
            } else {
                Denied
            }
        }
        // Screenshot (privacy-sensitive) and Inference (uses the target's GPU)
        // ride the shell tier: a controller trusted with shell already has this
        // reach, and same-account controllers get the standard full grant.
        Screenshot | Inference | ModelCatalog | ModelStart => {
            if policy.allow_shell {
                Allowed
            } else {
                Denied
            }
        }
        FileWrite => {
            if policy.allow_file_writes {
                RequiresApproval
            } else {
                Denied
            }
        }
        Admin => {
            if policy.allow_admin {
                RequiresApproval
            } else {
                Denied
            }
        }
    }
}

/// Human-readable decision label for the audit log / result envelope.
pub fn decision_label(a: Authorization) -> &'static str {
    match a {
        Authorization::Allowed => "allowed",
        Authorization::RequiresApproval => "requires_approval",
        Authorization::Denied => "denied",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_devices::protocol::{Authorization::*, CommandKind::*, PermissionPolicy};

    fn all_off() -> PermissionPolicy {
        PermissionPolicy::default()
    }

    #[test]
    fn default_is_read_only_diagnostics() {
        // The default policy (all toggles false) is the read-only mode: ONLY
        // diagnostics runs; every actioning kind is denied.
        let p = all_off();
        assert_eq!(authorize(Diagnostics, &p), Allowed);
        assert_eq!(authorize(Shell, &p), Denied);
        assert_eq!(authorize(Wsl, &p), Denied);
        assert_eq!(authorize(FileWrite, &p), Denied);
        assert_eq!(authorize(Admin, &p), Denied);
        assert_eq!(authorize(ModelCatalog, &p), Denied);
        assert_eq!(authorize(ModelStart, &p), Denied);
    }

    #[test]
    fn shell_toggle_only_unlocks_shell() {
        let mut p = all_off();
        p.allow_shell = true;
        assert_eq!(authorize(Shell, &p), Allowed);
        assert_eq!(authorize(ModelCatalog, &p), Allowed);
        assert_eq!(authorize(ModelStart, &p), Allowed);
        // ...and nothing else leaks open.
        assert_eq!(authorize(Wsl, &p), Denied);
        assert_eq!(authorize(FileWrite, &p), Denied);
        assert_eq!(authorize(Admin, &p), Denied);
    }

    #[test]
    fn wsl_toggle_only_unlocks_wsl() {
        let mut p = all_off();
        p.allow_wsl = true;
        assert_eq!(authorize(Wsl, &p), Allowed);
        assert_eq!(authorize(Shell, &p), Denied);
    }

    #[test]
    fn dangerous_kinds_never_bare_allowed() {
        // Even with the toggle ON, file-writes and admin require a fresh
        // target-side approval — they must NEVER return Allowed.
        let mut p = all_off();
        p.allow_file_writes = true;
        p.allow_admin = true;
        assert_eq!(authorize(FileWrite, &p), RequiresApproval);
        assert_eq!(authorize(Admin, &p), RequiresApproval);
        assert_ne!(authorize(FileWrite, &p), Allowed);
        assert_ne!(authorize(Admin, &p), Allowed);
    }

    #[test]
    fn diagnostics_ignores_all_toggles() {
        // Read-only diagnostics is allowed regardless of policy — turning
        // everything off must not break the safe, default capability.
        let mut p = all_off();
        assert_eq!(authorize(Diagnostics, &p), Allowed);
        p.allow_shell = true;
        p.allow_wsl = true;
        assert_eq!(authorize(Diagnostics, &p), Allowed);
    }
}

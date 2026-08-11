// Why a dedicated module: the subscription paths used to collapse two very
// different states into one sentence — "Claude Code CLI not detected — run
// `claude /login` first." That message is correct only when the binary is
// missing. When the CLI IS installed but its OAuth session expired and could
// not be refreshed (Claude Code deletes ~/.claude/.credentials.json in that
// case, so claude_cli flips false while claude_cli_installed stays true), the
// same sentence sent people hunting for a broken installation instead of
// re-running sign-in. accounts_status has always reported both booleans; only
// the UI ignored the second one.
//
// Kept pure + dependency-free so scripts/cli-auth-message.verify.run.mjs can
// exercise both branches without pulling in the Tauri bridge.

/// The two fields of `accounts_status` that describe a subscription CLI.
export type CliPresence = {
  /// Installed AND holding usable credentials.
  loggedIn: boolean;
  /// Binary resolves on PATH (or a known install dir), regardless of sign-in.
  installed: boolean;
};

/// Human-facing reason a subscription CLI cannot serve a request right now.
/// `label` is the product name, `loginHint` the exact command to re-authorise,
/// `installHint` the command that installs it.
export function cliUnavailableMessage(
  presence: CliPresence,
  label: string,
  loginHint: string,
  installHint: string,
): string {
  if (presence.installed) {
    return `${label} is installed but not signed in — its session expired and could not be refreshed. `
      + `Run \`${loginHint}\` in a terminal, then retry.`;
  }
  return `${label} not detected — install it (\`${installHint}\`) and run \`${loginHint}\`.`;
}

/// The subset of `accounts_status` the Claude subscription paths read. Both
/// flags matter: `claude_cli` alone cannot tell "missing" from "signed out".
export type ClaudeCliStatus = {
  claude_cli: boolean;
  claude_cli_installed: boolean;
};

export function claudeCliUnavailableMessage(presence: CliPresence): string {
  return cliUnavailableMessage(
    presence,
    "Claude Code CLI",
    "claude /login",
    "npm install -g @anthropic-ai/claude-code",
  );
}

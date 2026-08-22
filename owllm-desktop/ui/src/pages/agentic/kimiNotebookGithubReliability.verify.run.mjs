#!/usr/bin/env node
// Regression contract for three failures that otherwise look unrelated:
//  * Kimi CLI must stream JSON progress and fail fast on a revoked login.
//  * Failed notebook work stays active and explicitly re-feedable.
//  * Logging out of GitHub stops native and in-memory remote vault sync even
//    when Windows Git Credential Manager can still authenticate git itself.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");
const read = (relative) => fs.readFileSync(path.join(APP, relative), "utf8");
const accounts = read("src-tauri/src/accounts.rs");
const sandbox = read("src-tauri/src/sandbox.rs");
const accountsPage = read("ui/src/pages/advanced/AccountsPage.tsx");
const githubRs = read("src-tauri/src/github.rs");
const vaultRs = read("src-tauri/src/vault.rs");
const libRs = read("src-tauri/src/lib.rs");
const dispatch = read("ui/src/pages/agentic/dispatch.ts");
const agents = read("ui/src/pages/agentic/AgentsPage.tsx");
const codePage = read("ui/src/pages/agentic/CodePage.tsx");
const notebook = read("ui/src/pages/agentic/RunNotebook.tsx");
const githubTs = read("ui/src/pages/agentic/github.ts");
const vaultSync = read("ui/src/runtime/vaultSync.ts");
const localTools = read("ui/src/pages/agentic/localTools.ts");

let failed = 0;
function check(name, ok) {
  if (ok) console.log(`PASS ${name}`);
  else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

function legacyPromptTransportSafe(source) {
  return source.includes("fn kimi_prompt_uses_argv(new_flavor: bool, prompt_len: usize)")
    && source.includes("Ok(new_flavor)")
    && source.includes("kimi_prompt_uses_argv(child_new_flavor, prompt_value.len())?")
    && source.includes("fn kimi_prompt_transport_never_puts_legacy_team_prompts_on_argv()")
    && source.includes("kimi_prompt_uses_argv(false, KIMI_ARGV_BUDGET * 4)")
    && source.includes('"--input-format".into()')
    && source.includes('"text".into()')
    && source.includes("cmd.stdin(if use_prompt_flag { Stdio::null() } else { Stdio::piped() })")
    && source.includes("stdin.write_all(prompt_value.as_bytes())");
}

function kimiWslRelaySafe(source) {
  return source.includes("write_cli_config_wsl(&app, cwd.as_deref())")
    && source.includes("is_unrestricted_tool_allowlist(allowed_tools.as_ref())")
    && source.includes('program_argv_unjailed(cwd.as_deref(), "kimi", &args)')
    && source.includes('args.push("--mcp-config-file".into())')
    && source.includes("required browser gateway was not wired");
}

function soloRelayCoversSubscriptionClis(source) {
  const generalistGrants = source.match(
    /browser_role \|\| is_unrestricted_tool_allowlist\(allowed_tools\.as_ref\(\)\)/g,
  ) ?? [];
  return generalistGrants.length >= 3
    && (source.match(/gateway_host_run/g) ?? []).length >= 6
    && source.includes('program_argv_unjailed(cwd.as_deref(), "claude", args)')
    && source.includes('program_argv_unjailed(cwd.as_deref(), "codex", &args)')
    && source.includes('program_argv_unjailed(cwd.as_deref(), "kimi", &args)');
}

check(
  "Kimi uses line-streamed JSON rather than final-message-only text",
  accounts.includes("wait_cli_child_lines")
    && accounts.includes("--output-format")
    && accounts.includes("stream-json")
    && accounts.includes("parse_kimi_stream_line")
    && accounts.includes("kimi_stream_json_emits_thinking_text_tools_and_results"),
);
check(
  "legacy Kimi streams prompts over stdin so WSL base64 cannot overflow CreateProcessW",
  legacyPromptTransportSafe(accounts),
);
check(
  "WSL Kimi receives the authenticated browser relay and Solo uses the interop-capable route",
  kimiWslRelaySafe(accounts),
);
check(
  "Solo Generalist gets the WSL browser relay across Claude, Codex, and Kimi",
  soloRelayCoversSubscriptionClis(accounts),
);
check(
  "macOS/Linux Browser and Solo roles launch host CLIs where the host gateway is reachable",
  sandbox.includes("pub fn program_argv_unjailed(")
    && sandbox.includes("Linux bwrap hides the real home/config and Lima has its")
    && /#\[cfg\(not\(windows\)\)\][\s\S]{0,260}pub fn program_argv_unjailed\([\s\S]{0,220}\{\s*None\s*\}/.test(sandbox),
);
check(
  "Kimi receives authoritative runtime identity instead of Claude-specific inference bait",
  accounts.includes("RUNTIME IDENTITY: You are running through Kimi CLI, not Claude Code CLI.")
    && accounts.includes("MCP tools under their bare names")
    && accounts.includes("do not invent a mcp__owllm__ prefix")
    && accounts.includes("do not look")
    && !localTools.includes("IF (and only if) you are the Claude "),
);
check(
  "Kimi argv guard detects the July 27 regression shape",
  !legacyPromptTransportSafe(
    accounts
      .replace(
        "let use_prompt_flag = kimi_prompt_uses_argv(child_new_flavor, prompt_value.len())?;",
        "let use_prompt_flag = prompt_value.len() <= KIMI_ARGV_BUDGET;",
      )
      .replace(
        "assert!(!kimi_prompt_uses_argv(false, KIMI_ARGV_BUDGET * 4).unwrap());",
        "assert!(kimi_prompt_uses_argv(false, KIMI_ARGV_BUDGET * 4).unwrap());",
      ),
  ),
);
check(
  "Kimi browser relay guard detects the old WSL tool-blind launch shape",
  !kimiWslRelaySafe(
    accounts
      .replace(
        'crate::sandbox::program_argv_unjailed(cwd.as_deref(), "kimi", &args)',
        'crate::sandbox::program_argv(cwd.as_deref(), "kimi", &args)',
      )
      .replace(
        "write_cli_config_wsl(&app, cwd.as_deref())",
        "write_cli_config(&app)",
      ),
  ),
);
check(
  "subscription-wide Solo relay guard detects specialist-only jail exceptions",
  !soloRelayCoversSubscriptionClis(
    accounts.replaceAll(
      "browser_role || is_unrestricted_tool_allowlist(allowed_tools.as_ref())",
      "browser_role",
    ),
  ),
);
check(
  "Kimi stream command is registered and consumed by both agent routes",
  libRs.includes("accounts::kimi_cli_stream")
    && dispatch.includes('invoke<string>("kimi_cli_stream"')
    && dispatch.includes("export async function runKimiCliStream")
    // AgentsPage no longer carries its own Kimi path — it rides the ONE
    // shared router (its ~1000-line dispatch copy was collapsed 2026-08-14),
    // which is also what fixed team-path Kimi images being silently dropped.
    && agents.includes("streamChatCompletion,"),
);
check(
  "revoked Kimi OAuth fails fast with a reconnect instruction",
  dispatch.includes("isCliReauthRequired")
    && dispatch.includes("kimiReconnectMessage")
    && dispatch.includes("choose Disconnect, then Login again")
    && dispatch.includes('backend === "kimi_cli" && isCliReauthRequired'),
);
check(
  "revoked Kimi credentials persist as disconnected until a fresh login replaces them",
  accounts.includes("fn mark_kimi_reauth_required()")
    && accounts.includes("fn kimi_reauth_required()")
    && accounts.includes("kimi_cli_reauth_required")
    && accounts.includes("api key appears to be invalid")
    && accounts.includes("authorization grant is invalid")
    && accountsPage.includes("Session expired · reconnect required")
    && accountsPage.includes('state.reauthRequired || state.remediation === "reauth" ? "Reconnect"')
    && accountsPage.includes("if (resetStaleLogin)")
    && accountsPage.includes("Removed the expired ${provider.name} session. Starting a fresh login."),
);
// The other half of that invariant (2026-08-14): only a CONFIRMED revocation
// may write the marker. The old rule marked on ANY 401 ("kimi_output_auth_failed"
// matches a bare 401/unauthorized), so one transient cold-token blip flipped
// the whole account to "Reconnect" and every later dispatch refused with
// "that model isn't signed in" — permanently, because the marker itself
// blocks the runs that could have proven the credential alive.
check(
  "a transient Kimi 401 can NOT write the persistent reauth marker",
  accounts.includes("fn kimi_output_reauth_required")
    // every run-path marking is gated on the confirmed-revocation predicate…
    && !/kimi_output_auth_failed\([^)]*\)\s*\{\s*\n\s*mark_kimi_reauth_required/.test(accounts)
    // …and the probe distinguishes retryable from revoked.
    && accounts.includes("the token may be cold or mid-refresh; retrying usually recovers"),
);
check(
  "a successful live probe heals a stale reauth marker",
  /if res\.0 \{\s*\n\s*clear_kimi_reauth_required\(\);/.test(accounts),
);
check(
  "failed notebook cards remain active and expose Re-feed",
  // Both pages route their run-end outcome through settleNotebookStep now, so
  // assert the "failed" arm of that shared helper plus each page's reason,
  // rather than the direct markNotebookStepFailed calls they used to make.
  notebook.includes('status: "failed"')
    && notebook.includes("export function markNotebookStepFailed")
    && notebook.includes("else markNotebookStepFailed(projectId, stepId, outcome.reason, at);")
    && notebook.includes('s.status === "sent" && s.finishedAt != null')
    && notebook.includes('s.status === "failed" ? "Re-feed"')
    && agents.includes('{ kind: "failed", reason: notebookPauseReason }')
    && agents.includes("singleRunFailureReason = cleanAgentError(e)")
    && codePage.includes("failureReason = aborted ?")
    && codePage.includes('{ kind: "failed", reason: failureReason }'),
);
check(
  "native vault operations require the current OWLLM GitHub session",
  vaultRs.includes("fn connected_vault_dir()")
    && vaultRs.includes("token_and_login().ok_or_else")
    && (vaultRs.match(/connected_vault_dir\(\)\?/g) || []).length >= 10,
);
check(
  "GitHub logout cannot report success while app secrets remain",
  githubRs.includes('accounts_delete_secret("GITHUB_TOKEN".to_string())?')
    && githubRs.includes('accounts_delete_secret("GITHUB_LOGIN".to_string())?')
    && !githubRs.includes('let _ = crate::accounts::accounts_delete_secret("GITHUB_TOKEN"'),
);
check(
  "GitHub logout immediately stops the live vault timers",
  githubTs.includes('window.dispatchEvent(new CustomEvent("owllm:vault-disconnected"))')
    && vaultSync.includes("export function stopVaultSync")
    && vaultSync.includes("_enabled = false")
    && vaultSync.includes('window.addEventListener("owllm:vault-disconnected", stopVaultSync)'),
);

if (failed) {
  console.error(`kimiNotebookGithubReliability: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("kimiNotebookGithubReliability: all checks passed");

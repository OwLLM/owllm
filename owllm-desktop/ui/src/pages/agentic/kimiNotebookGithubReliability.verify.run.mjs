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

let failed = 0;
function check(name, ok) {
  if (ok) console.log(`PASS ${name}`);
  else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
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
  accounts.includes("let use_prompt_flag = new_flavor;")
    && accounts.includes('"--input-format".into()')
    && accounts.includes('"text".into()')
    && accounts.includes("cmd.stdin(if use_prompt_flag { Stdio::null() } else { Stdio::piped() })")
    && accounts.includes("stdin.write_all(prompt_value.as_bytes())"),
);
check(
  "Kimi stream command is registered and consumed by both agent routes",
  libRs.includes("accounts::kimi_cli_stream")
    && dispatch.includes('invoke<string>("kimi_cli_stream"')
    && dispatch.includes("export async function runKimiCliStream")
    && agents.includes("runKimiCliStream"),
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

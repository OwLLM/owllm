import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../../../..");
const read = (relative) => fs.readFileSync(path.join(DESKTOP, relative), "utf8").replace(/\r\n/g, "\n");
let passed = 0;
const check = (condition, message) => {
  if (!condition) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`PASS ${message}`);
};

const wsl = read("src-tauri/src/wsl.rs");
const parser = wsl.slice(
  wsl.indexOf("fn parse_distro_list_output"),
  wsl.indexOf("fn list_distros_once"),
);
check(
  parser.includes("if !success") && parser.indexOf("if !success") < parser.indexOf("let raw:"),
  "a failed wsl.exe distro probe is rejected before stdout is parsed",
);
check(
  wsl.includes("failed_distro_probe_never_parses_help_banner_as_a_distro")
    && wsl.includes("help text became distros"),
  "the exact non-zero help-banner regression is covered by a Rust unit test",
);
check(
  // The probe moved off the UI thread into spawn_blocking, so the read that
  // normalizes is now wsl_isolation_get_blocking; the invariant is unchanged.
  /pub fn wsl_isolation_get_blocking\(\)[\s\S]{0,400}normalize_isolation_distro\(cfg\)/.test(wsl)
    && /fn normalize_isolation_distro[\s\S]{0,900}eq_ignore_ascii_case/.test(wsl),
  "corrupt persisted distro preferences are normalized against the live list",
);

const agents = read("ui/src/pages/agentic/AgentsPage.tsx");
check(
  agents.includes('data-ui="AgentRunError"')
    && agents.includes('role="alert"')
    && /data-ui="AgentRunError"[\s\S]{0,900}\{runError\}/.test(agents),
  "agent preflight failures are visibly rendered instead of silently stopping",
);

const sandbox = read("src-tauri/src/sandbox.rs");
check(
  sandbox.includes("pub struct WarmCheckResult")
    && sandbox.includes("host_fallback: Option<String>")
    && sandbox.includes("reason: Option<String>"),
  "sandbox_warm_and_check returns diagnostics plus a host fallback path",
);
check(
  sandbox.includes("fn wsl_unc_to_host_path")
    && sandbox.includes("Folder not reachable through WSL distro")
    && sandbox.includes("WSL command failed:"),
  "WSL failures expose a precise reason instead of a generic WSL-starting message",
);
check(
  agents.includes("type WarmCheckResult = { reachable: boolean; host_fallback: string | null; reason: string | null }")
    && /effectiveRunCwd = fallback/.test(agents)
    && /projectCwd = effectiveRunCwd/.test(agents),
  "UI falls back to the host folder and runs the rest of dispatch from it",
);
check(
  agents.includes("WSL isolation path not reachable — running on the host folder")
    && /sync_project_skills.*cwd: effectiveRunCwd/.test(agents),
  "fallback is announced to the user and skill sync uses the host cwd",
);

console.log(`wsl agent-dispatch preflight verification: ${passed}/${passed} passed`);

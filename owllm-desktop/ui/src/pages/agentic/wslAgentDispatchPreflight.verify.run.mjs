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
// WarmCheckResult crosses the Tauri boundary through serde. It is
// `#[serde(rename_all = "camelCase")]`, so the fallback field arrives as
// `hostFallback` — and the UI read `host_fallback` for two releases, making the
// host-fallback branch permanently `undefined`. Every WSL start failure
// (0x800705aa CreateVm on a resource-starved host) therefore BLOCKED the run
// instead of degrading to the real Windows folder. `reachable`/`reason` are
// single words, so they survived the mismatch and the banner still looked
// informative — which is exactly why this hid for so long. Pin the casing
// contract itself, not a literal type line: assert the Rust rename attribute
// and that the UI reads the camelCase spelling and NEVER the snake_case one.
check(
  /#\[serde\(rename_all = "camelCase"\)\]\s*pub struct WarmCheckResult/.test(sandbox),
  "WarmCheckResult declares the camelCase wire contract it is read through",
);
check(
  /type WarmCheckResult = \{[^}]*hostFallback: string \| null[^}]*\}/.test(agents)
    && /check\?\.hostFallback/.test(agents)
    && !/host_fallback/.test(agents)
    && /effectiveRunCwd = fallback/.test(agents)
    && /projectCwd = effectiveRunCwd/.test(agents),
  "UI reads the camelCase fallback field and runs the rest of dispatch from it",
);
// A WEDGED WSL must degrade like a failed one — the timeout arm returning
// host_fallback: None was the last path that could still block a run outright.
check(
  /timed out — the distro may be starting/.test(sandbox)
    && /host_fallback: wsl_unc_to_host_path\(&cwd_for_timeout\)/.test(sandbox),
  "a timed-out WSL warm/check still offers the host folder instead of blocking",
);
check(
  agents.includes("WSL isolation path not reachable — running on the host folder")
    && /sync_project_skills.*cwd: effectiveRunCwd/.test(agents),
  "fallback is announced to the user and skill sync uses the host cwd",
);

// ── In-distro scripts are BOUNDED (2026-08-14 audit) ────────────────────────
// run_in_distro_script_user used wait_with_output() with no ceiling, so a
// wedged wsl.exe (cold-start hang, dead 9P server) stalled CLI prepare /
// sandbox probes / login sync forever — the invisible half of the historical
// "wsl exited 1" run-killer family. Every caller now inherits a ceiling, the
// child is KILLED at the deadline, and the error names the remedy.
check(
  wsl.includes("const WSL_SCRIPT_TIMEOUT: Duration")
    && /pub fn run_in_distro_script_user\([\s\S]{0,300}run_in_distro_script_user_with_timeout\(distro, user, script, WSL_SCRIPT_TIMEOUT\)/.test(wsl),
  "every in-distro script inherits the shared liveness ceiling",
);
check(
  /Instant::now\(\) >= deadline[\s\S]{0,300}child\.kill\(\)/.test(wsl)
    && wsl.includes("wsl script timed out after"),
  "a wedged wsl.exe is killed at the deadline with an actionable error",
);
check(
  /read_to_end/.test(wsl.slice(wsl.indexOf("pub fn run_in_distro_script_user_with_timeout"))),
  "both pipes are drained on threads so a chatty script can't dead-lock the poll",
);
{
  const setup = read("src-tauri/src/wsl_setup.rs");
  check(
    setup.includes("run_in_distro_script_user_with_timeout")
      && setup.includes("60 * 60"),
    "guided-setup installs opt into an explicit longer ceiling, not no bound",
  );
}

console.log(`wsl agent-dispatch preflight verification: ${passed}/${passed} passed`);

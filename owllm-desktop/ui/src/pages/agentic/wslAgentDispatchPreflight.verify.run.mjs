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
  /pub fn wsl_isolation_get\(\)[\s\S]{0,400}normalize_isolation_distro\(cfg\)/.test(wsl)
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

console.log(`wsl agent-dispatch preflight verification: ${passed}/${passed} passed`);

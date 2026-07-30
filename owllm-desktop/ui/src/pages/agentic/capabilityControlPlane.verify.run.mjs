import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const local = fs.readFileSync(path.join(here, "localTools.ts"), "utf8");
const rustRoot = path.resolve(here, "../../../../src-tauri/src");
const mcp = fs.readFileSync(path.join(rustRoot, "mcp.rs"), "utf8");
const gateway = fs.readFileSync(path.join(rustRoot, "mcp_gateway.rs"), "utf8");
const lib = fs.readFileSync(path.join(rustRoot, "lib.rs"), "utf8");
const personalTeams = fs.readFileSync(path.join(rustRoot, "personal_agent_teams.rs"), "utf8");

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

const hasCliControlPlane = source =>
  source.includes('"name": "mcp_search_capabilities"') &&
  source.includes('"name": "mcp_install_curated"') &&
  source.includes('"name": "mcp_call_connected"') &&
  source.includes("crate::mcp::mcp_install_curated");
const requiresVerifiedHandshake = source =>
  source.includes("status.tools.is_empty()") &&
  source.includes('"verified": true');

check("discovery and install are universal local/API tools",
  local.includes('"mcp_search_capabilities"') &&
  local.includes('"mcp_install_curated"') &&
  local.includes('"mcp_call_connected"') &&
  local.includes("CAPABILITY_TOOL_NAMES.has(t.name)"));
check("local/API execution reaches the native MCP control plane",
  local.includes('case "mcp_search_capabilities"') &&
  local.includes('invoke<unknown>("mcp_install_curated"'));
check("subscription CLIs receive both tools through the OWLLM gateway",
  hasCliControlPlane(gateway));
check("Tauri registers both commands",
  lib.includes("mcp::mcp_search_capabilities") &&
  lib.includes("mcp::mcp_install_curated"));
check("persistent personal-agent teams use the same control plane",
  personalTeams.includes('"mcp_search_capabilities"') &&
  personalTeams.includes("crate::mcp::mcp_search_capabilities") &&
  personalTeams.includes('"mcp_install_curated"') &&
  personalTeams.includes("crate::mcp::mcp_install_curated") &&
  personalTeams.includes('"mcp_call_connected"') &&
  personalTeams.includes("crate::mcp::mcp_call_tool"));
check("arbitrary internet packages are rejected",
  mcp.includes("not in OWLLM's reviewed MCP catalog") &&
  mcp.includes("CURATED_MCPS"));
check("credentialed MCPs fail closed without secrets in tool arguments",
  mcp.includes('"status": "needs_configuration"') &&
  mcp.includes("required_env") &&
  !local.match(/name: "mcp_install_curated"[\s\S]{0,1400}api[_ -]?key/i));
check("install completion requires a live tools/list handshake",
  requiresVerifiedHandshake(mcp));
check("the original task can resume in the same tool loop",
  local.includes('case "mcp_call_connected"') &&
  local.includes('invoke<string>("mcp_call_tool"') &&
  gateway.includes('"mcp_call_connected" =>') &&
  mcp.includes('"next": "Call mcp_call_connected'));
check("workspace placeholders resolve at runtime",
  mcp.includes('if *arg == "{{WORKSPACE}}"') &&
  !mcp.includes("C:\\\\1_Git"));
check("negative control catches a CLI path that loses installation",
  !hasCliControlPlane(gateway.replaceAll("mcp_install_curated", "mcp_install_removed")));
check("negative control catches success without tools/list verification",
  !requiresVerifiedHandshake(mcp.replace("status.tools.is_empty()", "false")));

console.log(`\ncapabilityControlPlane.verify: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

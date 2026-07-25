// Focused verification for the three remote-device capabilities added on
// 2026-07-24: (1) agent remote-device access auto-ON for SAME-ACCOUNT machines,
// (2) a remote Screenshot command, and (3) routing inference through the
// encrypted device channel. Source-level structural assertions across the Rust
// backend + TS UI (no browser/React/Tauri runtime). Lives in pages/agentic/ so
// the smoke matrix auto-discovers it. Pins the wiring so a squash merge can't
// silently revert it (the recurring reinfection hazard in this repo).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// CRLF-robust read: Windows core.autocrlf checks LF-committed files out as CRLF,
// so a needle containing \n would false-fail on a CRLF working tree.
const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`✓ ${message}`);
}

const T = "../../../../src-tauri/src"; // ui/src/pages/agentic → owllm-desktop
const mod = read(`${T}/remote_devices/mod.rs`);
const protocol = read(`${T}/remote_devices/protocol.rs`);
const policy = read(`${T}/remote_devices/policy.rs`);
const executor = read(`${T}/remote_devices/executor.rs`);
const support = read(`${T}/support.rs`);
const lib = read(`${T}/lib.rs`);
const inferenceEndpoint = read("./inferenceEndpoint.ts");
const dispatch = read("./dispatch.ts");
const localTools = read("./localTools.ts");
const remoteDevicesTs = read("../advanced/remoteDevices.ts");
const devicesPage = read("../advanced/DevicesPage.tsx");
const serverPage = read("../core/ServerPage.tsx");

// ── 1. Agent access auto-ON for same-account only ─────────────────────────
check(
  /fn agents_allowed\(\)[\s\S]*?unwrap_or_else\(\|\| github_login\(\)\.is_some\(\)\)/.test(mod),
  "agents_allowed() defaults to github_login().is_some() (auto-ON for same-account, mirrors feature_enabled)",
);
check(
  mod.includes(".get(\"agents_allowed\")"),
  "an explicit agents_allowed config value still wins (read before the github fallback)",
);

// ── 2. Remote Screenshot ──────────────────────────────────────────────────
check(protocol.includes("Screenshot,"), "protocol: CommandKind has a Screenshot variant");
check(protocol.includes("pub image: Option<String>"), "protocol: CommandResult carries an image (base64 PNG) field");
check(
  policy.includes("Screenshot | Inference | ModelCatalog | ModelStart =>"),
  "policy: Screenshot + Inference + remote model control gated together",
);
check(
  /Screenshot \| Inference \| ModelCatalog \| ModelStart =>\s*\{\s*if policy\.allow_shell/.test(policy),
  "policy: Screenshot/Inference gated by allow_shell (frictionless for same-account, blocked otherwise)",
);
check(executor.includes("CommandKind::Screenshot => take_screenshot"), "executor: Screenshot routed to take_screenshot");
check(executor.includes("async fn take_screenshot"), "executor: take_screenshot implemented");
check(support.includes("pub(crate) async fn capture_screen_png"), "support: shared capture_screen_png entry point");
check(support.includes("fn capture_virtual_screen_rgba") && support.includes("BitBlt"), "support: Windows full-screen BitBlt capture");
check(support.includes("pub(crate) fn encode_png"), "support: encode_png reused (no new capture crate added)");
check(mod.includes('CommandKind::Screenshot => "screenshot"'), "mod: audit label covers Screenshot (exhaustive kind_str)");
check(mod.includes("pub fn device_save_screenshot"), "mod: device_save_screenshot command saves the PNG to .owllm-inbox");
check(lib.includes("remote_devices::device_save_screenshot"), "lib: device_save_screenshot is registered as a Tauri command");
check(remoteDevicesTs.includes('"screenshot"') && remoteDevicesTs.includes("image?: string | null"), "remoteDevices.ts: screenshot kind + image field typed");
check(devicesPage.includes('<option value="screenshot">'), "DevicesPage: Screenshot is a console command option");
check(devicesPage.includes("data:image/png;base64,") && devicesPage.includes("res.image"), "DevicesPage: renders the returned screenshot image");
check(localTools.includes('name: "device_screenshot"'), "localTools: device_screenshot agent tool exists");
check(
  localTools.includes('kind: "screenshot"') && localTools.includes('"device_save_screenshot"'),
  "localTools: device_screenshot sends the screenshot kind and saves the PNG for the vision path",
);

// ── 3. Inference over the device channel ──────────────────────────────────
check(protocol.includes("Inference,"), "protocol: CommandKind has an Inference variant");
check(executor.includes("CommandKind::Inference => run_inference"), "executor: Inference routed to run_inference");
check(
  executor.includes("async fn run_inference") && executor.includes("/v1/chat/completions"),
  "executor: run_inference proxies to the target's local llama-server",
);
check(mod.includes("pub(crate) async fn local_inference_endpoint"), "mod: local_inference_endpoint resolves the device's own server port + key");
check(
  inferenceEndpoint.includes('"local" | "remote" | "device"'),
  "inferenceEndpoint: a 'device' inference mode exists",
);
check(
  inferenceEndpoint.includes("ep.mode === \"device\"") &&
    inferenceEndpoint.includes("id: ep.deviceId") &&
    inferenceEndpoint.includes("modelId: ep.remoteModelId"),
  "inferenceEndpoint: resolveInferenceBase returns a device target in device mode",
);
check(dispatch.includes("async function deviceChatCompletion"), "dispatch: deviceChatCompletion helper (sealed-channel round-trip)");
check(
  dispatch.includes('kind: "inference"') && dispatch.includes("if (infer.device)"),
  "dispatch: routes inference through the device channel when a device endpoint is selected",
);
check(
  serverPage.includes('["local", "remote", "device"]') && serverPage.includes("Paired device"),
  "ServerPage: inference-source card offers a Paired device option with a picker",
);

console.log(`OK remote device capabilities: ${passed}/${passed} checks passed`);

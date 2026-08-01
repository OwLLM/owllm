// Paired-device model routing guard.
//
// Pairing PC A with PC B always carried a working inference transport, but the
// model picker never listed the peer's models, so the feature was invisible.
// Peer models are now addressed as `device/<deviceId>/<modelId>`; this pins the
// two things that break SILENTLY if that encoding drifts:
//
//   1. the id round-trips (a peer model resolves back to the right device), and
//   2. the BARE model id — not the routed one — is what reaches the peer's
//      llama-server, which would otherwise answer "unknown model".
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
function check(condition, message) {
  assert.ok(condition, `FAIL ${message}`);
  passed += 1;
  console.log(`OK ${message}`);
}

// peerCatalogue.ts pulls in the Tauri bridge for the network refresh, which
// can't load under plain node — stub it, the id helpers don't touch it.
const stubPlugin = {
  name: "stub-remote-devices",
  setup(build) {
    build.onResolve({ filter: /remoteDevices$/ }, (a) => ({ path: a.path, namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export const listDevices = async () => []; export const listRemoteModels = async () => ({});",
      loader: "js",
    }));
  },
};

const bundled = await esbuild.build({
  entryPoints: [path.join(HERE, "peerCatalogue.ts")],
  bundle: true, write: false, format: "esm", platform: "neutral",
  plugins: [stubPlugin],
});
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

const {
  DEVICE_PREFIX,
  encodeDeviceModel,
  parseDeviceModel,
  requiresManagedLocalServer,
} = mod;

// --- round-trip ---------------------------------------------------------
const id = encodeDeviceModel("dev-abc123", "qwen3-coder-30b.Q4_K_M.gguf");
check(id === "device/dev-abc123/qwen3-coder-30b.Q4_K_M.gguf",
  "a peer model encodes as device/<deviceId>/<modelId>");
check(parseDeviceModel(id)?.deviceId === "dev-abc123",
  "the device id round-trips out of the encoded model id");
check(parseDeviceModel(id)?.modelId === "qwen3-coder-30b.Q4_K_M.gguf",
  "the bare model id round-trips out of the encoded model id");

// A transformers-style model id contains "/" — only the FIRST separator after
// the device id may split, or the model name is truncated.
const nested = encodeDeviceModel("dev-1", "Qwen/Qwen3-8B");
check(parseDeviceModel(nested)?.modelId === "Qwen/Qwen3-8B",
  "a model id containing '/' survives the round-trip intact");

// --- non-peer ids must not be captured ----------------------------------
for (const other of ["", "sub/claude-opus-4-7", "api/gpt-5", "auto/cheapest", "llama-3.gguf"]) {
  check(parseDeviceModel(other) === null,
    `a non-peer id is not mistaken for a peer model: ${other || "(empty)"}`);
}
check(parseDeviceModel("device/dev-1") === null, "a device id with no model is rejected");
check(parseDeviceModel("device/dev-1/") === null, "a trailing separator with no model is rejected");
check(requiresManagedLocalServer("local.gguf", "local"),
  "a local GGUF requires this PC's managed server");
check(requiresManagedLocalServer("tuned.gguf", "tuned"),
  "a tuned GGUF requires this PC's managed server");
check(!requiresManagedLocalServer(id, "local"),
  "a paired-device model does not start this PC's managed server");

// --- the dispatch seam --------------------------------------------------
const dispatch = fs.readFileSync(path.join(HERE, "dispatch.ts"), "utf8");
check(/const peer = parseDeviceModel\(id\);\s*\n\s*if \(peer\) return peer\.modelId;/.test(dispatch),
  "stripModelPrefix unwraps a peer id to the bare model id");
check(dispatch.includes("model: stripModelPrefix(p.modelId) || \"local\","),
  "the peer receives the BARE model id, not the routed device/... form");
check(dispatch.includes("const pinnedPeer = parseDeviceModel(p.modelId);"),
  "a peer selection pins this call's route without changing the global endpoint");
check(/if \(modelId\.startsWith\(DEVICE_PREFIX\)\) return "local";/.test(dispatch),
  "providerFor sends peer models down the llama-server dispatch path");

// --- the picker surfaces them -------------------------------------------
const picker = fs.readFileSync(path.join(HERE, "ModelPicker.tsx"), "utf8");
check(picker.includes('remote:     { label: "PAIRED DEVICES"'),
  "the picker has a PAIRED DEVICES section");
check(/"local", "tuned", "remote",/.test(picker),
  "the PAIRED DEVICES section is ordered with the other llama-server models");
check(picker.includes("for (const peer of getPeerCatalogue())"),
  "buildEntries lists every paired device's models");

const codePage = fs.readFileSync(path.join(HERE, "CodePage.tsx"), "utf8");
check(codePage.includes("requiresManagedLocalServer(modelId, provider)"),
  "Code chat distinguishes a paired route from a model managed on this PC");
check(codePage.includes("requiresManagedLocalServer(secModel, provider)"),
  "the secondary Code agent distinguishes a paired route from a local model");

const agentsPage = fs.readFileSync(path.join(HERE, "AgentsPage.tsx"), "utf8");
check(agentsPage.includes("requiresManagedLocalServer(supModelId, supProvider)"),
  "Solo chat does not pre-start paired-device model ids locally");
check(agentsPage.includes("requiresManagedLocalServer(dockModelId, dockProvider)"),
  "the team Load control does not offer a local load for paired-device models");

const playground = fs.readFileSync(path.join(HERE, "../finetuning/ChatPage.tsx"), "utf8");
check(playground.includes("(!isLocalProvider || !managedHere)"),
  "the chat playground sends paired models through shared remote dispatch");

const datasetBuilder = fs.readFileSync(path.join(HERE, "../finetuning/DatasetBuilderPage.tsx"), "utf8");
check(datasetBuilder.includes("!requiresManagedLocalServer(modelId, provider)"),
  "dataset generation does not pre-start paired-device model ids locally");

const watcher = fs.readFileSync(path.join(HERE, "../../support/WatcherDrawer.tsx"), "utf8");
check(watcher.includes("!requiresManagedLocalServer(pickedModel, prov)"),
  "Watcher preserves an explicitly selected paired-device route");

console.log(`\nall ${passed} peer-catalogue checks passed`);

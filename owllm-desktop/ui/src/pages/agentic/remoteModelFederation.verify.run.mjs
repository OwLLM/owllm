import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ui = (rel) => fs.readFileSync(path.resolve(here, rel), "utf8");
const rust = (rel) => fs.readFileSync(path.resolve(here, "../../../../src-tauri/src", rel), "utf8");

const protocol = rust("remote_devices/protocol.rs");
const policy = rust("remote_devices/policy.rs");
const executor = rust("remote_devices/executor.rs");
const serverPage = ui("../core/ServerPage.tsx");
const devicesPage = ui("../advanced/DevicesPage.tsx");
const remoteDevices = ui("../advanced/remoteDevices.ts");
const endpoint = ui("./inferenceEndpoint.ts");
const dispatch = ui("./dispatch.ts");

const checks = [
  ["wire protocol advertises a protected model catalogue", protocol.includes("ModelCatalog")],
  ["wire protocol supports selecting and starting a remote model", protocol.includes("ModelStart")],
  ["catalogue and start commands share the inference permission tier",
    policy.includes("Screenshot | Inference | ModelCatalog | ModelStart")],
  ["target catalogue exports only runnable local/tuned models",
    executor.includes('m.provider == "local" || m.provider == "tuned"') && executor.includes("m.port.is_some()")],
  ["target can switch its managed server without arbitrary shell",
    executor.includes("ensure_model_running") && executor.includes("crate::server::server_start(")],
  ["inference removes the private routing field before llama-server",
    executor.includes('remove("owllm_remote_model")')],
  ["typed desktop bindings expose catalogue and start",
    remoteDevices.includes("listRemoteModels") && remoteDevices.includes("startRemoteModel")],
  ["Devices displays remote model availability",
    devicesPage.includes("remoteModels") && devicesPage.includes("models unavailable")],
  ["Devices offers a direct Use models action without manual navigation",
    devicesPage.includes("Use models →") &&
      devicesPage.includes('detail: { key: "server" }') &&
      devicesPage.includes('mode: "device"')],
  ["Server displays the selected peer's actual catalogue",
    serverPage.includes('data-ui="PairedDeviceModels"') && serverPage.includes("Models on {ep.deviceName")],
  ["selecting a peer model starts it and persists the selection",
    serverPage.includes("await startRemoteModel(ep.deviceId, modelId)") &&
      serverPage.includes("remoteModelId: modelId")],
  ["device endpoint preserves a remote model id",
    endpoint.includes("remoteModelId?: string") && endpoint.includes("modelId: ep.remoteModelId")],
  ["every paired-device inference pins the selected remote model",
    dispatch.includes("owllm_remote_model: remoteModelId")],
];

let failed = 0;
for (const [label, pass] of checks) {
  if (pass) {
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL ${label}`);
  }
}
console.log(`${checks.length - failed}/${checks.length} remote-model federation checks passed`);
process.exitCode = failed ? 1 : 0;

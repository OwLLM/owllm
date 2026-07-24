// OWLLM Node belongs to device management, never account-provider settings.
// These source guards pin the single mount point and the responsive KVM layout
// so later page rewrites cannot silently move it back or clip its forms.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, "..", "..");
const ROOT = path.resolve(UI, "..", "..");
const readLF = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

const accounts = readLF(path.join(UI, "pages", "advanced", "AccountsPage.tsx"));
const devices = readLF(path.join(UI, "pages", "advanced", "DevicesPage.tsx"));
const panel = readLF(path.join(UI, "pages", "advanced", "KvmNodePanel.tsx"));
const backend = readLF(path.join(ROOT, "src-tauri", "src", "kvm.rs"));

let failures = 0;
const check = (label, condition) => {
  if (condition) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ ${label}`); }
};

console.log("\nKVM Devices-page placement checks:\n");

check("Devices page imports the OWLLM Node panel", devices.includes('import KvmNodePanel from "./KvmNodePanel"'));
check("Devices page renders the OWLLM Node panel", devices.includes("<KvmNodePanel />"));
check("Accounts page no longer imports the OWLLM Node panel", !accounts.includes('import KvmNodePanel from "./KvmNodePanel"'));
check("Accounts page no longer renders the OWLLM Node panel", !accounts.includes("<KvmNodePanel />"));
check("OWLLM Node has exactly one application-page mount", (devices.match(/<KvmNodePanel \/>/g) ?? []).length === 1);
check("KVM section exposes a stable Devices UI marker", panel.includes('data-ui="DevicesKvmSection"'));
check("KVM hardware identity is visually explicit", panel.includes("Hardware KVM"));
check("allowed hosts and saved nodes are separate settings cards",
  panel.includes('data-ui="KvmAllowedHosts"') && panel.includes('data-ui="KvmSavedNodes"'));
check("KVM settings cards wrap responsively", panel.includes('repeat(auto-fit, minmax(310px, 1fr))'));
check("saved-node form wraps rather than overflowing narrow cards", panel.includes('display: "flex", flexWrap: "wrap"'));
check("KVM errors direct users to Devices", backend.includes("Enable it on the Devices page (OWLLM Node card)"));
check("KVM errors no longer direct users to Accounts", !backend.includes("Accounts page (OWLLM Node card)"));

if (failures) throw new Error(`FAILED: ${failures} KVM placement check(s).`);
console.log("\nall checks passed");

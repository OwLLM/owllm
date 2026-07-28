// Focused regression for the Servers page's device-local model preference.
// Run from owllm-desktop/: node ui/src/pages/core/serverPreferences.verify.run.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const ts = (await import(pathToFileURL(path.join(ROOT, "node_modules/typescript/lib/typescript.js")).href)).default;
const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => void values.set(key, String(value)),
  removeItem: (key) => void values.delete(key),
};

const sourcePath = path.join(HERE, "serverContext.ts");
const js = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "server-pref-"));
const modulePath = path.join(temp, "serverContext.mjs");
fs.writeFileSync(modulePath, js);
const prefs = await import(pathToFileURL(modulePath).href);

let pass = 0;
function check(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    pass++;
  }
}

check(prefs.getServerModel() === "", "an unset preference is neutral");
prefs.setServerModel("  local/qwen.gguf  ");
check(prefs.getServerModel() === "local/qwen.gguf", "the selected model survives a fresh read");
prefs.setServerModel("");
check(prefs.getServerModel() === "", "clearing the picker removes the preference");

const page = fs.readFileSync(path.join(HERE, "ServerPage.tsx"), "utf8");
check(page.includes("useState<string>(() => getServerModel())"), "ServerPage hydrates the saved model");
check(page.includes("setServerModel(id);"), "every ServerPage pick is written through");

const vault = fs.readFileSync(path.join(ROOT, "ui/src/runtime/vaultSync.ts"), "utf8");
check(vault.includes('"owllm:server:model"'), "the machine-specific model preference is excluded from vault sync");

if (!process.exitCode) console.log(`OK server model persistence: ${pass}/${pass} checks passed`);

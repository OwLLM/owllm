#!/usr/bin/env node
// Every model dropdown used to auto-select the FIRST local model whenever the
// project/page had nothing saved. A fresh page therefore looked configured and
// runs went out on weights the user never chose (and, on a cloud route, billed
// them). Reported repeatedly; this gate is what stops it coming back.
//
// The contract now:
//   1. NO surface substitutes a model for an empty selection. The only
//      non-explicit source still allowed is a local server the user started
//      themselves (visible in the picker as "(use server model · …)").
//   2. An unset picker reads SELECT_MODEL_LABEL — "Select model".
//   3. Sending with nothing selected raises the rule-based ModelRequiredDialog
//      instead of only writing a status line nobody reads.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "..");
// A missing file reads as "" so the affected checks report ✗ with a real name
// instead of the run dying on ENOENT (which is what pre-fix sources look like:
// ModelRequiredDialog.tsx doesn't exist there yet).
const read = (p) => {
  try { return fs.readFileSync(path.join(src, p), "utf8"); }
  catch { return ""; }
};

const picker   = read("pages/agentic/ModelPicker.tsx");
const dialog   = read("components/ModelRequiredDialog.tsx");
const code     = read("pages/agentic/CodePage.tsx");
const agents   = read("pages/agentic/AgentsPage.tsx");
const chat     = read("pages/finetuning/ChatPage.tsx");
const dataset  = read("pages/finetuning/DatasetBuilderPage.tsx");
const server   = read("pages/core/ServerPage.tsx");

let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

// ---- 1. no auto-pick anywhere ---------------------------------------------
check("CodePage does not adopt the first local/tuned model on load",
  !/setModelId\(\(cur\) => cur \|\| all\.find/.test(code) &&
  code.includes("NO auto-pick"));
check("Agentic dispatch does not adopt the first servable local model",
  !/const fallback = models\.find\(m =>\s*\n?\s*requiresManagedLocalServer\(m\.model_id, m\.provider\) && m\.port != null\);/.test(agents) &&
  agents.includes("There is deliberately no step 3."));
check("Chat columns do not adopt the first servable local model",
  !chat.includes("const fallbackLocalId = availableModels") &&
  chat.includes("There is deliberately NO step 4."));
check("Dataset Builder does not adopt a model on load",
  !/set\("modelId", all\.find/.test(dataset));
check("Server page clears a stale pick without substituting the first model",
  !/setModelId\(servable\[0\]\?\.model_id \?\? ""\);/.test(server) &&
  server.includes('// picker just reads "Select model" until the user chooses.'));
check("A user-started local server is still an allowed (visible) source",
  agents.includes("wantedLocal = serverState.model_id") &&
  chat.includes("|| runningLocalId"));

// ---- 2. the unset label ----------------------------------------------------
check("ModelPicker exports the single unset label",
  picker.includes('export const SELECT_MODEL_LABEL = "Select model";'));
check("The trigger falls back to that label instead of an ad-hoc string",
  picker.includes("(fallbackLabel || placeholder || SELECT_MODEL_LABEL)"));
check("Every surface's own unset label is the shared constant",
  code.includes("fallbackLabel={SELECT_MODEL_LABEL}") &&
  code.includes("busy, SELECT_MODEL_LABEL)") &&
  agents.includes("fallbackLabel={SELECT_MODEL_LABEL}") &&
  chat.includes("fallbackLabel={SELECT_MODEL_LABEL}") &&
  dataset.includes("fallbackLabel={SELECT_MODEL_LABEL}") &&
  server.includes("SELECT_MODEL_LABEL}"));

// ---- 3. the rule-based popup ----------------------------------------------
check("The popup is a shared component, rendered as a real modal",
  dialog.includes('data-ui="ModelRequiredDialog"') &&
  dialog.includes("No model selected") &&
  dialog.includes('position: "fixed", inset: 0'));
check("The popup is pure UI — it never resolves a model itself",
  dialog.length > 0 && !/list_models|invoke\(/.test(dialog));
check("CodePage raises it from the coder send path",
  code.includes('setModelRequired({ where: "the Coder header" });'));
check("CodePage raises it from chat, second-agent and fix-with-agent sends",
  code.includes('where: "the Coder header", detail: "Chat mode uses the same model as the coder."') &&
  code.includes('where: "the second-agent pane"') &&
  code.includes('detail: "The release fix was not queued."'));
check("The agentic run stops and raises it instead of picking for the user",
  agents.includes('where: "the team / agent Model picker",') &&
  agents.includes('setRunError("No model selected — pick one for the team or the agent before sending.");'));
check("Chat blocks the send and KEEPS the draft",
  chat.includes("setModelRequired(true);") &&
  /if \(!anyPick && !\(status\.running && status\.model_id\)\) \{[\s\S]{0,80}setModelRequired\(true\);[\s\S]{0,40}return;\s*\}\s*\n\s*setDraft\(""\);/.test(chat));
check("Dataset Builder raises it from Generate",
  dataset.includes("if (!modelId) { setModelRequired(true);"));
check("Every surface that raises it also renders it",
  [code, agents, chat, dataset].every(f =>
    f.includes('import ModelRequiredDialog from "../../components/ModelRequiredDialog";') &&
    f.includes("<ModelRequiredDialog")));

if (failed) {
  console.error(`modelSelectionNoAutopick: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("modelSelectionNoAutopick: all checks passed");

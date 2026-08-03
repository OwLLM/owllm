#!/usr/bin/env node
// Durable facts stopped growing after 84e6be57 (2026-07-26) removed the
// promote-everything auto-curation and nothing replaced it — the only write
// path left was agents voluntarily emitting [REMEMBER], which they almost
// never do. The Memory Curator is the selective replacement: ONE bounded
// post-run pass, at most 2 novel facts, on a PER-PROJECT model the user picks
// (default Auto · Cheapest → free local model first) so curation cannot
// silently inflate token spend. This gate pins the whole contract: the pass
// exists, is capped in code, reuses the single existing write path, runs
// fire-and-forget at all three run-completion sites, and is configurable
// (model + off) from the Team Memory modal via the shared ModelPicker.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, p), "utf8");
const curator = read("memoryCurator.ts");
const agents = read("AgentsPage.tsx");
const modal = read("TeamMemoryModal.tsx");
const localTools = read("localTools.ts");
const bridge = read(path.join("..", "..", "bridges", "bridgeCore.ts"));
let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

// ---- The pass itself -------------------------------------------------------
check("Curator module exists with the run entry point",
  curator.includes("export async function runMemoryCurator"));
check("Default model is Auto · Cheapest (free local model first)",
  curator.includes('CURATOR_DEFAULT_MODEL = "auto/cheapest"'));
check("An 'off' sentinel disables the pass entirely",
  curator.includes('CURATOR_OFF = "off"') &&
  curator.includes("if (raw === CURATOR_OFF) return null"));
check("The 2-fact cap is enforced in code, not just in the prompt",
  curator.includes("CURATOR_MAX_FACTS = 2") &&
  curator.includes("parseMemoryDirectives(reply).slice(0, CURATOR_MAX_FACTS)"));
check("Existing facts are fetched for dedupe and worklog rows are excluded",
  curator.includes('r.kind !== "worklog"') &&
  curator.includes("do NOT re-record these"));
check("Facts are written through the ONE existing write path (harvestMemoryWrites)",
  curator.includes('harvestMemoryWrites(directiveText, scope, "curator")') &&
  !curator.includes("team_memory_write"));
check("A trivial answer skips the LLM call entirely (cost guard)",
  curator.includes(".trim().length < 300) return 0"));
check("The call is time-bounded so a hung provider cannot leak a task",
  curator.includes("setTimeout(() => ctrl.abort()") &&
  curator.includes("clearTimeout(timer)"));
check("The curator gets no tools on any provider path",
  curator.includes("[],        // allowedTools"));
check("harvestMemoryWrites carries the author so curator facts are labeled",
  localTools.includes("scopeOverride?: string, author = \"\""));

// ---- Wiring: every run-completion path fires it, without blocking ----------
check("Solo-loop completion fires the curator (fire-and-forget)",
  agents.includes("void runMemoryCurator({\n            scope: soloMemKey"));
check("Team-run completion fires the curator (fire-and-forget)",
  agents.includes("void runMemoryCurator({\n        scope: runtimeMemoryKey(orch, selectedProjectId)"));
check("Bridge (Telegram/Discord/…) runs fire the curator too",
  bridge.includes("void runMemoryCurator({"));
check("No call site awaits the curator — the answer always ships first",
  !agents.includes("await runMemoryCurator") && !bridge.includes("await runMemoryCurator"));

// ---- Team Memory modal: per-project model + on/off -------------------------
check("The modal has the curator on/off toggle",
  modal.includes("applyCurator(e.target.checked ? \"\" : CURATOR_OFF)"));
check("The model choice uses the SHARED ModelPicker (never a hand-rolled select)",
  modal.includes("<ModelPicker") &&
  modal.includes('fallbackLabel="Auto · Cheapest (default)"'));
check("The setting persists per project scope",
  modal.includes("setCuratorModel(scope, val)") &&
  curator.includes("`owllm:memory-curator:${scope}`"));

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

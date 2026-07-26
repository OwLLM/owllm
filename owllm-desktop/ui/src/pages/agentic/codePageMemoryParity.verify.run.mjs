#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, "CodePage.tsx"), "utf8");
const mem = fs.readFileSync(path.join(HERE, "localTools.ts"), "utf8");
const modal = fs.readFileSync(path.join(HERE, "TeamMemoryModal.tsx"), "utf8");
const vaultSync = fs.readFileSync(path.resolve(HERE, "../../runtime/vaultSync.ts"), "utf8");

let failed = 0;
function check(name, ok) {
  if (!ok) {
    failed++;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`PASS ${name}`);
  }
}

check(
  "Code page pins the shared team-memory scope before RAG reads/tools",
  /resolveMemoryScope\(\)[\s\S]*setTeamMemoryScope\(scope\)[\s\S]*setTeamMemoryGoal\(user\)[\s\S]*refreshTeamMemorySnapshot\(\)[\s\S]*retrieveScopedTeamMemoryPack\(scope, user/.test(src),
);
check(
  "Code page resolves folders to the durable agent project id before memory use",
  src.includes('invoke<ProjectScopeRow>("resolve_project_for_location"')
    && /const memoryScope = \(\) => ruleScopeRef\.current\.id \|\| \(\(projectRoot \|\| workspace\) \? fallbackProjectScope\(projectRoot \|\| workspace\) : ""\)/.test(src)
    && /const scope = await resolveMemoryScope\(\);[\s\S]*await harvestMemoryWrites\(result\)/.test(src),
);
check(
  "Code page persists replies through the same durable-memory harvester agents use",
  /harvestMemoryWrites\(result\)[\s\S]*logScopedTeamWork\(scope, agent, instruction, stripMemoryDirectives\(result\)\)/.test(src),
);
check(
  "Primary, secondary, chat, and planned Code turns write shared work-state",
  /logCodeWork\("code", text \|\| "\([^"]*attached (?:image|file)[^"]*\)", reply\)/.test(src)
    && /logCodeWork\("code_second", text, replyText\)/.test(src)
    && /logCodeWork\("code_chat", text \|\| "\([^"]*attached image[^"]*\)", reply\)/.test(src)
    && /logCodeWork\("code", plan\[i\]\.title, stepReply\)/.test(src),
);
check(
  "Memory tools and Code page both hit team_memory_search, not a page-local store",
  /case "memory_search"[\s\S]*team_memory_search/.test(mem)
    && /retrieveScopedTeamMemoryPack[\s\S]*team_memory_search/.test(mem),
);
check(
  "Ordinary run summaries stay in the bounded worklog instead of polluting durable RAG facts",
  !mem.includes("autoCurateScopedTeamFact")
    && !mem.includes('tags: "auto-curated,implementation"')
    && /logScopedTeamWork[\s\S]*team_memory_log/.test(mem),
);
check(
  "Coding resolves the durable project id before opening Project Memory",
  src.includes('data-ui="CodeProjectMemory"')
    && /openProjectMemory[\s\S]*await resolveMemoryScope\(\)[\s\S]*CustomEvent\("owllm:open-code-memory",[\s\S]*detail: \{ projectId: scope \}/.test(src)
    && /<TeamMemoryModal[\s\S]*projectId=\{ruleScope\.id \|\| null\}/.test(src)
    && !src.includes("projectId={ruleScope.id || projectRoot || workspace || null}"),
);
check(
  "Shared memory modal pins the opener's project id and clears stale filters",
  /const requested = typeof detail\?\.projectId === "string"/.test(modal)
    && modal.includes("setOpenedScope(requested || propScopeRef.current)")
    && modal.includes('setQuery("")')
    && modal.includes("setTagFilter(null)"),
);
check(
  "Fact writes trigger project-vault sync with a periodic SQLite backstop",
  mem.includes('CustomEvent("owllm:memory:changed")')
    && vaultSync.includes('addEventListener("owllm:memory:changed"')
    && vaultSync.includes("60_000"),
);

if (failed) process.exit(1);

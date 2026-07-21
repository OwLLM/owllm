#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, "CodePage.tsx"), "utf8");
const mem = fs.readFileSync(path.join(HERE, "localTools.ts"), "utf8");

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
  /logCodeWork\("code", text \|\| "\([^"]*attached image[^"]*\)", reply\)/.test(src)
    && /logCodeWork\("code_second", text, replyText\)/.test(src)
    && /logCodeWork\("code_chat", text \|\| "\([^"]*attached image[^"]*\)", reply\)/.test(src)
    && /logCodeWork\("code", plan\[i\]\.title, stepReply\)/.test(src),
);
check(
  "Memory tools and Code page both hit team_memory_search, not a page-local store",
  /case "memory_search"[\s\S]*team_memory_search/.test(mem)
    && /retrieveScopedTeamMemoryPack[\s\S]*team_memory_search/.test(mem),
);

if (failed) process.exit(1);

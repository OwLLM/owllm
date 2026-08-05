#!/usr/bin/env node
// Regression gate for the Code page's transient Plan & Build board. It is an
// execution tracker for one run, not the Notebook's durable cross-run queue.
// A stopped plan must be resumable, while a new manual Auto/Chat turn must
// retire the superseded board instead of leaving it on screen indefinitely.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const codePath = process.env.OWLLM_CODE_PAGE
  ? path.resolve(process.env.OWLLM_CODE_PAGE)
  : path.join(here, "CodePage.tsx");
const code = process.env.OWLLM_CODE_STDIN === "1"
  ? fs.readFileSync(0, "utf8")
  : fs.readFileSync(codePath, "utf8");

let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

check("the plan goal is persisted with the transient board",
  code.includes("planGoal?: string;") && code.includes("setPlanGoal(goal);"));
check("manual non-plan sends retire the previous board",
  code.includes('if (fromComposer && agentMode !== "plan")')
    && code.includes("setTasks([]);\n      setPlanGoal(undefined);"));
check("Notebook/programmatic sends are explicitly excluded from board retirement",
  code.includes("Programmatic Notebook") && code.includes("if (fromComposer"));
check("plan cards execute through one reusable lifecycle",
  code.includes("const executePlanCards = async")
    && code.includes("await executePlanCards(goal, plan, ctrl);"));
check("Stop returns an unfinished running card to pending",
  code.includes('t.status === "running" ? { ...t, status: "pending" } : t'));
check("a stopped plan has a rule-based resume action",
  code.includes("const resumePlan = async") && code.includes(">▶ Resume plan</button>"));
check("Resume runs only unfinished cards",
  code.includes('if (plan[i].status === "done" || plan[i].status === "failed") continue;'));
check("older saved boards recover their goal from the visible transcript",
  code.includes('const marker = "📋 Plan & build: ";') && code.includes("savedGoal?.content.slice(marker.length)"));
check("Clear removes both cards and their saved goal",
  code.includes("tasks: [], planGoal: undefined, draft:"));
check("Plan mode with no model uses the shared rule-based model popup",
  code.includes('if (!modelId) { setModelRequired({ where: "the Coder header" }); setStatus("No model selected'));

console.log(`\n${10 - failed}/10 checks passed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Focused guard for the two regressions fixed together: an in-project
// brainstorm must end in the Notebook, and restored graph coordinates must
// be framed inside the current canvas rather than clipped at stale dimensions.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../..");
const require = createRequire(path.join(repo, "package.json"));
const ts = require("typescript");
const readLF = (name) => fs.readFileSync(path.join(here, name), "utf8").replace(/\r\n/g, "\n");
const agents = readLF("AgentsPage.tsx");
const brainstorm = readLF("BrainstormPanel.tsx");
const graphSource = readLF("graphViewport.ts");
const tmp = path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", `owllm-graph-${process.pid}.mjs`);
fs.writeFileSync(tmp, ts.transpileModule(graphSource, {
  compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
}).outputText);
const { computeGraphViewportFit } = await import(pathToFileURL(tmp).href + `?v=${Date.now()}`);
fs.rmSync(tmp, { force: true });

let failures = 0;
const check = (name, condition) => {
  if (condition) console.log(`  ok  ${name}`);
  else { console.error(`  FAIL ${name}`); failures += 1; }
};

check("existing-team brainstorm seeds the Notebook", brainstorm.includes("seedNotebookFromBrief(projectId, briefTextOnDisk)"));
check("existing-team completion opens the Notebook", brainstorm.includes('data-ui="BrainstormOpenNotebook"'));
check("team assembly is explicitly first-team only", brainstorm.includes("Assemble first team from brief"));
check("Agents passes real team state", agents.includes('hasTeam={!!activeTeam?.agents.length}'));
check("graph root fills the parent", agents.includes('position:"relative", width:"100%", height:"100%"'));
check("graph has a manual recovery control", agents.includes('data-ui="GraphFitViewport"'));

const width = 880;
const height = 660;
const points = [
  { x: 680, y: 247 },
  { x: 450, y: 460 },
  { x: 1040, y: 670 },
];
const fit = computeGraphViewportFit(points, width, height, 200, 230);
check("stale graph layout produces a fit", !!fit);
check("oversized graph is reduced", fit?.zoom < 1 && fit?.zoom >= 0.25);
if (fit) {
  const xs = points.flatMap((p) => [p.x * fit.zoom + fit.pan.x, (p.x + 200) * fit.zoom + fit.pan.x]);
  const ys = points.flatMap((p) => [p.y * fit.zoom + fit.pan.y, (p.y + 230) * fit.zoom + fit.pan.y]);
  check("all cards fit horizontally", Math.min(...xs) >= 0 && Math.max(...xs) <= width);
  check("all cards fit vertically", Math.min(...ys) >= 0 && Math.max(...ys) <= height);
}
check("empty graph has no fake transform", computeGraphViewportFit([], width, height, 200, 230) === null);

if (failures) process.exit(1);
console.log("PASS brainstorm/graph workflow regression");

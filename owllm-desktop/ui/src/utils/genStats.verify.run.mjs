import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;
const source = fs.readFileSync(path.join(HERE, "genStats.ts"), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const temp = path.join(
  process.env.TMPDIR || process.env.TEMP || "/tmp",
  `gen-stats-${process.pid}-${Date.now()}.mjs`,
);

let failures = 0;
const check = (label, condition) => {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
};

const events = [];
let now = 1_000;
const realDateNow = Date.now;
Date.now = () => now;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};
globalThis.window = {
  dispatchEvent(event) {
    events.push(event);
    return true;
  },
};

try {
  fs.writeFileSync(temp, output);
  const { makeGenMeter } = await import(pathToFileURL(temp).href);

  const first = makeGenMeter();
  first();
  now += 250;
  first();
  check("one stream reports only its generation interval",
    events.at(-1)?.detail?.toksPerSec === 8);

  const second = makeGenMeter();
  second();
  now += 250;
  second();
  check("parallel stream rates are summed instead of overwriting",
    events.at(-1)?.detail?.toksPerSec === 16 &&
    events.at(-1)?.detail?.streams === 2);

  first.stop();
  check("ending one stream immediately removes it from the aggregate",
    events.at(-1)?.detail?.toksPerSec === 8 &&
    events.at(-1)?.detail?.streams === 1);
  second.stop();

  now += 40_000;
  const nextTurn = makeGenMeter();
  nextTurn();
  now += 250;
  nextTurn();
  check("a later tool-loop turn starts with a fresh clock",
    events.at(-1)?.detail?.toksPerSec === 8 &&
    events.at(-1)?.detail?.streams === 1);
  const eventCountBeforeStop = events.length;
  nextTurn.stop();
  nextTurn();
  check("a stopped stream cannot re-enter the active aggregate",
    events.length === eventCountBeforeStop);
} finally {
  Date.now = realDateNow;
  fs.rmSync(temp, { force: true });
}

if (failures) throw new Error(`FAILED: ${failures} generation-stat check(s).`);
console.log("\nGeneration-stat checks passed.");

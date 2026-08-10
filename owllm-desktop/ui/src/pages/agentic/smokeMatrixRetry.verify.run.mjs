#!/usr/bin/env node
// Pins the ship gate's retry policy: live-model cells retry once, deterministic
// cells never do.
//
// Section P asks a REAL model to echo a token after ~43 KB of filler. Measured
// 2026-08-10: 1 miss in 13 consecutive runs of the claude 40 KB cell (~8%), and
// both observed misses were the model commenting on the prompt rather than
// obeying it — the payload transited fine, so what failed was obedience, not the
// spawn boundary the cell exists to guard. Three such cells put roughly 1 matrix
// run in 5 spuriously red, and a red gate costs a full re-run before every
// publish. That is release time spent on a coin flip.
//
// The retry must stay surgically narrow. Retrying S/H/W would hide exactly what
// they are built to catch, and retrying a SKIP would burn a live turn on an
// account that is simply not logged in. This harness EXECUTES the gate's own
// cell() so the policy cannot drift into either mistake.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SMOKE =
  process.env.OWLLM_VERIFY_SMOKE_MJS
  || path.resolve(HERE, "../../../../scripts/smoke-matrix.mjs");
const src = fs.readFileSync(SMOKE, "utf8");

let failed = 0;
function check(name, ok, detail) {
  if (!ok) {
    failed++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`PASS ${name}`);
  }
}

// Slice out the retry policy + cell() and run them against a recording stub, so
// what is verified is the gate's real control flow rather than a paraphrase.
const start = src.indexOf("const CELL_ATTEMPTS");
const anchor = src.indexOf("async function cell(section, name, fn)", start);
const end = src.indexOf("\n}\n", anchor);
check(
  "the retry policy and cell() are still where this harness reads them",
  start >= 0 && anchor > start && end > anchor,
);
if (start < 0 || anchor < 0 || end < 0) {
  console.log("\n1 FAILED");
  process.exit(1);
}

const mod = `
export const calls = [];
function record(section, name, status, note = "", ms = 0) {
  calls.push({ section, name, status, note });
}
${src.slice(start, end + 2)}
export { cell, CELL_ATTEMPTS };
`;
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "owllm-cell-")), "cell.mjs");
fs.writeFileSync(tmp, mod);
const { cell, calls, CELL_ATTEMPTS } = await import(pathToFileURL(tmp).href);

/** A cell body that FAILs `n` times, then PASSes. Counts its own invocations. */
function flaky(n) {
  const state = { runs: 0 };
  return [
    async () => {
      state.runs++;
      return state.runs <= n ? { status: "FAIL", note: "off-script reply" } : { status: "PASS" };
    },
    state,
  ];
}
const last = () => calls[calls.length - 1];

// --- live-model cells retry -------------------------------------------------
{
  const [fn, state] = flaky(1);
  await cell("P", "claude · 40KB prompt via stdin", fn);
  check(
    "a live-model cell that misses once is retried and recorded PASS",
    state.runs === 2 && last().status === "PASS",
    `runs=${state.runs} status=${last().status}`,
  );
}

// --- a real regression still fails ------------------------------------------
{
  const [fn, state] = flaky(99);
  await cell("P", "claude · always broken", fn);
  check(
    "a genuinely broken live cell fails both attempts and keeps the matrix red",
    state.runs === 2 && last().status === "FAIL",
    `runs=${state.runs} status=${last().status}`,
  );
  check(
    "the retry is disclosed in the note rather than hidden",
    /attempt 1 failed, retried/.test(last().note),
    last().note,
  );
}

// --- deterministic sections are never retried -------------------------------
for (const section of ["S", "H", "W"]) {
  const [fn, state] = flaky(1);
  await cell(section, `${section} · deterministic`, fn);
  check(
    `section ${section} is never retried — a retry would hide what it guards`,
    state.runs === 1 && last().status === "FAIL",
    `runs=${state.runs} status=${last().status}`,
  );
}
check(
  "only section P is granted attempts",
  Object.keys(CELL_ATTEMPTS).join(",") === "P" && CELL_ATTEMPTS.P === 2,
  JSON.stringify(CELL_ATTEMPTS),
);

// --- SKIP and PASS are terminal ---------------------------------------------
{
  const state = { runs: 0 };
  await cell("P", "claude · not logged in", async () => {
    state.runs++;
    return { status: "SKIP", note: "not logged in" };
  });
  check(
    "a SKIP is not retried — it is a credential state, not a failure",
    state.runs === 1 && last().status === "SKIP",
    `runs=${state.runs} status=${last().status}`,
  );
}
{
  const state = { runs: 0 };
  await cell("P", "claude · small prompt", async () => {
    state.runs++;
    return { status: "PASS" };
  });
  check(
    "a PASS is not re-run — it would burn a second live turn for nothing",
    state.runs === 1 && last().status === "PASS",
    `runs=${state.runs} status=${last().status}`,
  );
}

// --- a throwing cell body is still caught and retried ------------------------
{
  const state = { runs: 0 };
  await cell("P", "claude · throws", async () => {
    state.runs++;
    throw new Error("spawn exploded");
  });
  check(
    "an exception is recorded as FAIL and retried, not propagated out of the gate",
    state.runs === 2 && last().status === "FAIL" && /spawn exploded/.test(last().note),
    `runs=${state.runs} status=${last().status} note=${last().note}`,
  );
}

fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : "\nsmokeMatrixRetry: all checks passed");
process.exit(failed ? 1 : 0);

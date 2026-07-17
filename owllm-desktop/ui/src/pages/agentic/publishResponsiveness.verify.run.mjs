#!/usr/bin/env node
// Regression gate: host publishing is a long background job, never a modal GUI
// lock, and only one publisher may mutate a repository at a time.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");
const cards = fs.readFileSync(path.join(HERE, "PublishCards.tsx"), "utf8");
const release = fs.readFileSync(path.join(APP, "src-tauri/src/release.rs"), "utf8");
const finishScript = fs.readFileSync(path.join(APP, "scripts/finish-and-publish.sh"), "utf8");

function fail(message) {
  console.error(`FAIL publish responsiveness: ${message}`);
  process.exit(1);
}

if (!cards.includes("const runningRef = useRef(false)") ||
    !cards.includes("if (runningRef.current)") ||
    !cards.includes("runningRef.current = true")) {
  fail("the immediate frontend single-flight latch is missing");
}
if (!cards.includes("}, { openOutput: false })") ||
    !cards.includes("setOutputOpen(openOutput)")) {
  fail("host publish automatically opens a blocking full-screen output modal");
}
if (!cards.includes('setActivity({ kind: "ok", msg: firstLine(msg) })') ||
    !cards.includes('setActivity({ kind: "err", msg: firstLine(msg) })')) {
  fail("full publish logs can still expand the inline rail and capture the layout");
}
if (!cards.includes("elapsedClock(elapsedSeconds)") ||
    !cards.includes("Date.now() - startedAt")) {
  fail("a long host build has no visible elapsed-time heartbeat");
}
const leaseCalls = release.match(/acquire_publish_lease\(&repo_dir\)\?/g) ?? [];
if (!release.includes("static ACTIVE_PUBLISHES") ||
    !release.includes("struct PublishLease") ||
    leaseCalls.length !== 2) {
  fail("both backend publish entry points must share one per-repository lease");
}
if (!finishScript.includes("git rev-parse --git-common-dir") ||
    !finishScript.includes("claim_publish_lock") ||
    !finishScript.includes("release_publish_lock") ||
    !finishScript.includes("trap on_publish_exit EXIT")) {
  fail("separate app processes do not share a repository-level publish lease");
}
if (!release.includes("tokio::task::spawn_blocking")) {
  fail("host publishing no longer runs off the async UI command executor");
}

console.log("PASS publish is non-modal, off-thread, compact, and single-flight");

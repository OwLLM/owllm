#!/usr/bin/env node
// Regression gate: the agent browser must fail HONESTLY.
//
// Measured 2026-08-17 on a wedged browser session: new tabs were created and
// `navigate()` returned Ok, but the webview never committed a document. Every
// action then polled until it hit the SAME generic timeout text for both the
// "page is slow" and the "nothing was ever fetched" case:
//
//     browser action 'get_text' timed out — the page may still be loading
//
// A solo agent previewing a WSL dev server read that, tried the distro's IP
// (which refuses for a default 127.0.0.1 bind), and reported to the user:
// "browser previewing was blocked because the shared browser could not reach
// the WSL dev server". Both probes proved the opposite — a 127.0.0.1-bound WSL
// server answers HTTP 200 at localhost:<port> from Windows, and loaded fine in
// the shared browser once the session was restarted. The tool's own wording
// manufactured a network diagnosis out of a browser-state bug.
//
// The same session also handed back a 160x28 PNG of a MINIMIZED window as a
// "screenshot" — evidence of nothing, which an agent will happily verify.
//
// This gate pins the three invariants that keep that from recurring.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");
const browserPath = path.join(APP, "src-tauri/src/browser.rs");
const supportPath = path.join(APP, "src-tauri/src/support.rs");
const toolsPath = path.join(APP, "ui/src/pages/agentic/localTools.ts");

let failures = 0;
let checks = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function read(p, label) {
  if (!fs.existsSync(p)) {
    check(`${label} exists`, false, `missing ${p}`);
    return "";
  }
  check(`${label} exists`, true);
  return fs.readFileSync(p, "utf8");
}

const browser = read(browserPath, "browser.rs");
const support = read(supportPath, "support.rs");
const tools = read(toolsPath, "localTools.ts");

// ---------------------------------------------------------------------------
// 1. A timeout must be diagnosed, not blanket-worded.
// ---------------------------------------------------------------------------
const timeoutFnStart = browser.indexOf("fn action_timeout_error");
check("action_timeout_error() exists", timeoutFnStart >= 0);

const evalStart = browser.indexOf("fn eval_until_reply");
check("eval_until_reply() exists", evalStart >= 0);

// Slice the body so a marker that drifts cannot silently widen the search to
// the whole file and pass everything.
const evalBody =
  evalStart >= 0 ? browser.slice(evalStart, evalStart + 4000) : "";
check(
  "eval_until_reply slice is real",
  evalBody.includes("timeout") && evalBody.length > 500,
  `slice length ${evalBody.length}`,
);
check(
  "eval_until_reply routes its timeout through action_timeout_error()",
  /start\.elapsed\(\)\s*>\s*timeout\s*\{\s*return Err\(action_timeout_error\(win, action\)\)/s.test(
    evalBody,
  ),
);
check(
  "eval_until_reply no longer inlines a blanket timeout string",
  !evalBody.includes("the page may still be loading"),
);

const timeoutFn =
  timeoutFnStart >= 0
    ? browser.slice(timeoutFnStart, browser.indexOf("\nfn ", timeoutFnStart + 10))
    : "";
check(
  "action_timeout_error slice is real",
  timeoutFn.includes("action") && timeoutFn.length > 200,
  `slice length ${timeoutFn.length}`,
);
check(
  "action_timeout_error branches on whether a document exists",
  /match live_document_url\(win\)/.test(timeoutFn) &&
    /Some\(url\)\s*=>/.test(timeoutFn) &&
    /None\s*=>/.test(timeoutFn),
);

// The loaded arm must identify WHICH page did not answer.
const loadedArm = timeoutFn.slice(
  timeoutFn.indexOf("Some(url)"),
  timeoutFn.indexOf("None =>"),
);
check(
  "loaded-document arm names the url",
  loadedArm.includes("{url}"),
);

// The no-document arm is the one that produced the fabricated network claim.
const deadArm = timeoutFn.slice(timeoutFn.indexOf("None =>"));
check(
  "no-document arm states the tab never loaded a document",
  /never loaded a document/i.test(deadArm),
);
check(
  "no-document arm blames the session, not the destination",
  /wedged/i.test(deadArm) && /NOT the destination/i.test(deadArm),
);
check(
  "no-document arm names the remedy (browser_close)",
  /browser_close/.test(deadArm),
);
check(
  "no-document arm forbids reporting the URL as unreachable",
  /do not report/i.test(deadArm) && /unreachable/i.test(deadArm),
);
check(
  "no-document arm does not reuse the misleading loading text",
  !/may still be loading/i.test(deadArm),
);

// ---------------------------------------------------------------------------
// 2. live_document_url must treat a blank webview as "no document".
// ---------------------------------------------------------------------------
const liveStart = browser.indexOf("fn live_document_url");
check("live_document_url() exists", liveStart >= 0);
const liveFn =
  liveStart >= 0 ? browser.slice(liveStart, browser.indexOf("\n}", liveStart) + 2) : "";
check(
  "live_document_url slice is real",
  liveFn.includes("url") && liveFn.length > 100,
  `slice length ${liveFn.length}`,
);
check(
  "live_document_url reads the LIVE webview url",
  /win\.url\(\)/.test(liveFn),
);
check(
  "live_document_url treats an empty url as no document",
  /is_empty\(\)/.test(liveFn),
);
check(
  "live_document_url treats about:blank as no document",
  /about:blank/.test(liveFn),
);

// ---------------------------------------------------------------------------
// 3. A screenshot must never be a picture of a minimized window.
// ---------------------------------------------------------------------------
const capStart = support.indexOf("fn capture_window_png");
check("capture_window_png() exists", capStart >= 0);
const capBody =
  capStart >= 0 ? support.slice(capStart, capStart + 2500) : "";
check(
  "capture_window_png slice is real",
  capBody.includes("cfg(windows)") && capBody.length > 400,
  `slice length ${capBody.length}`,
);
check(
  "capture_window_png refuses a minimized window",
  /is_minimized\(\)/.test(capBody),
);
const guardAt = capBody.indexOf("is_minimized()");
const winCfgAt = capBody.indexOf("#[cfg(windows)]");
check(
  "the minimized guard runs BEFORE any platform capture",
  guardAt >= 0 && winCfgAt >= 0 && guardAt < winCfgAt,
  `guard@${guardAt} vs windows-capture@${winCfgAt}`,
);
// Bound the guard body precisely at the platform capture, so a `return Ok`
// belonging to the Windows path can never be mistaken for part of the guard.
const guardBlock =
  guardAt >= 0 && winCfgAt > guardAt ? capBody.slice(guardAt, winCfgAt) : "";
check(
  "the minimized guard returns an error rather than a picture",
  /return Err\(/.test(guardBlock),
);
// A `return Ok(...)` ahead of the error short-circuits the guard and hands
// back a picture anyway — the exact bug, with the honest text still in place
// to make the source look correct.
const okAt = guardBlock.indexOf("return Ok(");
const errAt = guardBlock.indexOf("return Err(");
check(
  "nothing returns a capture before the minimized guard errors",
  errAt >= 0 && (okAt < 0 || errAt < okAt),
  `return Ok@${okAt} vs return Err@${errAt}`,
);
check(
  "the minimized guard explains there are no rendered pixels",
  /no rendered pixels/i.test(guardBlock),
);
check(
  "the minimized guard offers an actionable alternative",
  /restore/i.test(guardBlock) && /desktop/i.test(guardBlock),
);

// ---------------------------------------------------------------------------
// 4. Agents must be told how a WSL dev server is actually reached.
// ---------------------------------------------------------------------------
const openStart = tools.indexOf('name: "browser_open"');
check("browser_open tool spec exists", openStart >= 0);
const openSpec = openStart >= 0 ? tools.slice(openStart, openStart + 2000) : "";
check(
  "browser_open slice is real",
  openSpec.includes("description") && openSpec.length > 300,
  `slice length ${openSpec.length}`,
);
check(
  "browser_open tells agents to preview a WSL server via localhost",
  /WSL/.test(openSpec) && /localhost:<port>/.test(openSpec),
);
check(
  "browser_open explains the WSL IP only works for a 0.0.0.0 bind",
  /0\.0\.0\.0/.test(openSpec) && /127\.0\.0\.1/.test(openSpec),
);
check(
  "browser_open forbids concluding unreachability from the WSL IP",
  /never conclude/i.test(openSpec) && /unreachable/i.test(openSpec),
);

if (failures) {
  console.error(`\n✗ browser honest-failure gate: ${failures}/${checks} checks failed`);
  process.exit(1);
}
console.log(`✅ browser honest-failure gate: ${checks} checks passed`);

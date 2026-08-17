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

// ---------------------------------------------------------------------------
// 5. A wedged session must heal itself — the agent should not be handed a chore.
//
// Telling the agent to "run browser_close and retry" still left the tool
// blaming the caller for a fault the tool can fix, and every extra step is
// another chance for the agent to invent an explanation instead. The recovery
// below is bounded on purpose: it may not restart a session that still holds a
// live page, it may not loop, and it may not replay a content read against the
// fresh blank tab (that would answer about a page that was never loaded — the
// exact fabrication this whole gate exists to prevent).
// ---------------------------------------------------------------------------
function slice(source, marker, end = "\n}") {
  const at = source.indexOf(marker);
  if (at < 0) return "";
  const close = source.indexOf(end, at);
  return close < 0 ? source.slice(at) : source.slice(at, close + end.length);
}

// Restarting needs POSITIVE evidence that the engine is broken. Two signals
// that look decisive are not, both measured 2026-08-17 against the live app:
//
//   * a webview pointed at an unresponsive host reports "about:blank" for as
//     long as the request hangs — byte-identical to a wedged tab. Restarting on
//     an uncommitted tab alone would tear the window down over a dev server
//     that is still compiling (the very case that started all this).
//   * scanning the other tabs does not separate them either: tabs that loaded
//     BEFORE the session wedged keep reporting their old URL. In the incident
//     the user's localhost tab still read as loaded while three consecutive
//     agent tabs committed nothing — so an "is any tab alive?" rule would have
//     stayed silent in the one case this exists for.
//
// The probe asks the engine for something that cannot be slow instead.
const engineFn = slice(browser, "fn browser_engine_is_dead");
check("browser_engine_is_dead() exists", engineFn.length > 0);
check(
  "browser_engine_is_dead slice is real",
  engineFn.includes("probe") && engineFn.length > 200,
  `slice length ${engineFn.length}`,
);
check(
  "the probe opens a NEW tab (an old tab's stale url proves nothing)",
  /new_tab\(app, home\.as_str\(\), false, false\)/.test(engineFn),
);
check(
  "the probe loads the app's own start page, which cannot be slow",
  /browser_home_url\(app\)/.test(engineFn),
);
check(
  "the probe is opened in the background, not in front of the user",
  /new_tab\(app, home\.as_str\(\), false,/.test(engineFn),
);
check(
  "the verdict is whether that probe committed a document",
  /tab_committed_document\(app, probe, TAB_COMMIT_BUDGET\)/.test(engineFn) &&
    /!committed/.test(engineFn),
);
check(
  "the probe tab is closed again rather than left behind",
  /close_tab\(app, probe\)/.test(engineFn),
);
check(
  "a session that can no longer open a tab counts as dead",
  /Err\(_\) => return true/.test(engineFn),
);
// The trap: judging by the existing strip. Both forms of it must stay out.
check(
  "the verdict never depends on the other tabs' urls",
  !/list_tabs\(/.test(engineFn) &&
    !/tabs\.order/.test(engineFn) &&
    !/ids\.iter\(\)/.test(engineFn),
);
check(
  "the all-tabs-dead rule is gone entirely (it missed the real incident)",
  !/session_is_wedged/.test(browser),
);

const restartFn = slice(browser, "fn auto_restart_browser");
check("auto_restart_browser() exists", restartFn.length > 0);
check(
  "auto_restart_browser slice is real",
  restartFn.includes("browser_start_inner") && restartFn.length > 200,
  `slice length ${restartFn.length}`,
);
check(
  "auto_restart_browser is rate-limited",
  /LAST_AUTO_RESTART/.test(restartFn) && /AUTO_RESTART_COOLDOWN/.test(restartFn),
);
// The stamp must be taken BEFORE the teardown: a restart that fails halfway
// would otherwise leave the cooldown unset and be retried on every action.
const stampAt = restartFn.indexOf("*last = Some(Instant::now())");
const teardownAt = restartFn.indexOf("stop_browser_inner");
check(
  "the cooldown is stamped before the teardown, so a failed restart cannot loop",
  stampAt >= 0 && teardownAt >= 0 && stampAt < teardownAt,
  `stamp@${stampAt} vs teardown@${teardownAt}`,
);
check(
  "auto_restart_browser hands back the tab to use afterwards",
  /active_tab_id\(\)/.test(restartFn),
);
check(
  "the cooldown constant is a real window",
  /const AUTO_RESTART_COOLDOWN: Duration = Duration::from_secs\((\d+)\)/.test(browser) &&
    Number(
      browser.match(
        /const AUTO_RESTART_COOLDOWN: Duration = Duration::from_secs\((\d+)\)/,
      )[1],
    ) >= 30,
);

const stopInner = slice(browser, "fn stop_browser_inner");
check("stop_browser_inner() exists", stopInner.length > 0);
check(
  "an automatic restart does not mark the session closed",
  /if user_initiated\s*\{\s*mark_session_closed\(\);/s.test(stopInner),
);
check(
  "the user's ✕ still marks the session closed",
  /stop_browser_inner\(&app, true\)/.test(browser),
);
check(
  "the automatic path passes user_initiated = false",
  /stop_browser_inner\(app, false\)/.test(restartFn),
);

const recoverFn = slice(browser, "fn recover_wedged_action");
check("recover_wedged_action() exists", recoverFn.length > 0);
check(
  "recover_wedged_action slice is real",
  recoverFn.includes("auto_restart_browser") && recoverFn.length > 400,
  `slice length ${recoverFn.length}`,
);
check(
  "browser_cmd routes a failed action through the recovery",
  /recover_wedged_action\(&app, &action, &params, &screenshot_scope, error\)/.test(
    browser,
  ),
);
check(
  "recovery only triggers on a timeout WITH a dead-engine probe",
  /error\.contains\("timed out"\)/.test(recoverFn) &&
    /browser_engine_is_dead\(app\)/.test(recoverFn),
);
// The user is watching this window: a restart needs the probe's positive
// evidence, never a timeout on its own.
const gateAt = recoverFn.indexOf("browser_engine_is_dead(app)");
const restartAt = recoverFn.indexOf("auto_restart_browser(app)");
check(
  "the engine probe runs BEFORE the restart",
  gateAt >= 0 && restartAt >= 0 && gateAt < restartAt,
  `gate@${gateAt} vs restart@${restartAt}`,
);
check(
  "only navigate/open is replayed after the restart",
  /!matches!\(action, "navigate" \| "open"\)/.test(recoverFn),
);
// The replay guard must come before the replay: a content read answered from
// the fresh blank tab is a fabricated result about a page that never loaded.
const guardAt2 = recoverFn.indexOf('!matches!(action, "navigate"');
const replayAt = recoverFn.indexOf("run_browser_action(app,");
check(
  "the non-replayable actions return before any replay",
  guardAt2 >= 0 && replayAt >= 0 && guardAt2 < replayAt,
  `guard@${guardAt2} vs replay@${replayAt}`,
);
const nonReplay = recoverFn.slice(guardAt2, replayAt < 0 ? undefined : replayAt);
check(
  "the non-replayable arm returns an error rather than an empty answer",
  /return Err\(/.test(nonReplay),
);
check(
  "the non-replayable arm still forbids reporting the URL as unreachable",
  /do not report/i.test(nonReplay) && /unreachable/i.test(nonReplay),
);
check(
  "the non-replayable arm tells the agent the session was already restarted",
  /restarted automatically/i.test(nonReplay),
);
check(
  "a successful replay reports the NEW tab id",
  /\{fresh\}/.test(recoverFn.slice(replayAt < 0 ? 0 : replayAt)),
);

// The earliest catch: browser_open_tab knows the URL, so recovery there is
// invisible to the caller instead of surfacing later as a mystery timeout.
const healFn = slice(browser, "fn heal_if_tab_never_loaded");
check("heal_if_tab_never_loaded() exists", healFn.length > 0);
check(
  "browser_open_tab heals a tab that never loaded",
  /let \(id, restarted, note\) = heal_if_tab_never_loaded\(&app, id, &parsed\)/.test(
    browser,
  ),
);
check(
  "the heal gates on the commit budget AND on the engine probe",
  /tab_committed_document\(app, id, TAB_COMMIT_BUDGET\)/.test(healFn) &&
    /browser_engine_is_dead\(app\)/.test(healFn),
);
check(
  "a failed heal hands back the reason instead of a silently dead tab",
  /Some\(format!\(/.test(healFn) && /do not report it as unreachable/i.test(healFn),
);
check(
  "the restart is disclosed to the caller",
  /opened\["restarted"\] = json!\(true\)/.test(browser) &&
    /opened\["note"\] = json!\(note\)/.test(browser),
);

const commitFn = slice(browser, "fn tab_committed_document");
check("tab_committed_document() exists", commitFn.length > 0);
check(
  "tab_committed_document polls the live document url",
  /live_document_url\(/.test(commitFn),
);
check(
  "tab_committed_document gives up at the budget rather than blocking forever",
  /start\.elapsed\(\) >= budget/.test(commitFn) && /return false/.test(commitFn),
);
// A healthy tab reports its url immediately, so this budget is only ever spent
// by a broken session — but an unbounded one would stall every open.
const budget = browser.match(
  /const TAB_COMMIT_BUDGET: Duration = Duration::from_secs\((\d+)\)/,
);
check("TAB_COMMIT_BUDGET is declared", !!budget);
check(
  "TAB_COMMIT_BUDGET stays short enough not to stall ordinary opens",
  !!budget && Number(budget[1]) > 0 && Number(budget[1]) <= 5,
  budget ? `${budget[1]}s` : "missing",
);

if (failures) {
  console.error(`\n✗ browser honest-failure gate: ${failures}/${checks} checks failed`);
  process.exit(1);
}
console.log(`✅ browser honest-failure gate: ${checks} checks passed`);

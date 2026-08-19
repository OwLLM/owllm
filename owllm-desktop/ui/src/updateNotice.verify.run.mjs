// Regression gate: an available update must be ANNOUNCED, findable later, and
// reported to the world map — none of which the shipped code did.
//
// Three defects this pins:
//
//  1. The updater checked ONCE, 2.5s after launch ("we don't poll"). An install
//     left running for days never learned about a release published an hour
//     after boot, which is measurably why live nodes sit on old versions.
//  2. Finding an update opened a modal in front of the user's work, and
//     "Later" recorded a dismissal with no other surface anywhere — the offer
//     was simply gone. It is now the owl's comic balloon for UPDATE_NOTICE_MS,
//     then a permanent badge under the OWLLM mark, plus a badge on Info.
//  3. WorldPresenceRunner's identity-failure path called
//     installWorldPresenceConnection() with NO arguments, dropping the app
//     version along with the id — the one code path that can put an ONLINE dot
//     on the map reading "Version unknown". The version needs no identity.
//
// The first section EXECUTES runtime/updateAvailability.ts (the real store);
// the rest pins the wiring in the three surfaces that consume it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, "runtime", "updateAvailability.ts");
const CONTROLLER = path.join(HERE, "UpdatePrompt.tsx");
const SHELL = path.join(HERE, "AppShell.tsx");
const INFO = path.join(HERE, "pages", "core", "InfoPage.tsx");

let failures = 0;
const check = (label, condition) => {
  if (condition) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ ${label}`); }
};

/// Comments quote the very shapes some checks forbid, so every source pin runs
/// against code with comments removed.
function codeOf(file) {
  if (!fs.existsSync(file)) return null;
  const src = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  return {
    src,
    code: src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"),
  };
}

console.log("\nUpdate announcement (owl balloon → badge) + presence version:\n");

// ---- 1. EXECUTE the real availability store --------------------------------

const store = codeOf(STORE);
if (!store) {
  check("runtime/updateAvailability.ts exists", false);
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-updatenotice-"));
  const bundle = path.join(tmp, "store.mjs");
  await esbuild.build({
    entryPoints: [STORE], bundle: true, format: "esm", platform: "node",
    outfile: bundle, logLevel: "silent",
  });
  const mod = await import(`file://${bundle.replace(/\\/g, "/")}`);

  // A session-storage stand-in, so the once-per-version rule is executed
  // rather than read.
  const cell = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (cell.has(k) ? cell.get(k) : null),
    setItem: (k, v) => { cell.set(k, String(v)); },
    removeItem: (k) => { cell.delete(k); },
  };
  globalThis.window = new EventTarget();

  let notified = 0;
  const off = mod.subscribeUpdateAvailability(() => { notified += 1; });

  check("no update known at rest", mod.getUpdateAvailability().version === null);

  mod.setUpdateAvailable("1.0.20");
  check("a found update is published to subscribers",
    notified === 1 && mod.getUpdateAvailability().version === "1.0.20");

  const afterFirst = notified;
  mod.setUpdateAvailable("1.0.20");
  mod.setUpdateAvailable(" 1.0.20 ");
  check("the repeating check re-reporting the SAME version repaints nothing",
    notified === afterFirst);

  mod.setUpdateAvailable("1.0.21");
  check("a newer version replaces the old one", mod.getUpdateAvailability().version === "1.0.21");

  mod.setUpdateAvailable("");
  check("an empty version is treated as 'up to date'", mod.getUpdateAvailability().version === null);

  mod.setUpdateAvailable("1.0.21");
  check("the owl greets a version it has not greeted yet",
    mod.shouldAnnounceUpdate("1.0.21") === true);
  mod.markUpdateAnnounced("1.0.21");
  check("and does NOT greet the same version twice in one session",
    mod.shouldAnnounceUpdate("1.0.21") === false);
  check("but does greet the NEXT version", mod.shouldAnnounceUpdate("1.0.22") === true);

  // Storage blocked (private mode / hardened webview): a duplicate greeting is
  // acceptable, silence is the bug this module exists to fix.
  const savedStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  check("with storage blocked the owl still speaks",
    mod.shouldAnnounceUpdate("1.0.21") === true);
  let threw = false;
  try { mod.markUpdateAnnounced("1.0.21"); } catch { threw = true; }
  check("and recording the greeting cannot throw", threw === false);
  globalThis.sessionStorage = savedStorage;

  let opened = 0;
  globalThis.window.addEventListener(mod.OPEN_UPDATE_EVENT, () => { opened += 1; });
  mod.requestUpdateInstall();
  check("asking to install raises the open-modal event", opened === 1);

  // A listener that throws must not break the update path.
  mod.subscribeUpdateAvailability(() => { throw new Error("bad listener"); });
  let storeThrew = false;
  try { mod.setUpdateAvailable("1.0.30"); } catch { storeThrew = true; }
  check("a throwing subscriber cannot break the check", storeThrew === false);
  off();

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- 2. the controller: repeated check, opened on demand -------------------

const ctl = codeOf(CONTROLLER);
if (!ctl) {
  check("UpdatePrompt.tsx exists", false);
} else {
  // Equivalent cover for the old setInterval pin: the repeat is now scheduled
  // by the check that just finished (so a failed check can come back sooner),
  // and the first one still lands 2.5s after mount. The interval VALUE is
  // asserted by executing runtime/updateSchedule in section 4.
  check("the check REPEATS instead of firing once per launch",
    /schedule\(2500\)/.test(ctl.code)
    && /timer = window\.setTimeout\(runCheck, ms\)/.test(ctl.code)
    && /schedule\(RECHECK_MS\)/.test(ctl.code)
    && !/setInterval/.test(ctl.code));

  // Scoped to the SUCCESS path, between the awaited check and the catch —
  // otherwise `let failures = 0` / `let checkErrorShown = false` at the top of
  // the effect satisfy these on their own, and deleting the actual resets goes
  // unnoticed (both mutations survived a whole-file match).
  const okFrom = ctl.code.indexOf("const u = await check();");
  const okTo = ctl.code.indexOf("} catch (e) {", okFrom);
  const okPath = okFrom >= 0 && okTo > okFrom ? ctl.code.slice(okFrom, okTo) : "";

  check("a check that could not answer retries on the backoff, not the period",
    /schedule\(nextCheckDelayMs\(failures\)\)/.test(ctl.code)
    && /failures \+= 1/.test(ctl.code)
    && /(^|\n)\s*failures = 0;/.test(okPath));

  check("a transient publish-window error is not shown, and clears itself",
    /shouldSurfaceCheckError\(failures\)/.test(ctl.code)
    && /if \(checkErrorShown\) \{/.test(okPath)
    && /(^|\n)\s*checkErrorShown = false;/.test(okPath)
    && /setPhase\(\(p\) => \(p === "error" \? "hidden" : p\)\)/.test(okPath));

  check("coming back online re-checks instead of waiting out the period",
    /addEventListener\("online", onOnline\)/.test(ctl.code)
    && /removeEventListener\("online", onOnline\)/.test(ctl.code));

  check("a found update is published to the store, not thrown at the user",
    /setUpdateAvailable\(String\(\(u as any\)\.version \?\? ""\)\)/.test(ctl.code));

  // Scoped to the CHECK body — the on-demand listener is allowed to open the
  // modal. Requiring both markers keeps the slice from collapsing to "" and
  // passing vacuously against a source that has no runCheck at all.
  const checkFrom = ctl.code.indexOf("const runCheck");
  const checkTo = ctl.code.indexOf("const onOnline");
  check("finding an update does NOT open the modal by itself",
    checkFrom >= 0 && checkTo > checkFrom
    && !/setPhase\("prompt"\)/.test(ctl.code.slice(checkFrom, checkTo)));

  check("the modal opens on demand, from the chrome or Info",
    /addEventListener\(OPEN_UPDATE_EVENT/.test(ctl.code)
    && /setPhase\(\(p\) => \(p === "downloading" \|\| p === "installing" \? p : "prompt"\)\)/.test(ctl.code));

  check("'Later' no longer erases the update — it only hides the modal",
    !/owllm:update:dismissed/.test(ctl.code)
    && /const dismiss = \(\) => setPhase\("hidden"\);/.test(ctl.code));
}

// ---- 3. the chrome: owl balloon for 10s, then a resting badge --------------

const shell = codeOf(SHELL);
if (!shell) {
  check("AppShell.tsx exists", false);
} else {
  check("the balloon lasts 10 seconds",
    /const UPDATE_NOTICE_MS = 10_000;/.test(shell.code)
    && /setTimeout\(\(\) => setUpdateNotice\(null\), UPDATE_NOTICE_MS\)/.test(shell.code));

  check("it is the owl asking, in the user's words",
    /Please, update your app!/.test(shell.src)
    && /We fixed a few bugs and added cool features!/.test(shell.src));

  check("the balloon is clickable and installs",
    /data-ui="UpdateNotice"/.test(shell.code)
    && /onClick=\{\(e\) => \{ e\.stopPropagation\(\); onOpenUpdate\?\.\(\); \}\}/.test(
      shell.code.slice(shell.code.indexOf('data-ui="UpdateNotice"'),
        shell.code.indexOf('data-ui="UpdateNotice"') + 700)));

  check("pressing it cannot start a window-drag instead (the owl's old bug)",
    /onMouseDown=\{\(e\) => e\.stopPropagation\(\)\}/.test(
      shell.code.slice(shell.code.indexOf('data-ui="UpdateNotice"') - 400,
        shell.code.indexOf('data-ui="UpdateNotice"') + 400)));

  const updateNoticeFrom = shell.code.indexOf('data-ui="UpdateNotice"');
  const updateNoticeTo = shell.code.indexOf('</button>', updateNoticeFrom);
  const updateNoticeCode = shell.code.slice(updateNoticeFrom, updateNoticeTo);
  check("the balloon sits to the owl's right and 20px lower",
    /left:\s*"calc\(50% \+ 92px\)",\s*top:\s*25/.test(updateNoticeCode)
    && !/transform:\s*"translateX/.test(updateNoticeCode));

  check("the manga tail leaves the balloon's LEFT edge toward the owl",
    /left:\s*-17,\s*top:\s*20/.test(updateNoticeCode)
    && /borderRight:\s*"18px solid #14181f"/.test(updateNoticeCode)
    && /left:\s*-12,\s*top:\s*21/.test(updateNoticeCode)
    && /borderRight:\s*"14px solid #fdfdf7"/.test(updateNoticeCode)
    && !/right:\s*-1[27]/.test(updateNoticeCode));

  check("after 10s the offer RESTS in a badge, under the OWLLM mark",
    /data-ui="UpdateBadge"/.test(shell.code)
    && /⬆ Update available/.test(shell.src)
    && shell.code.indexOf('data-ui="UpdateBadge"') > shell.code.indexOf(">OWLLM</div>"));

  check("balloon and badge are never both on screen",
    /updateBadge=\{updateVersion && !updateNotice \? updateVersion : null\}/.test(shell.code));

  check("the badge stays for as long as the update stands",
    !/setTimeout[^\n]*setUpdateBadge/.test(shell.code));

  check("the owl greets once per version per session",
    /if \(!shouldAnnounceUpdate\(updateVersion\)\) return;/.test(shell.code)
    && /markUpdateAnnounced\(updateVersion\);/.test(shell.code));

  check("both surfaces route to the real installer",
    /onOpenUpdate=\{requestUpdateInstall\}/.test(shell.code));

  // The balloon is the owl SPEAKING. The decorative frame the owl lives in
  // idle-hides FRAME_IDLE_HIDE_MS after launch — long before the updater's
  // first check lands at 2.5s — so the balloon used to float over the header
  // with its tail aimed at nothing. Whichever notice is up, the owl comes back
  // for as long as it talks, then the normal idle-hide takes over again.
  check("the owl is on screen while a balloon is up",
    /const noticeShowing = Boolean\(updateNotice \|\| chatNotice\);/.test(shell.code)
    && /if \(!noticeShowing\) return;\s*\n\s*revealFrame\(\);/.test(shell.code)
    && /return \(\) => hideFrameAfter\(FRAME_LEAVE_HIDE_MS\);\s*\n\s*\}, \[noticeShowing\]\);/.test(shell.code));

  check("the reveal cannot outlive the balloon (it hands back to idle-hide)",
    /\}, \[noticeShowing\]\);/.test(shell.code));

  check("revealing the owl still honours 'keep frame visible'",
    /const hideFrameAfter = \(delay: number\) => \{[\s\S]*?if \(keepFrameVisible\) return;/.test(shell.code));

  // ---- presence version (fix 1) --------------------------------------------
  check("presence reports the app version even when identity fails",
    /const appVersion = await getVersion\(\)\.catch\(\(\) => undefined\);/.test(shell.code)
    && /installWorldPresenceConnection\(\{ appVersion \}\)/.test(shell.code));

  check("no presence connection is opened with the version dropped",
    !/installWorldPresenceConnection\(\)\s*;/.test(shell.code));

  check("the version comes from the app, not from the identity it just lost",
    /import \{ getVersion \} from "@tauri-apps\/api\/app";/.test(shell.code));
}

// ---- 4. Info page: contact + the same badge --------------------------------

const info = codeOf(INFO);
if (!info) {
  check("InfoPage.tsx exists", false);
} else {
  const cardStart = info.src.indexOf('<Card title="📦 Application">');
  const card = cardStart < 0 ? "" : info.src.slice(cardStart, info.src.indexOf("</Card>", cardStart));

  check("the developer's contact line sits in the Application card",
    /Contact the main developer Ruigro at/.test(card)
    && /const DEVELOPER_EMAIL = "mc@far-island\.com";/.test(info.code)
    && /\{DEVELOPER_EMAIL\}/.test(card));

  check("the address is a working mail link, opened the app's way",
    /openWebUrl\(`mailto:\$\{DEVELOPER_EMAIL\}`\)/.test(info.code));

  check("the update badge is in the same card and installs when pressed",
    /data-ui="InfoPage:update-badge"/.test(card)
    && /onClick=\{requestUpdateInstall\}/.test(card)
    && /⬆ Update available/.test(card));

  check("Info reads the SAME fact as the chrome (it cannot say 'up to date' while the header offers an update)",
    /subscribeUpdateAvailability,\s*\n\s*\(\) => getUpdateAvailability\(\)\.version,/.test(info.code));
}

// ---- 5. EXECUTE the check schedule ----------------------------------------
//
// THE REPRO: v1.0.20 went Latest at 13:06Z with a Windows-only latest.json;
// finish-multihost.sh merged linux/darwin at 14:33Z. THOR (booted 13:46Z) and
// the MacBook (14:07Z) each checked inside that window, got TargetNotFound,
// and — on a 6h setInterval — would not have looked again until 19:46Z and
// 20:07Z. The policy below has to recover from that in minutes.

const SCHEDULE = path.join(HERE, "runtime", "updateSchedule.ts");
if (!fs.existsSync(SCHEDULE)) {
  check("runtime/updateSchedule.ts exists", false);
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-updatesched-"));
  const bundle = path.join(tmp, "sched.mjs");
  await esbuild.build({
    entryPoints: [SCHEDULE], bundle: true, format: "esm", platform: "node",
    outfile: bundle, logLevel: "silent",
  });
  const s = await import(`file://${bundle.replace(/\\/g, "/")}`);

  check("a machine left running finds a release within the hour",
    Number.isFinite(s.RECHECK_MS) && s.RECHECK_MS > 0 && s.RECHECK_MS <= 60 * 60 * 1000);

  check("an answered check waits the steady period",
    s.nextCheckDelayMs(0) === s.RECHECK_MS && s.nextCheckDelayMs(-1) === s.RECHECK_MS);

  check("the FIRST failure comes back in about a minute, not the period",
    s.nextCheckDelayMs(1) <= 60 * 1000 && s.nextCheckDelayMs(1) < s.RECHECK_MS);

  check("the backoff grows but never exceeds its ceiling",
    (() => {
      let prev = 0;
      for (let f = 1; f <= 12; f += 1) {
        const d = s.nextCheckDelayMs(f);
        if (!Number.isFinite(d) || d <= 0 || d > s.RETRY_MAX_MS) return false;
        if (d < prev) return false;
        prev = d;
      }
      return s.nextCheckDelayMs(12) === s.RETRY_MAX_MS;
    })());

  // The decisive number: once the manifest is complete, how long can a client
  // that has been failing all along still stay on the old version?
  check("recovery after a 87-minute publish window is minutes, not hours",
    (() => {
      let elapsed = 0, failuresSoFar = 0, worstGap = 0;
      // Replay ~90 minutes of failing checks to reach the steady-state gap.
      while (elapsed < 87 * 60 * 1000) {
        failuresSoFar += 1;
        const gap = s.nextCheckDelayMs(failuresSoFar);
        worstGap = gap;
        elapsed += gap;
      }
      return worstGap <= 15 * 60 * 1000;
    })());

  check("a publish window does not immediately accuse the platform",
    !s.shouldSurfaceCheckError(1) && !s.shouldSurfaceCheckError(2));

  check("a release that stays broken IS reported",
    s.shouldSurfaceCheckError(s.FAILURES_BEFORE_SURFACING)
    && s.shouldSurfaceCheckError(s.FAILURES_BEFORE_SURFACING + 5));

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
  throw new Error(`FAILED: ${failures} update-announcement check(s) failed.`);
}
console.log("PASS: the owl announces updates, the badge keeps the offer, and presence always reports its version.\n");

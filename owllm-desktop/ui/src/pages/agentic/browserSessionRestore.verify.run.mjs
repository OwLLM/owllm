// A project's browser is part of the project. Its open pages used to live only
// in memory (browser.rs `TABS`), so closing the window by accident — or simply
// restarting the app — threw away a whole desk of logged-in tabs even though
// the cookies behind them survived in the stable browser profile.
//
// This harness EXECUTES the restore logic against a fake invoker (no Tauri, no
// window) and pins the Rust invariants that make persistence safe:
//   * a teardown must never overwrite a good session with an empty one,
//   * only the OWNING project's session is ever written,
//   * a deliberate close is remembered, so a restart does not resurrect a
//     browser the user had put away — while an accidental ✕ still restores.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, "../..");
const ROOT = path.resolve(UI, "../..");
const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const envSource = read(path.join(HERE, "projectEnvironment.ts"));
const agents = read(path.join(HERE, "AgentsPage.tsx"));
const dialog = read(path.join(HERE, "ProjectSettingsDialog.tsx"));
const browserRs = read(path.join(ROOT, "src-tauri/src/browser.rs"));
const libRs = read(path.join(ROOT, "src-tauri/src/lib.rs"));

let passed = 0;
function check(name, condition) {
  if (!condition) throw new Error(`FAIL ${name}`);
  passed += 1;
  console.log(`  PASS ${name}`);
}

const compiled = ts.transpileModule(envSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-browser-session-"));
const modulePath = path.join(temp, "projectEnvironment.mjs");
fs.writeFileSync(modulePath, compiled);

const ENVIRONMENT = {
  version: 1,
  presetId: "personal-operations",
  title: "Personal operations",
  description: "assistant desk",
  surfaces: [],
  browser: {
    openOnCreate: true,
    layout: "right-half",
    device: "desktop",
    tabs: [
      { id: "gmail", icon: "", label: "Gmail", url: "https://mail.google.com/", category: "email" },
      { id: "whatsapp", icon: "", label: "WhatsApp", url: "https://web.whatsapp.com/", category: "messages" },
    ],
  },
};

/// Fake Tauri bridge: records every command and answers browser_session_bind
/// with the supplied state, exactly as the Rust command serialises it.
function fakeInvoker(bind) {
  const calls = [];
  let nextTabId = 100;
  return {
    calls,
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "browser_session_bind") return JSON.stringify(bind);
      if (command === "browser_open_tab") {
        return JSON.stringify({ tab_id: nextTabId++, url: args?.url, active: !!args?.activate });
      }
      return "";
    },
  };
}
const openedUrls = (calls) => calls.filter(c => c.command === "browser_open_tab").map(c => c.args.url);
const used = (calls, command) => calls.some(c => c.command === command);

try {
  const { parseBrowserSessionBind, restoreProjectBrowser, launchProjectEnvironment } =
    await import(pathToFileURL(modulePath).href);

  // ---- parseBrowserSessionBind ------------------------------------------
  const parsedString = parseBrowserSessionBind(
    JSON.stringify({ busy: false, live: false, session: { tabs: ["https://a/"], active: 0, open: true } }),
  );
  check("bind payload parses from the Rust JSON string", parsedString.session.tabs.length === 1);
  check("bind payload parses from an already-decoded object",
    parseBrowserSessionBind({ busy: true, live: false, session: { tabs: [], active: 0, open: false } }).busy === true);
  check("malformed bind payload degrades to an empty session, never throws",
    parseBrowserSessionBind("not json").session.tabs.length === 0);
  check("missing session degrades to an empty session",
    parseBrowserSessionBind({}).session.open === false);
  const dirty = parseBrowserSessionBind({
    session: { tabs: ["https://a/", "", "   ", 7, "https://b/"], active: 9, open: true },
  });
  check("blank and non-string urls are dropped from a saved session",
    JSON.stringify(dirty.session.tabs) === JSON.stringify(["https://a/", "https://b/"]));
  check("an out-of-range active index clamps to the first tab", dirty.session.active === 0);

  // ---- restoreProjectBrowser --------------------------------------------
  const busy = fakeInvoker({ busy: true, live: false, session: { tabs: ["https://a/"], active: 0, open: true } });
  const busyResult = await restoreProjectBrowser("p1", ENVIRONMENT, busy.invoke, { boot: false });
  check("another project's live browser is never restored over", busyResult.restoredTabs === 0);
  check("a busy browser is not even touched", openedUrls(busy.calls).length === 0);

  const live = fakeInvoker({ busy: false, live: true, session: { tabs: ["https://a/"], active: 0, open: true } });
  const liveResult = await restoreProjectBrowser("p1", ENVIRONMENT, live.invoke, { boot: false });
  check("a project whose tabs are already open is not duplicated", liveResult.restoredTabs === 0);
  check("an already-live project opens no extra tabs", openedUrls(live.calls).length === 0);

  const first = fakeInvoker({ busy: false, live: false, session: { tabs: [], active: 0, open: false } });
  const firstResult = await restoreProjectBrowser("p1", ENVIRONMENT, first.invoke, { boot: false });
  check("the first open seeds the session from the project's own recipe",
    JSON.stringify(openedUrls(first.calls))
      === JSON.stringify(ENVIRONMENT.browser.tabs.map(t => t.url)));
  check("the recipe launch reports the tabs it opened", firstResult.restoredTabs === 2);
  check("the recipe launch still focuses the browser the user just asked for",
    used(first.calls, "browser_focus"));
  check("the recipe launch still applies its layout", used(first.calls, "browser_arrange"));

  const noRecipe = fakeInvoker({ busy: false, live: false, session: { tabs: [], active: 0, open: false } });
  const noRecipeResult = await restoreProjectBrowser("p1", null, noRecipe.invoke, { boot: false });
  check("a project with neither a session nor a recipe opens nothing",
    noRecipeResult.restoredTabs === 0 && openedUrls(noRecipe.calls).length === 0);

  const saved = { tabs: ["https://mail.google.com/", "https://web.whatsapp.com/", "https://calendar.google.com/"], active: 1, open: true };
  const boot = fakeInvoker({ busy: false, live: false, session: { ...saved } });
  const bootResult = await restoreProjectBrowser("p1", ENVIRONMENT, boot.invoke, { boot: true });
  check("app start reopens the pages the project had", bootResult.restoredTabs === 3);
  check("restored tabs come back in their saved strip order",
    JSON.stringify(openedUrls(boot.calls)) === JSON.stringify(saved.tabs));
  const activated = boot.calls.filter(c => c.command === "browser_open_tab" && c.args.activate);
  check("exactly the saved active tab is brought to the front",
    activated.length === 1 && activated[0].args.url === saved.tabs[1]);
  check("a restore never yanks focus away from what the user is doing",
    !used(boot.calls, "browser_focus"));

  const closedAtExit = fakeInvoker({ busy: false, live: false, session: { ...saved, open: false } });
  const closedResult = await restoreProjectBrowser("p1", ENVIRONMENT, closedAtExit.invoke, { boot: true });
  check("a browser closed on purpose is not resurrected at app start",
    closedResult.restoredTabs === 0 && openedUrls(closedAtExit.calls).length === 0);

  const reopen = fakeInvoker({ busy: false, live: false, session: { ...saved, open: false } });
  const reopenResult = await restoreProjectBrowser("p1", ENVIRONMENT, reopen.invoke, { boot: false });
  check("opening the project restores it even after a close — an accidental ✕ is not a discard",
    reopenResult.restoredTabs === 3 && openedUrls(reopen.calls).length === 3);

  const noEnv = fakeInvoker({ busy: false, live: false, session: { ...saved } });
  await restoreProjectBrowser("p1", null, noEnv.invoke, { boot: false });
  check("a saved session restores without a recipe, on the default device",
    openedUrls(noEnv.calls).length === 3
      && noEnv.calls.some(c => c.command === "browser_set_device" && c.args.device === "desktop"));

  const blank = fakeInvoker({ busy: false, live: false, session: { tabs: [], active: 0, open: false } });
  const blankResult = await restoreProjectBrowser("   ", ENVIRONMENT, blank.invoke, { boot: false });
  check("a blank project id never reaches the backend",
    blankResult.restoredTabs === 0 && blank.calls.length === 0);

  // The recipe launch and the restore must stay one implementation.
  const legacy = fakeInvoker({});
  await launchProjectEnvironment(ENVIRONMENT, legacy.invoke);
  check("launchProjectEnvironment still opens the recipe tabs it always did",
    JSON.stringify(openedUrls(legacy.calls))
      === JSON.stringify(ENVIRONMENT.browser.tabs.map(t => t.url)));
  check("tab opening exists once, shared by launch and restore",
    (envSource.match(/invokeCommand\("browser_open_tab"/g) ?? []).length === 1);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

// ---- Rust: what makes the mirror safe ------------------------------------
check("the live tab set is mirrored per project", /static SESSION_OWNER: Mutex<Option<String>>/.test(browserRs));
check("an empty tab set never overwrites a saved session",
  /fn persist_session[\s\S]*?if kept\.is_empty\(\) \{[\s\S]*?return;/.test(browserRs));
// The remembered index must be counted over the tabs actually written. Counting
// it over the unfiltered list shifted it by one per dropped blank tab and then
// fell back to 0 — reopening on the FIRST page instead of the one in front.
check("the active index is counted over the tabs that are kept",
  /fn persist_session[\s\S]*?let active = kept[\s\S]*?\.position\(/.test(browserRs));
check("every live tab set is written only to its resolved project-or-personal session",
  /fn persist_session[\s\S]*?let stem = live_session_stem\(\)[\s\S]*?write_session\(\s*&stem/.test(browserRs));
check("session file names are sanitised before touching the filesystem",
  /fn session_file_stem[\s\S]*?is_ascii_alphanumeric\(\)/.test(browserRs));
// The teardown was factored into stop_browser_inner so an automatic restart of
// a wedged session reuses it. Same ordering invariant — once the windows are
// gone there is nothing left to read the pages from — plus the flag that keeps
// "the user put it away" distinct from "it is coming straight back".
check("the teardown records the pages BEFORE tearing the windows down",
  /fn stop_browser_inner[\s\S]*?persist_session\(app\);[\s\S]*?mark_session_closed\(\);[\s\S]*?destroy_browser_windows/.test(browserRs));
check("browser_stop is still the deliberate close (it marks the session closed)",
  /fn browser_stop[\s\S]*?stop_browser_inner\(&app, true\)/.test(browserRs));
check("an automatic restart does NOT mark the session closed",
  /fn stop_browser_inner[\s\S]*?if user_initiated \{[\s\S]*?mark_session_closed\(\);/.test(browserRs) &&
  /stop_browser_inner\(app, false\)/.test(browserRs));
check("closing the last tab is remembered as a deliberate close",
  /next_active_after_close[\s\S]*?mark_session_closed\(\);[\s\S]*?destroy\(\)/.test(browserRs));
check("every tab mutation mirrors to disk (open)", /fn new_tab[\s\S]*?sync_tabs\(app\);/.test(browserRs));
check("every tab mutation mirrors to disk (activate)", /fn activate_tab[\s\S]*?sync_tabs\(app\);/.test(browserRs));
check("every tab mutation mirrors to disk (navigation retitles the tab)",
  /fn on_tab_title[\s\S]*?sync_tabs\(app\);/.test(browserRs));
check("sync_tabs pushes the strip AND persists it, so the two cannot drift",
  /fn sync_tabs[\s\S]*?push_tabs\(app\);[\s\S]*?persist_session\(app\);/.test(browserRs));
check("binding never steals a browser another project is using",
  /fn browser_session_bind[\s\S]*?owned_by_other[\s\S]*?if !owned_by_other \{\s*\*owner = Some/.test(browserRs));
check("browser_session_bind is registered as a command", /browser::browser_session_bind,/.test(libRs));
check("tabs outside a project use a reserved personal-agent session instead of being discarded",
  /const PERSONAL_SESSION_STEM: &str = "_personal"/.test(browserRs)
  && /fn live_session_stem[\s\S]*?PERSONAL_SESSION_STEM/.test(browserRs));
check("recently closed tabs survive later session writes and stay bounded",
  /fn persist_session[\s\S]*?let closed = read_session\(&stem\)\.closed/.test(browserRs)
  && /CLOSED_HISTORY_MAX[\s\S]*?session\.closed\.drain/.test(browserRs));
check("the native recovery commands are registered on every desktop OS",
  /browser::browser_session_reopen,/.test(libRs)
  && /browser::browser_reopen_closed,/.test(libRs));

// ---- AgentsPage wiring ---------------------------------------------------
check("the Agents page restores a project's browser when the project is opened",
  /restoreProjectBrowser\(\s*projectId,/.test(agents));
check("the first pass after mount is the app-start pass",
  /browserRestoreBootRef\s*=\s*useRef\(true\)/.test(agents)
  && /browserRestoreBootRef\.current = false;/.test(agents));
check("a project is only restored once per page",
  /browserRestoredRef\.current\.has\(projectId\)/.test(agents));
check("restore never blocks the GUI",
  /window\.setTimeout\(\(\) => \{\s*void restoreProjectBrowser/.test(agents));
check("restore failures are surfaced, not swallowed",
  /restoreProjectBrowser failed[\s\S]*?setProjectMaterializeError/.test(agents));
check("a newly created project claims its session through the same restore path",
  /void restoreProjectBrowser\(\s*target\.id,/.test(agents));
check("creation and selection never launch the same environment twice",
  /justCreatedProjectRef\.current = target\.id;/.test(agents)
  && /justCreatedProjectRef\.current === projectId/.test(agents));
check("the project toolbar exposes an obvious saved-browser reopen action",
  /data-ui="ReopenProjectBrowserBtn"/.test(agents)
  && /reopenSelectedProjectBrowser\(\)/.test(agents));
check("the explicit reopen bypasses the once-per-page automatic restore guard",
  /const reopenSelectedProjectBrowser[\s\S]*?restoreProjectBrowser\([\s\S]*?\{ boot: false \}/.test(agents));
check("Project settings reuses the saved-session restore instead of reopening only the original recipe",
  /onReopenBrowser\?[\s\S]*?await onReopenBrowser\(\)[\s\S]*?Reopen browser/.test(dialog));

// ---- Pages that belong to no project ------------------------------------
// The first cut persisted a session ONLY while a project owned the browser.
// A personal agent's desk of logged-in apps belongs to no project, so closing
// it wrote nothing at all and there was no way back. Strip comments first: the
// prose above must never be what satisfies these checks.
const rsCode = browserRs.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const chrome = read(path.join(UI, "../public/browser-chrome.html")).replace(/<!--[\s\S]*?-->/g, "");
const agentsCode = agents.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const envCode = envSource.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

check("ownerless tabs still get a session file",
  /const PERSONAL_SESSION_STEM/.test(rsCode) && /fn live_session_stem/.test(rsCode));
check("the personal session file cannot collide with a project's",
  /PERSONAL_SESSION_STEM: &str = "_/.test(rsCode) && /trim_matches\('_'\)/.test(rsCode));
check("persisting no longer bails out when no project owns the browser",
  !/fn persist_session[\s\S]*?let Some\(owner\) = SESSION_OWNER/.test(rsCode)
  && /fn persist_session[\s\S]*?live_session_stem\(\)/.test(rsCode));
check("closing the browser is remembered even with no project selected",
  !/fn mark_session_closed[\s\S]*?let Some\(owner\) = SESSION_OWNER/.test(rsCode)
  && /fn mark_session_closed[\s\S]*?live_session_stem\(\)/.test(rsCode));

// ---- Undoing a closed tab ------------------------------------------------
check("the session keeps a closed-page history", /pub closed: Vec<String>/.test(rsCode));
check("the closed-page history is capped", /CLOSED_HISTORY_MAX/.test(rsCode)
  && /fn remember_closed_tab[\s\S]*?CLOSED_HISTORY_MAX[\s\S]*?drain\(\.\./.test(rsCode));
check("a closed page is recorded before the strip is rewritten without it",
  /fn close_tab[\s\S]*?let closing_url[\s\S]*?remember_closed_tab\(&closing_url\)/.test(rsCode));
check("the closed page is read outside the TABS lock",
  /let closing_url = list_tabs\(app\)[\s\S]*?let next = \{/.test(rsCode));
check("persisting the strip preserves the reopen history",
  /fn persist_session[\s\S]*?let closed = read_session\(&stem\)\.closed;[\s\S]*?closed,\s*\},?\s*\);/.test(rsCode));
check("a page that fails to reopen cannot wedge the history",
  /fn browser_reopen_closed[\s\S]*?session\.closed\.pop\(\)[\s\S]*?write_session\(&stem, &session\);[\s\S]*?browser_open_tab/.test(rsCode));
check("reopening the whole desk survives one dead page",
  /fn browser_session_reopen[\s\S]*?Err\(e\) => failed\.push/.test(rsCode));
check("both reopen commands are registered",
  /browser::browser_session_reopen,/.test(libRs) && /browser::browser_reopen_closed,/.test(libRs));

// ---- Reopen has to be reachable -----------------------------------------
check("the tab strip offers a reopen control", /id="reopen"/.test(chrome)
  && /\$\("reopen"\)\.addEventListener\("click"[\s\S]*?evt\("tabreopen"\)/.test(chrome));
check("Ctrl/Cmd+Shift+T reopens the last closed tab",
  /shiftKey && \(e\.key === "T"[\s\S]*?evt\("tabreopen"\)/.test(chrome));
check("the reopen control is localized like every other chrome control",
  /\$\("reopen"\)\.title = copy\[9\]/.test(chrome));
check("the chrome reopen action reaches Rust", /"tabreopen" =>[\s\S]*?browser_reopen_closed/.test(rsCode));
check("the toolbar reopen works with no project selected",
  !/const reopenSelectedProjectBrowser = async \(\) => \{\s*if \(!selectedProject\) \{\s*throw/.test(agentsCode)
  && /if \(!selectedProject\) \{\s*return await reopenPersonalBrowserSession/.test(agentsCode));
check("the reopen button is not disabled without a project",
  !/data-ui="ReopenProjectBrowserBtn"[\s\S]{0,600}?disabled=\{!selectedProjectId/.test(agentsCode));
check("the personal reopen surfaces pages it could not restore",
  /export async function reopenPersonalBrowserSession[\s\S]*?failed[\s\S]*?could not be reopened/.test(envCode));

console.log(`\nbrowserSessionRestore: ${passed}/${passed} checks passed`);

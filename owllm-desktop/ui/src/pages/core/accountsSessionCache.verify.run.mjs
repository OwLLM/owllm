// Regression gate for the once-per-session accounts probe.
//
// The defect: eight components each called invoke("accounts_status") on mount,
// and three of them polled it (3s / 4s / 5s). Every page navigation re-ran the
// CLI/PATH scan and repainted the provider badges — empty first, resolved a
// moment later. That late-resolving state is the page-open flash.
//
// This gate proves, dynamically, that the shared store probes ONCE per session
// no matter how many pages mount, that a persisted snapshot is readable BEFORE
// any probe resolves (so the first paint is already correct), and that the
// explicit re-check still refreshes. The static half proves the consumers
// actually go through the store — without it the store could be perfect and
// bypassed. Both halves fail on the pre-fix code.
//
// Run from owllm-desktop/: node ui/src/pages/core/accountsSessionCache.verify.run.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, "../../..");
const ROOT = path.resolve(HERE, "../../../..");
const ts = (await import(pathToFileURL(path.join(ROOT, "node_modules/typescript/lib/typescript.js")).href)).default;

let pass = 0;
function check(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    pass++;
  }
}

// TEMP is what Windows sets; TMPDIR is the POSIX name. Same fallback order the
// sibling verify runners use — without it this gate only runs on Linux/macOS.
const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "accounts-cache-"));

// ---- instrument -------------------------------------------------------------
// A counting invoke() plus the minimal browser surface the store touches. The
// count IS the measurement: it is how many real probes a run performed.
const FULL_STATUS = {
  host_os: "windows", anthropic_api_key: true, openai_api_key: false,
  moonshot_api_key: false, deepseek_api_key: false, xai_api_key: false,
  groq_api_key: false, perplexity_api_key: false, mistral_api_key: false,
  together_api_key: false, gemini_api_key: false,
  claude_cli: true, claude_cli_installed: true,
  codex_cli: false, codex_cli_installed: false,
  kimi_cli: false, kimi_cli_installed: false, kimi_cli_reauth_required: false,
  gemini_cli: false, gemini_cli_installed: false,
  grok_cli: false, grok_cli_installed: false,
};

const source = fs.readFileSync(path.join(HERE, "accountsStore.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;

const listenerBusJs = ts.transpileModule(
  fs.readFileSync(path.join(HERE, "../../runtime/listenerBus.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } },
).outputText;

/// Load a FRESH copy of the store (module scope = session scope, so each case
/// needs its own instance). `seed` pre-populates localStorage the way a
/// previous launch would have.
let instance = 0;
async function loadStore(seed) {
  const dir = path.join(temp, `s${instance++}`);
  fs.mkdirSync(dir);
  const state = { calls: 0, intervals: 0, cleared: 0, reply: { ...FULL_STATUS } };
  const store = new Map();
  if (seed) store.set("owllm:accounts:v1", JSON.stringify(seed));
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
  };
  globalThis.window = {
    setInterval: () => { state.intervals++; return 1; },
    clearInterval: () => { state.cleared++; },
  };
  fs.writeFileSync(
    path.join(dir, "core.mjs"),
    `export const invoke = async () => { globalThis.__probe.calls++; return globalThis.__probe.reply; };\n`,
  );
  // The store notifies through the shared watcher fan-out — the REAL module,
  // so subscribe()/emit() stay covered end-to-end.
  fs.writeFileSync(path.join(dir, "listenerBus.mjs"), listenerBusJs);
  fs.writeFileSync(
    path.join(dir, "store.mjs"),
    compiled
      .replace('"@tauri-apps/api/core"', '"./core.mjs"')
      .replace('"../../runtime/listenerBus"', '"./listenerBus.mjs"'),
  );
  globalThis.__probe = state;
  const mod = await import(pathToFileURL(path.join(dir, "store.mjs")).href);
  return { mod, state };
}

// ---- A. one probe per session, however many pages mount ---------------------
{
  const { mod, state } = await loadStore(null);
  check(mod.getCachedAccounts() === null, "a cold session starts with no cached status");
  // Eight components mounting is exactly the pre-fix call pattern.
  await Promise.all(Array.from({ length: 8 }, () => mod.fetchAccounts()));
  check(state.calls === 1, `eight simultaneous page mounts share ONE probe (saw ${state.calls})`);

  // Re-opening those pages later in the same session must add nothing.
  for (let i = 0; i < 5; i++) await mod.fetchAccounts();
  check(state.calls === 1, `five later page opens perform NO new check (saw ${state.calls})`);
  check(mod.getCachedAccounts()?.claude_cli === true, "the cached snapshot is what pages render");
}

// ---- B. no flash: a page open renders resolved state synchronously ----------
{
  const { mod, state } = await loadStore(FULL_STATUS);
  // This is the first-paint moment: the component's useState initialiser runs
  // before any probe can resolve. Non-null here == badges painted correctly on
  // frame one, instead of empty-then-filled.
  const atFirstPaint = mod.getCachedAccounts();
  check(atFirstPaint !== null, "a persisted snapshot is readable at first paint, before any probe");
  check(atFirstPaint?.claude_cli === true, "the first-paint snapshot carries real values, not placeholders");
  check(state.calls === 0, "reading the cache alone starts no probe");

  // ...and exactly one background refresh runs for the whole session.
  await mod.fetchAccounts();
  await mod.fetchAccounts();
  await new Promise((r) => setImmediate(r));
  check(state.calls === 1, `a seeded session refreshes exactly once (saw ${state.calls})`);
}

// ---- C. the manual re-check still works ------------------------------------
{
  const { mod, state } = await loadStore(null);
  await mod.fetchAccounts();
  check(state.calls === 1, "baseline probe ran");

  state.reply = { ...FULL_STATUS, codex_cli: true };
  const rechecked = await mod.fetchAccounts(true);
  check(state.calls === 2, `an explicit re-check forces a real probe (saw ${state.calls})`);
  check(rechecked?.codex_cli === true, "the re-check returns the NEW status, not the cached one");
  check(mod.getCachedAccounts()?.codex_cli === true, "every page sees the refreshed status");
}

// ---- D. re-validation when something relevant actually changed -------------
{
  const { mod, state } = await loadStore(null);
  await mod.fetchAccounts();
  state.reply = { ...FULL_STATUS, gemini_api_key: true };
  await mod.invalidateAccounts();
  check(state.calls === 2, `saving a key re-validates the cache (saw ${state.calls})`);
  check(mod.getCachedAccounts()?.gemini_api_key === true, "the new key reaches every picker at once");
}

// ---- E. subscribers are told, so pages re-render without polling ------------
{
  const { mod } = await loadStore(null);
  let notified = 0;
  const off = mod.subscribeAccounts(() => { notified++; });
  await mod.fetchAccounts();
  check(notified > 0, "subscribers are notified when a probe lands");
  off();
  const settled = notified;
  await mod.fetchAccounts(true);
  check(notified === settled, "unsubscribing really detaches (no leak across page unmounts)");
}

// ---- F. the live watch is page-scoped and single ---------------------------
{
  const { mod, state } = await loadStore(null);
  const stop1 = mod.startAccountsWatch();
  const stop2 = mod.startAccountsWatch();
  check(state.intervals === 1, `two watchers share ONE interval (saw ${state.intervals})`);
  stop1();
  check(state.cleared === 0, "the interval survives while a watcher remains");
  stop2();
  check(state.cleared === 1, "leaving the page stops the poll — no background checks persist");
  stop2();
  check(state.cleared === 1, "releasing twice is a no-op (no double clear)");
}

// ---- G. the WSL probe is cached per session, but never a negative ----------
// wsl_status spawns wsl.exe twice and both AgentsPage and CodePage probe it on
// mount, so it repeated on every page/tab open. It is cached now — but caching
// a "no WSL" answer would be worse than the repeat: a cold WSL service reports
// missing, and the app would claim WSL is gone for the whole session.
{
  const wslSrc = fs.readFileSync(path.join(UI, "src/pages/agentic/wslIsolation.ts"), "utf8");
  const wslJs = ts.transpileModule(wslSrc, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dir = path.join(temp, "wsl");
  fs.mkdirSync(dir);
  const state = { calls: 0, reply: { available: true, distros: ["Ubuntu"], defaultDistro: "Ubuntu", bestDistro: "Ubuntu" } };
  fs.writeFileSync(
    path.join(dir, "core.mjs"),
    `export const invoke = async (cmd) => {\n`
    + `  if (cmd === "wsl_status") { globalThis.__wsl.calls++; return globalThis.__wsl.reply; }\n`
    + `  return "";\n};\n`,
  );
  fs.writeFileSync(path.join(dir, "wsl.mjs"), wslJs.replace('"@tauri-apps/api/core"', '"./core.mjs"'));
  globalThis.__wsl = state;
  const wsl = await import(pathToFileURL(path.join(dir, "wsl.mjs")).href);

  await wsl.wslStatus();
  await wsl.wslStatus();
  await wsl.wslStatus();
  check(state.calls === 1, `three page opens share ONE wsl.exe probe (saw ${state.calls})`);

  // A negative must NOT stick: this is the cold-service case.
  wsl.invalidateWslStatus();
  state.reply = { available: false, distros: [], defaultDistro: null, bestDistro: null };
  await wsl.wslStatus();
  await wsl.wslStatus();
  check(state.calls === 3, `a "WSL missing" answer is never cached (saw ${state.calls}, want 3)`);

  // Installing WSL must be visible immediately.
  state.reply = { available: true, distros: ["Ubuntu"], defaultDistro: "Ubuntu", bestDistro: "Ubuntu" };
  const after = await wsl.wslStatus();
  check(after.available === true, "a freshly installed distro is seen without restarting the app");

  const before = state.calls;
  await wsl.wslInstall();
  await wsl.wslStatus();
  check(state.calls > before, "wslInstall() invalidates the cache so the next read re-probes");

  const setup = fs.readFileSync(path.join(UI, "src/pages/core/WslSetupModal.tsx"), "utf8");
  check(setup.includes("invalidateWslStatus()"),
    "the setup modal's Re-check clears the cached probe");
}

// ---- H. static: the consumers actually go through the store -----------------
const read = (rel) => fs.readFileSync(path.join(UI, rel), "utf8").replace(/\r\n/g, "\n");

// Informational consumers: badge / dimmed-picker feedback only. None of them
// may probe directly, and each must seed from the cache so its first paint is
// already correct.
const INFORMATIONAL = [
  "src/pages/agentic/AgentsPage.tsx",
  "src/pages/agentic/CodePage.tsx",
  "src/pages/agentic/StudioPage.tsx",
  "src/pages/agentic/TeamMemoryModal.tsx",
  "src/support/WatcherDrawer.tsx",
  "src/pages/finetuning/ChatPage.tsx",
  "src/pages/finetuning/DatasetBuilderPage.tsx",
  "src/bridges/bridgeCore.ts",
];
for (const rel of INFORMATIONAL) {
  const src = read(rel);
  // The informational probe is the one typed as the full/lite status object —
  // that is the badge feed, and it must come from the cache. AgentsPage also
  // holds a FUNCTIONAL gate (`invoke<{ claude_cli: boolean }>`) in its
  // forceSub path; that one is deliberately live and is asserted below.
  check(!/invoke<AccountsStatus(Lite|Full)?>\("accounts_status"\)/.test(src),
    `${path.basename(rel)} does not probe accounts_status for badge state`);
  check(src.includes("getCachedAccounts()"),
    `${path.basename(rel)} seeds its provider state from the session cache (no empty first paint)`);
  check(src.includes("subscribeAccounts("),
    `${path.basename(rel)} re-renders from the shared cache instead of polling`);
}

// The polls that made every open re-check are gone.
const agents = read("src/pages/agentic/AgentsPage.tsx");
check(!/accounts_status[\s\S]{0,400}?setInterval/.test(agents), "AgentsPage no longer polls accounts_status");
const bridge = read("src/bridges/bridgeCore.ts");
check(!/accounts_status[\s\S]{0,400}?setInterval/.test(bridge), "the bridge no longer polls accounts_status");

// AccountsPage: renders from the cache, owns the ONE live watch, and
// re-validates on real mutations rather than relying on the poll alone.
const accountsPage = read("src/pages/advanced/AccountsPage.tsx");
check(accountsPage.includes("startAccountsWatch()"), "AccountsPage owns the single live watch");
check(!/window\.setInterval\(tick, 3000\)/.test(accountsPage), "AccountsPage's private 3s poll is gone");
check(accountsPage.includes("getCachedAccounts()"), "AccountsPage paints from the cache on open");
check((accountsPage.match(/invalidateAccounts\(\)/g) || []).length >= 4,
  "AccountsPage re-validates after save / delete / logout / login-terminal close");

// The functional gate must NOT be cached: dispatch re-checks the CLI for real
// at the moment it is about to use it. Caching that would turn a real "not
// logged in" into a confusing CLI failure.
const dispatch = read("src/pages/agentic/dispatch.ts");
check(/invoke<[^>]*>\("accounts_status"\)/.test(dispatch),
  "dispatch.ts still probes live before using a CLI (functional gate, deliberately uncached)");
// AgentsPage's forceSub gate moved into the shared dispatch.ts when the
// page's duplicated cloud stack collapsed (2026-08-14). The "probes LIVE"
// invariant is pinned on dispatch.ts above; the page's pin is now that it
// neither runs a CLI gate of its own nor reads the CLI flag from the cache
// (its remaining getCachedAccounts() uses are the cosmetic badge feed).
check(!/invoke<[^>]*>\("accounts_status"\)/.test(agents),
  "AgentsPage runs no CLI gate of its own (the live probe lives in shared dispatch.ts)");
check(!/getCachedAccounts\(\)[\s\S]{0,200}?claude_cli\b/.test(agents),
  "AgentsPage does not read the CLI flag from the session cache");

// The store documents which callers gate behaviour and which are cosmetic.
const store = read("src/pages/core/accountsStore.ts");
check(store.includes("FUNCTIONAL GATING") && store.includes("INFORMATIONAL ONLY"),
  "the store documents what each check actually guards");

fs.rmSync(temp, { recursive: true, force: true });
if (!process.exitCode) console.log(`OK accounts session cache: ${pass}/${pass} checks passed`);

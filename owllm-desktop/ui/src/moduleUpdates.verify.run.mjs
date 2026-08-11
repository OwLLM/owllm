// Regression gate: an installed module with a newer build on the server must be
// REACHABLE and ANNOUNCED. The shipped code did neither, and the consequence was
// not cosmetic — it made a published engine impossible to install.
//
// What this pins:
//
//  1. ModuleWizard has always had a `mode="settings"`, and its header even
//     renders the title "Modules" for it — but nothing ever mounted it that
//     way. `useNeedsFirstRunWizard()` goes false the moment any module is
//     installed, so after the first launch the page did not exist. The
//     local-inference crash hint told users, by name, to go to a route with
//     no entry point anywhere in the app.
//  2. Nothing ever re-checked the module registry. It is republished
//     independently of the app (that is the whole point of modules), so a
//     launch-time "nothing new" answer expires within days — an install could
//     sit for months on an engine that cannot load current GGUF architectures.
//  3. Opening the page from an "engine update" prompt landed on an unticked
//     checkbox and a disabled-looking Install button.
//
// Section 1 EXECUTES runtime/moduleUpdates.ts; the rest pins the wiring in the
// surfaces that consume it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, "runtime", "moduleUpdates.ts");
const SHELL = path.join(HERE, "AppShell.tsx");
const WIZARD = path.join(HERE, "pages", "modules", "ModuleWizard.tsx");
const SERVER = path.join(HERE, "..", "..", "src-tauri", "src", "server.rs");

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

console.log("\nModule updates are reachable and announced:\n");

// ---- 1. EXECUTE the real store ---------------------------------------------

const store = codeOf(STORE);
if (!store) {
  check("runtime/moduleUpdates.ts exists", false);
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-moduleupdates-"));
  const bundle = path.join(tmp, "store.mjs");
  await esbuild.build({
    entryPoints: [STORE], bundle: true, format: "esm", platform: "node",
    outfile: bundle, logLevel: "silent",
  });
  const mod = await import(`file://${bundle.replace(/\\/g, "/")}`);

  const engine = (installed, available) => ({
    id: "local-inference", displayName: "Local Inference",
    installedVersion: installed, availableVersion: available,
  });

  let renders = 0;
  const stop = mod.subscribeModuleUpdates(() => { renders += 1; });

  check("starts empty — no badge before anything has been checked",
    mod.getModuleUpdates().length === 0);

  mod.setModuleUpdates([engine("b3850-cuda12.4", "b10358-cuda12.4")]);
  check("a pending update is published to subscribers",
    renders === 1 && mod.getModuleUpdates()[0].availableVersion === "b10358-cuda12.4");

  // The 6-hourly check re-reports the same answer. It must not repaint the
  // chrome, or the badge flickers every few hours forever.
  mod.setModuleUpdates([engine("b3850-cuda12.4", "b10358-cuda12.4")]);
  check("re-reporting the SAME pending update is idempotent (no repaint)", renders === 1);

  mod.setModuleUpdates([engine("b3850-cuda12.4", "b11000-cuda12.4")]);
  check("a NEWER available version does repaint", renders === 2);

  mod.setModuleUpdates([]);
  check("installing it clears the badge",
    renders === 3 && mod.getModuleUpdates().length === 0);

  // A listener that throws must not stop the others: the update check is the
  // only thing that can tell a user their engine is too old.
  const order = [];
  const stopBad = mod.subscribeModuleUpdates(() => { order.push("bad"); throw new Error("boom"); });
  const stopGood = mod.subscribeModuleUpdates(() => { order.push("good"); });
  mod.setModuleUpdates([engine("b3850-cuda12.4", "b10358-cuda12.4")]);
  check("a throwing subscriber cannot break the check", order.includes("good"));
  stopBad(); stopGood();

  const before = renders;
  stop();
  mod.setModuleUpdates([]);
  check("unsubscribing really detaches", renders === before);

  // The route out of the store: openModulesPage() must actually reach AppShell.
  const seen = [];
  globalThis.window = {
    dispatchEvent: (e) => { seen.push(e.type); return true; },
    CustomEvent: class { constructor(type) { this.type = type; } },
  };
  globalThis.CustomEvent = globalThis.window.CustomEvent;
  mod.openModulesPage();
  check("openModulesPage() fires the event AppShell mounts the page on",
    seen.length === 1 && seen[0] === mod.OPEN_MODULES_EVENT);
  delete globalThis.window; delete globalThis.CustomEvent;

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- 2. The page is REACHABLE ----------------------------------------------

const shell = codeOf(SHELL);
if (!shell) {
  check("AppShell.tsx exists", false);
} else {
  check("the Modules page is mounted in settings mode (the route exists at all)",
    /<ModuleWizard\s+mode="settings"/.test(shell.code));

  check("that mount is driven by OPEN_MODULES_EVENT",
    /addEventListener\(OPEN_MODULES_EVENT/.test(shell.code)
    && /removeEventListener\(OPEN_MODULES_EVENT/.test(shell.code));

  check("the mount is rendered, not merely defined",
    /<ModulesPageMount\s*\/>/.test(shell.code));

  check("Settings has a Modules row that opens it",
    /data-ui="SettingsModulesRow"/.test(shell.code)
    && /onOpenModules\?\.\(\)/.test(shell.code));

  check("the chrome carries its own module badge, wired to the same opener",
    /data-ui="ModuleUpdateBadge"/.test(shell.code)
    && /onOpenModules=\{openModulesPage\}/.test(shell.code));

  // The app-update chip already occupies one spot under the OWLLM mark. Two
  // absolutely-positioned chips on the same coordinates would overlap.
  check("the module badge steps aside when the app-update badge is also showing",
    /translate\(38px, \$\{updateBadge \? 40 : 22\}px\)/.test(shell.code));

  // ---- 3. The check REPEATS ------------------------------------------------

  check("module updates are checked on a repeating interval, not once per launch",
    /setInterval\(\(\) => \{ void checkModuleUpdates\(\); \}, 6 \* 60 \* 60 \* 1000\)/.test(shell.code));

  check("the watcher is rendered",
    /<ModuleUpdateWatcher\s*\/>/.test(shell.code));

  check("the check asks the backend and publishes what it finds",
    /invoke<[\s\S]*?>\("module_list"\)/.test(shell.code)
    && /state === "update-available"/.test(shell.code)
    && /setModuleUpdates\(pending\)/.test(shell.code));

  check("a backend that isn't up yet cannot break the shell",
    /catch \{[\s\S]{0,200}\n  \}\n\}\n\n/.test(shell.code.slice(shell.code.indexOf("async function checkModuleUpdates"))));

  check("closing the page re-checks, so the badge clears after installing",
    /onClose=\{\(\) => \{ setOpen\(false\); void checkModuleUpdates\(\); \}\}/.test(shell.code));
}

// ---- 4. Landing there is one click -----------------------------------------

const wizard = codeOf(WIZARD);
if (!wizard) {
  check("ModuleWizard.tsx exists", false);
} else {
  check("modules with an update waiting arrive pre-selected",
    /if \(m\.state === "update-available"\) pre\.add\(m\.id\)/.test(wizard.code)
    && /if \(pre\.size > 0\) setSelected\(pre\)/.test(wizard.code));

  check("settings mode can still be dismissed — it must never hold the GUI hostage",
    /mode === "settings" && \(\s*\n?\s*<button onClick=\{onClose\}/.test(wizard.code)
    || /\{mode === "settings" &&[\s\S]{0,120}onClick=\{onClose\}/.test(wizard.code));
}

// ---- 5. The crash hint points at a route that EXISTS -----------------------

const server = codeOf(SERVER);
if (!server) {
  check("src-tauri/src/server.rs exists", false);
} else {
  const hintStart = server.code.indexOf('"arch_unsupported"');
  const hint = hintStart < 0 ? "" : server.code.slice(hintStart, hintStart + 700);

  check("the unsupported-architecture hint exists and still refuses to blame the file",
    hint.length > 0 && /NOT corrupt/.test(hint));

  check("it sends the user to Settings → Modules, not the old 'Home → Modules' dead end",
    /Settings \(⚙, top right\) → Modules/.test(hint) && !/Home → Modules/.test(hint));

  check("no hint anywhere still names the route that never existed",
    !/Home → Modules/.test(server.code) && !/Home → reinstall/.test(server.code));
}

console.log("");
if (failures > 0) {
  throw new Error(`FAILED: ${failures} module-update check(s) failed.`);
}
console.log("PASS: module updates are reachable, re-checked, announced, and one click to install.\n");

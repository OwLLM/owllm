// Verifies that the existing top-header Gamify mode toggle opens World Map
// directly. There must not be a second Gamify shortcut beside it.
//
// CRLF-robust: all source reads normalise line endings so a Windows
// autocrlf checkout can't false-fail the multi-line pins.
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)));
const UI = path.resolve(HERE, "../..");
const read = (relative) => fs.readFileSync(path.join(UI, relative), "utf8").replace(/\r\n/g, "\n");

const checks = [];
function check(name, condition) {
  checks.push({ name, ok: Boolean(condition) });
  if (!condition) throw new Error(`FAIL ${name}`);
}

const appShell = read("AppShell.tsx");
const modules = read("core/modules.ts");
const generated = read("localization/catalog.generated.ts");

// The original Gamify mode toggle remains the single header control.
check("Header keeps the existing Gamify mode toggle", appShell.includes('dataUi: "GamifyToggle"'));
check("Header does not render a duplicate Gamify shortcut", !appShell.includes('data-ui="GamifyWorldMapButton"'));

// Its existing render-loop click handler special-cases only Gamify and uses
// the shared navigation event, preserving AppShell's normal mode/tab/history
// behavior while the other mode toggles retain their original semantics.
const togglesStart = appShell.indexOf("{visibleToggles.map(t => (");
const togglesEnd = appShell.indexOf("))}", togglesStart);
const toggleBlock = appShell.slice(togglesStart, togglesEnd);
check("Existing Gamify toggle is special-cased in its click handler", toggleBlock.includes('t.id === "gamify"'));
check("Gamify toggle dispatches the shared owllm:navigate event", toggleBlock.includes('new CustomEvent("owllm:navigate"'));
check("Gamify toggle targets the world-map page key", toggleBlock.includes('detail: { key: "world-map" }'));
check("Other mode toggles preserve their original toggle behavior", toggleBlock.includes('setMode(mode === t.id ? "home" : t.id)'));

// The world-map key is a real Gamify page in the module registry — the
// navigate handler resolves it to mode=gamify + the world-map SubTab.
check("world-map is a registered Gamify page", modules.includes('key: "world-map"') && modules.includes("component: WorldMapPage"));
check("AppShell navigate handler flips Gamify mode for its pages", appShell.includes('m.id === "gamify"') && appShell.includes("setActiveKey(key)"));

// The existing toggle continues to use the shared active/base pill styling.
check("Gamify toggle keeps the shared header pill styling", toggleBlock.includes("mode === t.id ? active : baseBtn"));
check("Header pill styling comes from the shared theme helper", appShell.includes("const baseBtn = headerPill(false)"));

// Visibility remains governed by the existing installed-mode filter.
check("Gamify toggle remains gated by installed modes", appShell.includes("const visibleToggles = TOGGLES.filter"));

// Localization: the header label + title are auto-translated by the document
// localizer. The original label remains in the generated catalog.
check("Button label 'Gamify' is in the localization catalog", generated.includes('"Gamify",'));

for (const row of checks) console.log(`  PASS ${row.name}`);
console.log(`gamify header button verification: ${checks.length}/${checks.length} passed`);

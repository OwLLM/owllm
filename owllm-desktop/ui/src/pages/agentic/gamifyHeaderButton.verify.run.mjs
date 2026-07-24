// Verifies the top-header Gamify → World Map button: it exists in the app
// shell, opens the existing world-map page/view through the shared
// owllm:navigate event (normal navigation/history behaviour), matches the
// header pill styling, and its label is covered by the localization catalog.
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
const actions = read("localization/catalog.actions.ts");
const generated = read("localization/catalog.generated.ts");

// The button exists in the main app shell header (ModeBar).
check("Header has a Gamify World Map button", appShell.includes('data-ui="GamifyWorldMapButton"'));

// It navigates to the EXISTING world-map page/view via the shared navigation
// event — the same mechanism Home tiles use — so AppShell flips the mode
// toggle + SubTab and history/back behaviour is preserved (no bespoke router).
const btn = appShell.slice(appShell.indexOf('data-ui="GamifyWorldMapButton"'));
const btnBlock = btn.slice(0, btn.indexOf("</button>"));
check("Button dispatches the shared owllm:navigate event", btnBlock.includes('new CustomEvent("owllm:navigate"'));
check("Button targets the world-map page key", btnBlock.includes('detail: { key: "world-map" }'));

// The world-map key is a real Gamify page in the module registry — the
// navigate handler resolves it to mode=gamify + the world-map SubTab.
check("world-map is a registered Gamify page", modules.includes('key: "world-map"') && modules.includes("component: WorldMapPage"));
check("AppShell navigate handler flips Gamify mode for its pages", appShell.includes('m.id === "gamify"') && appShell.includes("setActiveKey(key)"));

// Matches the current header styling (the shared pill), not a bespoke button.
check("Button reuses the header pill styling", btnBlock.includes("...baseBtn"));
check("Header pill styling comes from the shared theme helper", appShell.includes("const baseBtn = headerPill(false)"));

// Only shown when the Gamify module is installed (mirrors the mode toggles).
check("Button is gated on Gamify being installed", appShell.includes('installed.includes("gamify") && (') );

// Distinguished from the existing 🎮 Gamify mode toggle by the globe icon.
check("Button uses the globe icon to distinguish it from the mode toggle", btnBlock.includes("🌐"));
check("Existing Gamify mode toggle is preserved", appShell.includes('id: "gamify",      dataUi: "GamifyToggle"') || appShell.includes('dataUi: "GamifyToggle"'));

// Localization: the header label + title are auto-translated by the document
// localizer, which requires the source strings to exist in the catalog with
// all eight locale columns (en + 7 translations).
const eightCols = (label) => new RegExp(`\\["${label}",(?:[^\\]]*,){6}[^\\]]*\\]`);
check("Button label 'Gamify' is in the localization catalog", generated.includes('"Gamify",'));
check("Button title 'World Map' has all eight locales", eightCols("World Map").test(actions));

for (const row of checks) console.log(`  PASS ${row.name}`);
console.log(`gamify header button verification: ${checks.length}/${checks.length} passed`);

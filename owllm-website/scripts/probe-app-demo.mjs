/*
 * Probe the embedded real-app demo the way a real visitor's browser sees it
 * (plain Chromium, no Tauri IPC). Clicks through the module toggles and
 * verifies each module's first tab renders. Exits non-zero on console
 * errors that break navigation or on a failed module switch.
 *
 * Usage: node scripts/probe-app-demo.mjs [baseUrl]
 *   baseUrl defaults to http://localhost:4322
 * Requires: npx playwright (uses owllm-desktop's dev dependency).
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, "..", "..", "owllm-desktop");
const require = createRequire(path.join(desktopDir, "package.json"));
const { chromium } = require("playwright");

const base = process.argv[2] || "http://localhost:4322";
const shots = path.join(here, "..", "test", "app-demo-shots");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`${base}/app-demo/index.html`, { waitUntil: "networkidle" });

// First-run wizard may cover the app — dismiss it like a visitor would.
const later = page.getByRole("button", { name: "Set up later" });
if (await later.isVisible().catch(() => false)) await later.click();

// `banned` = regression check for browser-mode raw-TypeError surfaces
// (ModelsPage recommendations banner, CodePage models toast): those
// mount-time invokes are gated on isTauri and must never show here.
const checks = [
  { toggle: "🛠 Fine Tuning", expectTab: "Models", banned: "Recommendations failed" },
  // The models toast fires when CodePage mounts, so visit the Coding tab.
  { toggle: "🎭 Agentic Team", tab: "💻 Coding", expectTab: "New page", banned: "Couldn't load models" },
  { toggle: "🎮 Gamify", expectTab: "World Map" },
];

let failed = 0;
for (const { toggle, tab: tabClick, expectTab, banned } of checks) {
  await page.getByRole("button", { name: toggle, exact: true }).click();
  if (tabClick) await page.getByText(tabClick, { exact: true }).first().click();
  const tab = page.getByText(expectTab, { exact: false }).first();
  let ok = await tab.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
  if (ok && banned) {
    await page.waitForTimeout(1500); // give a late banner/toast time to appear
    if (await page.getByText(banned).first().isVisible().catch(() => false)) {
      console.log(`FAIL banned text visible: "${banned}"`);
      ok = false;
    }
  }
  const slug = toggle.replace(/\W+/g, "-");
  await page.screenshot({ path: path.join(shots, `${slug}.png`) });
  console.log(`${ok ? "OK " : "FAIL"} ${toggle} -> ${expectTab}`);
  if (!ok) failed++;
}

if (errors.length) console.log("\nConsole page errors:\n" + errors.join("\n"));
await browser.close();
process.exit(failed ? 1 : 0);

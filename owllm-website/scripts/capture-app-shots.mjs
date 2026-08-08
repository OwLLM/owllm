/*
 * Capture real screenshots of the actual OWLLM interface (the browser-mode
 * bundle staged by build-app-demo.mjs) for use as website imagery. These
 * replace stock photos: everything shown on the site is the real app.
 *
 * Output: src/assets/app/*.png (committed — regenerate after UI redesigns).
 *
 * Usage: node scripts/capture-app-shots.mjs [baseUrl]
 *   baseUrl defaults to http://localhost:4322 (astro dev serving public/).
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, "..", "..", "owllm-desktop");
const require = createRequire(path.join(desktopDir, "package.json"));
const { chromium } = require("playwright");

const base = process.argv[2] || "http://localhost:4322";
const outDir = path.join(here, "..", "src", "assets", "app");
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(`${base}/app-demo/index.html`, { waitUntil: "networkidle" });
const later = page.getByRole("button", { name: "Set up later" });
if (await later.isVisible().catch(() => false)) await later.click();

/** Click a header toggle (a real <button>) or a tab-strip item (a span). */
async function go(name) {
  const btn = page.getByRole("button", { name, exact: true }).first();
  if (await btn.isVisible().catch(() => false)) await btn.click();
  else await page.getByText(name, { exact: true }).first().click();
  await page.waitForTimeout(900); // let icons/artwork paint
}

// Ordered as one forward walk through the app — module toggles are
// single-active (clicking the current one returns Home), so we never
// revisit a toggle and each step lands exactly one click away.
const shots = [
  { file: "home.png", nav: [] },
  { file: "models.png", nav: ["🛠 Fine Tuning"] }, // opens on Models
  { file: "chat.png", nav: ["💬 Chat"] },
  { file: "agents.png", nav: ["🎭 Agentic Team"] }, // opens on Agents
  { file: "code.png", nav: ["💻 Coding"] },
];

// Capture the app's content panel only, not the viewport: the app renders a
// transparent window margin around its frame (HybridFrame), which a viewport
// screenshot bakes in as a black band — a second frame around every image on
// the site. The panel is the first child of the frame root.
const panel = page.locator('[data-ui="hybrid-frame-root"] > div').first();

for (const { file, nav } of shots) {
  for (const step of nav) await go(step);
  // Browser mode surfaces a "no backend" toast on some pages; toasts
  // auto-dismiss, so let them clear before the marketing capture.
  await page.waitForTimeout(6000);
  if (await panel.count()) await panel.screenshot({ path: path.join(outDir, file) });
  else await page.screenshot({ path: path.join(outDir, file) });
  console.log(`captured ${file}`);
}

await browser.close();

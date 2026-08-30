/*
 * Build the REAL owllm-desktop React UI as a static, browser-mode bundle and
 * stage it into public/ so the website can embed the genuine app (iframe on
 * /how-to-use) instead of a hand-made imitation.
 *
 * The app UI officially supports running in a plain browser (no Tauri):
 * owllm-desktop/ui/src/main.tsx detects the missing __TAURI_INTERNALS__ and
 * skips the boot cover; pages gate native calls on isTauri(). TwinForge's
 * Playwright captures rely on the same mode.
 *
 * Staged output (all gitignored — generated at build time):
 *   public/app-demo/     the built UI (vite --base=/app-demo/)
 *   public/Page_icons/   icon packs the UI references via root-relative URLs
 *   public/App_icons/    (owllm-desktop's vite writeBundle copies them into
 *                        dist; we lift them to the site root so those URLs
 *                        keep resolving)
 *
 * Skips the (slow) rebuild when public/app-demo/index.html already exists;
 * pass --force to rebuild.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const websiteDir = path.resolve(here, "..");
const desktopDir = path.resolve(websiteDir, "..", "owllm-desktop");
// NOT ui/dist: that is tauri.conf.json's `frontendDist`, embedded into the
// binary at compile time. Building the demo there would leave the shipping
// bundle rewritten for --base=/app-demo/, and the next `cargo build` that
// skipped `npm run build` would embed it — a blank app whose asset URLs all
// point at /app-demo/. The demo gets its own out dir.
const DEMO_OUT = "dist-app-demo";
const distDir = path.join(desktopDir, "ui", DEMO_OUT);
const publicDir = path.join(websiteDir, "public");
const demoDir = path.join(publicDir, "app-demo");

const force = process.argv.includes("--force");

if (!fs.existsSync(desktopDir)) {
  console.error(`[app-demo] owllm-desktop not found at ${desktopDir}`);
  process.exit(1);
}

if (!force && fs.existsSync(path.join(demoDir, "index.html"))) {
  console.log("[app-demo] public/app-demo already staged — skipping (use --force to rebuild)");
  process.exit(0);
}

const run = (cmd, cwd) => {
  console.log(`[app-demo] ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
};

if (!fs.existsSync(path.join(desktopDir, "node_modules"))) {
  run("npm install --no-audit --no-fund", desktopDir);
}

run(`npx vite build --config ui/vite.config.ts --base=/app-demo/ --outDir ${DEMO_OUT} --emptyOutDir`, desktopDir);

// Stage: dist → public/app-demo, except the icon packs which must live at the
// site root because the app references them root-relatively (/Page_icons/…).
const ICON_PACKS = ["Page_icons", "Backgrounds", "3d", "App_icons"];
fs.rmSync(demoDir, { recursive: true, force: true });
fs.mkdirSync(demoDir, { recursive: true });
for (const entry of fs.readdirSync(distDir)) {
  const src = path.join(distDir, entry);
  if (ICON_PACKS.includes(entry)) {
    const dst = path.join(publicDir, entry);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true });
  } else {
    fs.cpSync(src, path.join(demoDir, entry), { recursive: true });
  }
}
console.log(`[app-demo] staged real app UI into ${demoDir}`);

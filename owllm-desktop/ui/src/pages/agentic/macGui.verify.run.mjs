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

const home = read("pages/core/HomePage.tsx");
const styles = read("styles.css");
const rust = read("../../src-tauri/src/lib.rs");

check("Home launcher row uses the responsive laptop grid",
  home.includes('className="home-launcher-grid"')
    && !home.includes('gridTemplateColumns: "repeat(3, 1fr)"'));
check("Home launcher squares stop expanding into oversized posters",
  /\.home-launcher-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*360px\)\)/.test(styles)
    && /\.home-launcher-grid\s*\{[\s\S]*justify-content:\s*center/.test(styles));
check("macOS performs one startup-only safe-area fit",
  rust.includes("fn fit_macos_main_window(window: &tauri::Window)")
    && rust.includes("static FIT_ONCE: AtomicBool")
    && rust.includes("FIT_ONCE.swap(true"));
check("macOS remains windowed instead of force-maximizing",
  rust.includes("target_h = 840.0_f64.min((screen_h - 170.0).max(640.0))")
    && rust.includes("target_y = screen_y + 40.0")
    && !/fit_macos_main_window[\s\S]{0,1800}\.maximize\(\)/.test(rust));
check("macOS safe-area fit runs before the main window is shown",
  rust.indexOf("fit_macos_main_window(&dispatch_window)") < rust.indexOf("let _ = dispatch_window.show()"));

for (const row of checks) console.log(`  PASS ${row.name}`);
console.log(`mac GUI verification: ${checks.length}/${checks.length} passed`);

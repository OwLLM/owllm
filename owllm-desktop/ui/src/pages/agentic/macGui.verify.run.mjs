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
const overlay = read("../../src-tauri/src/overlay_frame.rs");

check("Home launcher row uses the shared responsive grid",
  home.includes('className="home-launcher-grid"'));
check("Home launcher squares resize with the available page width",
  /\.home-launcher-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/.test(styles)
    && !/\.home-launcher-grid\s*\{[\s\S]*grid-template-columns:[^;]*(?:360px|max-content)/.test(styles));
check("macOS performs one startup-only safe-area fit",
  rust.includes("fn fit_macos_main_window(window: &tauri::Window)")
    && rust.includes("static FIT_ONCE: AtomicBool")
    && rust.includes("FIT_ONCE.swap(true"));
check("macOS remains windowed instead of force-maximizing",
  rust.includes("let target_w = DEFAULT_MAIN_W * fit_scale")
    && rust.includes("let target_h = DEFAULT_MAIN_H * fit_scale")
    && !/fit_macos_main_window[\s\S]{0,1800}\.maximize\(\)/.test(rust));
check("macOS startup fit preserves the shared 1400x960 proportions",
  rust.includes("const DEFAULT_MAIN_W: f64 = 1400.0")
    && rust.includes("const DEFAULT_MAIN_H: f64 = 960.0")
    && rust.includes("available_w / DEFAULT_MAIN_W")
    && rust.includes("available_h / DEFAULT_MAIN_H"));
check("macOS positions the transparent frame below the menu-bar margin",
  rust.includes("overlay_frame::content_offset_y()")
    && rust.includes("let target_y = screen_y + 40.0 + frame_headroom"));
check("macOS transparent overlay frame is enabled by default but remains opt-out",
  /#\[cfg\(target_os = "macos"\)\][\s\S]{0,260}OWLLM_OVERLAY_FRAME[\s\S]{0,180}unwrap_or\(true\)/.test(overlay));
check("macOS overlay is a click-through child of the main app window",
  overlay.includes("let builder = builder.parent(main)?")
    && overlay.includes('#[cfg(any(target_os = "windows", target_os = "macos"))]')
    && overlay.includes("overlay.set_ignore_cursor_events(true)"));
check("macOS reasserts the visible child frame above the main window",
  overlay.includes("fn show_overlay_above_main(")
    && overlay.includes("addChildWindow:")
    && overlay.includes("ordered: NS_WINDOW_ABOVE")
    && overlay.includes("NS_WINDOW_ABOVE")
    && /overlay\.show\(\)\?;[\s\S]{0,220}order_macos_overlay_above_main\(main, overlay\)\?/.test(overlay)
    && (overlay.match(/show_overlay_above_main\(/g) || []).length >= 3);
check("macOS frame can follow main beyond the visible screen edge",
  overlay.includes("fn allow_macos_overlay_outside_screen(")
    && overlay.includes("constrainFrameRect:toScreen:")
    && overlay.includes("class_addMethod")
    && overlay.includes("MACOS_UNCONSTRAINED_OVERLAY")
    && !overlay.includes("AnyObject::set_class")
    && !overlay.includes("ClassBuilder")
    && overlay.includes("allow_macos_overlay_outside_screen(&overlay)")
    && /create_overlay\(app, &main\)[\s\S]{0,500}sync_once\(&main, &overlay\)/.test(overlay));
check("macOS Retina overlay geometry scales its transparent margins",
  overlay.includes("fn geometry_scale(scale_factor: f64) -> f64")
    && overlay.includes("main.scale_factor()")
    && overlay.includes("CONTENT_OFFSET_Y as f64 * scale"));
check("macOS safe-area fit runs after the hidden main window is shown",
  rust.indexOf("let _ = dispatch_window.show()") < rust.indexOf("fit_macos_main_window(&dispatch_window)"));

for (const row of checks) console.log(`  PASS ${row.name}`);
console.log(`mac GUI verification: ${checks.length}/${checks.length} passed`);

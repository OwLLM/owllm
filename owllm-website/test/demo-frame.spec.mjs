import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(projectRoot, ...p), "utf8");

// The app draws its own window chrome and its window margin is transparent.
// Site-side containers must therefore add NO second frame around it: no
// rounded corners, no border, and nothing opaque behind the transparent
// margin — the page background must show through.
describe("app imagery has no site-side frame", () => {
  it("RealAppDemo iframe is frameless, square, and composites transparently", () => {
    const source = read("src", "components", "RealAppDemo.astro");
    const frameRule = source.match(/#demo-frame\s*\{[^}]*\}/)?.[0];
    assert.ok(frameRule, "#demo-frame rule exists");
    assert.match(frameRule, /border:\s*none/, "no site border around the app");
    assert.doesNotMatch(frameRule, /border-radius/, "no rounded corners");
    assert.doesNotMatch(frameRule, /box-shadow/, "no shadow box around the app");
    assert.match(frameRule, /background:\s*transparent/, "page background shows through");
    // Chromium gives an iframe an opaque black canvas when its color-scheme
    // differs from the embedded document (the app is color-scheme: dark).
    // Without this declaration the transparent margin renders as a black band
    // whenever the site is in light mode.
    assert.match(frameRule, /color-scheme:\s*dark/, "color-scheme matches the embedded app");
  });

  it("RealAppDemo suppresses the site's global focus outline on the iframe", () => {
    // The site applies a global `:focus-visible` accent-colored outline to
    // every focusable element. Without an override, focusing the iframe
    // (e.g. clicking into the embedded app) draws that outline around the
    // whole demo box — a second, site-colored frame on top of the app's own
    // window chrome.
    const source = read("src", "components", "RealAppDemo.astro");
    const outlineRule = source.match(/#demo-frame:focus[^{]*\{[^}]*\}/)?.[0];
    assert.ok(outlineRule, "#demo-frame:focus rule exists");
    assert.match(outlineRule, /outline:\s*none/, "no focus outline drawn around the app");
  });

  it("the app's OS-window accent edge is not drawn when embedded", () => {
    // WindowAccentEdge traces the native window's edge. Embedded in the site's
    // demo iframe there is no such window, so it painted a full-bleed 3px
    // accent rectangle outside HybridFrame's own chrome — the double frame.
    // The iframe half of the guard is load-bearing: pages in the in-app
    // browser get Tauri IPC injected, so isTauri() alone is true there.
    const shell = fs.readFileSync(
      path.resolve(projectRoot, "..", "owllm-desktop", "ui", "src", "AppShell.tsx"),
      "utf8",
    );
    const fn = shell.match(/function WindowAccentEdge\(\)\s*\{[\s\S]*?\n\}/)?.[0];
    assert.ok(fn, "WindowAccentEdge exists");
    assert.match(fn, /!isTauri\(\)/, "not drawn outside the Tauri webview");
    assert.match(fn, /window\.self !== window\.top/, "not drawn inside an iframe");
  });

  it("screenshot containers have no rounded corners or border frame", () => {
    for (const [file, selector] of [
      [["src", "pages", "index.astro"], ".demo-image"],
      [["src", "pages", "features.astro"], ".group-shot"],
    ]) {
      const rule = read(...file).match(
        new RegExp(selector.replace(".", "\\.") + "\\s*\\{[^}]*\\}"),
      )?.[0];
      assert.ok(rule, `${selector} rule exists`);
      assert.doesNotMatch(rule, /border-radius/, `${selector} has square corners`);
      assert.doesNotMatch(rule, /border:/, `${selector} has no border frame`);
    }
  });

  it("capture script crops to the app panel, not the viewport margin", () => {
    const script = read("scripts", "capture-app-shots.mjs");
    assert.match(
      script,
      /hybrid-frame-root/,
      "screenshots must target the app's content panel so the transparent window margin is not baked in as a black band",
    );
  });
});

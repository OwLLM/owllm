// Focused verification for independent GUI/text theme preferences and the
// contrast-safe foreground token derivation. Transpiles the real pure module;
// no browser, React, or Tauri runtime is required.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../..");
const require = createRequire(path.join(DESKTOP, "package.json"));
const ts = require("typescript");
const source = fs.readFileSync(path.join(HERE, "themePreferences.ts"), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-theme-"));
const modulePath = path.join(temp, "themePreferences.cjs");
fs.writeFileSync(modulePath, output);
const theme = require(modulePath);

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`✓ ${message}`);
}

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    dump: () => Object.fromEntries(values),
  };
}

const empty = makeStorage();
check(theme.readMode(empty) === "dark", "missing mode uses the dark fallback");
check(theme.readGuiColor(empty) === "indigo", "missing GUI color uses Indigo");
check(theme.readTextColor(empty) === "auto", "missing text color uses the mode-aware default");

const invalid = makeStorage({
  [theme.THEME_MODE_KEY]: "sepia",
  [theme.THEME_GUI_COLOR_KEY]: "not-a-color",
  [theme.THEME_TEXT_COLOR_KEY]: "#abcd",
});
check(theme.readMode(invalid) === "dark" && theme.readGuiColor(invalid) === "indigo" && theme.readTextColor(invalid) === "auto",
  "invalid persisted values fail safely to defaults");

const saved = makeStorage();
theme.saveGuiColor("#123456", saved);
theme.saveTextColor("#fedcba", saved);
theme.saveMode("light", saved);
check(theme.readGuiColor(saved) === "#123456" && theme.readTextColor(saved) === "#fedcba" && theme.readMode(saved) === "light",
  "GUI color, text color, and mode round-trip independently");
check(saved.dump()[theme.THEME_GUI_COLOR_KEY] !== saved.dump()[theme.THEME_TEXT_COLOR_KEY],
  "GUI and text selections use separate persistence keys");
check(theme.resolveGuiColor(theme.readGuiColor(saved)) === "#123456",
  "custom GUI colors restore exactly during startup resolution");

check(theme.resolveTextColor("auto", "dark") === "#e6e8eb" && theme.resolveTextColor("auto", "light") === "#1a1f2c",
  "automatic text fallback follows dark/light mode");
const dark = theme.buildTextThemeTokens("#101010", "dark", "#667eea");
const light = theme.buildTextThemeTokens("#f8f8f8", "light", "#667eea");
check(theme.minimumThemeContrast(dark.base, "dark", "#667eea") >= 4.5,
  "dark-mode foreground is corrected to readable contrast");
check(theme.minimumThemeContrast(light.base, "light", "#667eea") >= 4.5,
  "light-mode foreground is corrected to readable contrast");
check(dark.base !== light.base && dark.strong !== light.strong,
  "theme switching recalculates the foreground token family");
check(dark.base !== dark.muted && light.base !== light.muted,
  "semantic muted states remain visually distinct");

const shell = fs.readFileSync(path.join(HERE, "AppShell.tsx"), "utf8");
check(shell.includes('data-ui="GuiColorPalette"') && shell.includes('data-ui="TextColorPalette"'),
  "Settings exposes both clearly identified palette controls");
check(shell.includes("onPickAccent(event.target.value") && shell.includes("onPickTextColor(event.target.value"),
  "both palette selections are wired to live theme setters");
const row1At = shell.indexOf('data-ui="SettingsRow1"');
const row2At = shell.indexOf('data-ui="SettingsRow2"');
const guiAt = shell.indexOf('data-ui="GuiColorPalette"');
const textAt = shell.indexOf('data-ui="TextColorPalette"');
check(!shell.includes('data-ui="SettingsColorRow"')
  && row1At !== -1 && row1At < guiAt && guiAt < textAt && textAt < row2At,
  "palette squares render inline in the first settings row, not on a separate line");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`OK theme preferences: ${passed}/${passed} checks passed`);

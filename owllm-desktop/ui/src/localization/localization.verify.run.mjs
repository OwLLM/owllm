import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.resolve(here, relative), "utf8");
const generated = read("catalog.generated.ts");
const literal = generated.match(/export const UI_CATALOG = ([\s\S]+?) as const;/)?.[1];
if (!literal) throw new Error("Could not parse generated UI catalogue");
const catalog = vm.runInNewContext(`(${literal})`);
const coverageLiteral = generated.match(/export const UI_CATALOG_COVERAGE = ([\s\S]+?) as const;/)?.[1];
if (!coverageLiteral) throw new Error("Could not parse generated catalogue coverage");
const coverage = vm.runInNewContext(`(${coverageLiteral})`);

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`✓ ${message}`);
}

check(catalog.length >= 2700, `catalogue covers the audited UI surface (${catalog.length} strings)`);
check(catalog.every((row) => row.length === 6), "every catalogue row has English plus five translations");
check(Object.values(coverage).every((count) => count === catalog.length), "every audited source string has all five locale entries");
check(catalog.every((row) => {
  const placeholders = row[0].match(/\{\d+\}/g) ?? [];
  return !placeholders.includes("{0}") || row.slice(1).every((translation) => translation.includes("{0}"));
}), "each dynamic translation preserves its primary placeholder");

const localization = read("index.tsx");
const main = read("../main.tsx");
const shell = read("../AppShell.tsx");
const styles = read("../styles.css");
const browserChrome = read("../../public/browser-chrome.html");
check(main.includes("<LocalizationProvider>"), "the provider wraps the full application");
check(shell.includes("useLocalization()"), "Settings switches the provider locale live");
check(localization.includes("localStorage.setItem(APP_LANGUAGE_KEY, language)"), "the selected locale is persisted");
check(localization.includes('language === "ar" ? "rtl" : "ltr"') && styles.includes('html[dir="rtl"]'), "Arabic enables RTL application layout");
check(localization.includes('const LOCALIZED_ATTRIBUTES = ["title", "aria-label", "placeholder", "alt"]'), "tooltips and accessibility/input labels are localized");
check(localization.includes("MutationObserver") && localization.includes("window.confirm ="), "lazy UI/status nodes and native dialogs are localized");
check(localization.includes("return source;") && localization.includes("guaranteed fallback"), "missing translations fall back to canonical English");
check(browserChrome.includes("CHROME_COPY") && browserChrome.includes('owllm:language'), "the separate browser chrome follows the application locale");

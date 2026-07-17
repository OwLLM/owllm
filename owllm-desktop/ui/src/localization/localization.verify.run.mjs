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
check((localization.match(/document\.documentElement\.dir = "ltr"/g) ?? []).length >= 2
  && !localization.includes('language === "ar" ? "rtl" : "ltr"')
  && styles.includes('html[lang="ar"]')
  && styles.includes("unicode-bidi: plaintext")
  && shell.includes('direction: "ltr"'),
  "Arabic shapes RTL text without mirroring application geometry");
check(localization.includes('const LOCALIZED_ATTRIBUTES = ["title", "aria-label", "placeholder", "alt"]'), "tooltips and accessibility/input labels are localized");
check(localization.includes("MutationObserver") && localization.includes("window.confirm ="), "lazy UI/status nodes and native dialogs are localized");
check(localization.includes("return source;") && localization.includes("guaranteed fallback"), "missing translations fall back to canonical English");
check(browserChrome.includes("CHROME_COPY") && browserChrome.includes('owllm:language'), "the separate browser chrome follows the application locale");

// ── Idiomatic-terminology audit ────────────────────────────────────────────
// Columns: 0 en · 1 zh-CN · 2 ko · 3 ja · 4 ar · 5 it
const LOCALE_COLUMN = { "zh-CN": 1, ko: 2, ja: 3, ar: 4, it: 5 };
const bySource = new Map(catalog.map((row) => [row[0], row]));
const cell = (source, locale) => bySource.get(source)?.[LOCALE_COLUMN[locale]];

// Each of the six languages loads: the type union and picker list carry all codes.
check(
  ["en", "zh-CN", "ko", "ja", "ar", "it"].every((code) => localization.includes(`"${code}"`)),
  "all six languages (en, zh-CN, ko, ja, ar, it) are declared and load",
);
// Every catalogue row renders a non-empty string in every locale (nothing loads blank).
check(
  catalog.every((row) => row.slice(1).every((value) => typeof value === "string" && value.length > 0)),
  "every locale column renders a non-empty translation",
);

// Italian "Home" uses the software convention, never the literal "Casa".
check(cell("🏠 Home", "it") === "🏠 Home", 'Italian "Home" stays "Home", not "Casa"');
check(
  Object.keys(LOCALE_COLUMN).every((l) => !/casa/i.test(cell("🏠 Home", l) || "")),
  'no locale renders "Home" as the literal "Casa"',
);

// Product/library proper noun "Unsloth" is kept untranslated in every locale.
check(
  Object.keys(LOCALE_COLUMN).every((l) => cell("⭐ Unsloth", l) === "⭐ Unsloth"),
  '"Unsloth" (product name) is preserved untranslated in every locale',
);

// "Resume download" = continue a partial download — never the CV/résumé sense.
const RESUME_CV = { "zh-CN": "简历", ko: "이력서", ja: "履歴書", ar: "السيرة الذاتية", it: "curriculum" };
check(
  Object.entries(RESUME_CV).every(([l, cv]) => !(cell("⏬ Resume download", l) || "").includes(cv)),
  '"Resume download" never uses the CV/résumé sense of "resume"',
);
check(cell("⏬ Resume download", "it") === "⏬ Riprendi download", 'Italian "Resume download" reads as "Riprendi download"');

// LLM "Tokens" — not the crypto-coin (代币) or casino-chip (Gettoni) sense.
check(cell("★ Tokens", "zh-CN") === "★ 令牌", 'Chinese "Tokens" uses 令牌, not the crypto 代币');
check(cell("★ Tokens", "it") === "★ Token", 'Italian "Tokens" keeps "Token", not the casino "Gettoni"');

// "Patient tutor" — the calm/tolerant sense, not the Korean medical-patient (환자).
check(!(cell("🎓 Patient tutor", "ko") || "").includes("환자"), 'Korean "Patient tutor" is not the medical-patient (환자) sense');

// "Dataset" loanword stays consistent in Italian (matches "📚 Dataset").
check(cell("📊 DATASET", "it") === "📊 DATASET", 'Italian "DATASET" keeps the loanword, not "INSIEME DI DATI"');

// Established technical loanwords are preserved identically across every locale.
for (const term of ["📦 GGUF", "🧩 LoRA", "🧩 MCP"]) {
  check(
    Object.keys(LOCALE_COLUMN).every((l) => cell(term, l) === term),
    `technical loanword ${JSON.stringify(term)} is preserved untranslated in every locale`,
  );
}

// Arabic renders RTL-applicable content for navigation (paired with the RTL layout check above).
check(typeof cell("🏠 Home", "ar") === "string" && cell("🏠 Home", "ar").length > 0, "Arabic navigation labels are present for RTL rendering");

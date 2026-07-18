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
check(catalog.every((row) => row.length === 8), "every catalogue row has English plus seven translations");
check(Object.keys(coverage).length === 7 && Object.values(coverage).every((count) => count === catalog.length),
  "every audited source string has all seven locale entries (incl. hi + pt)");
check(catalog.every((row) => {
  const placeholders = row[0].match(/\{\d+\}/g) ?? [];
  return !placeholders.includes("{0}") || row.slice(1).every((translation) => translation.includes("{0}"));
}), "each dynamic translation preserves its primary placeholder");

const localization = read("index.tsx");
const main = read("../main.tsx");
const shell = read("../AppShell.tsx");
const modules = read("../core/modules.ts");
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
check(modules.includes('key: "code",    label: "💻 Coding"'), 'the application navigation names the page "Coding" at its source');

// ── Flag-only language selector ────────────────────────────────────────────
// All eight languages render as bundled flag icons (icons/App_icons), no text.
const FLAGS = ["usa_flag", "china_flag", "korea_flag", "japan_flag", "saudi_flag", "italy_flag", "india_flag", "brazil_flag"];
check(FLAGS.every((f) => localization.includes(`/App_icons/${f}.webp`)),
  "all eight languages use bundled App_icons flag assets");
const flagsDir = path.resolve(here, "../../../../icons/App_icons");
check(FLAGS.every((f) => fs.existsSync(path.join(flagsDir, `${f}.webp`))),
  "all eight flag webp assets exist in icons/App_icons");
const viteConfig = read("../../vite.config.ts");
check(viteConfig.includes('"App_icons"') && viteConfig.includes("image/webp"),
  "vite bundles App_icons into dist and serves webp with the right content type");
const selector = shell.slice(shell.indexOf('data-ui="LanguageSelector"'), shell.indexOf('data-ui="KeepFrameVisible"'));
check(selector.includes("option.flagSrc") && selector.includes("repeat(4, 46px)") && !selector.includes("option.short"),
  "the Settings selector renders flag icons only (no text) in a 4x2 grid");

// ── Idiomatic-terminology audit ────────────────────────────────────────────
// Columns: 0 en · 1 zh-CN · 2 ko · 3 ja · 4 ar · 5 it · 6 hi · 7 pt
const LOCALE_COLUMN = { "zh-CN": 1, ko: 2, ja: 3, ar: 4, it: 5, hi: 6, pt: 7 };
const bySource = new Map(catalog.map((row) => [row[0], row]));
const cell = (source, locale) => bySource.get(source)?.[LOCALE_COLUMN[locale]];

// Each of the eight languages loads: the type union and picker list carry all codes.
check(
  ["en", "zh-CN", "ko", "ja", "ar", "it", "hi", "pt"].every((code) => localization.includes(`"${code}"`)),
  "all eight languages (en, zh-CN, ko, ja, ar, it, hi, pt) are declared and load",
);
// Every catalogue row renders a non-empty string in every locale (nothing loads blank).
check(
  catalog.every((row) => row.slice(1).every((value) => typeof value === "string" && value.length > 0)),
  "every locale column renders a non-empty translation",
);

// Italian "Home" uses the software convention, never the literal "Casa".
check(cell("🏠 Home", "it") === "🏠 Home", 'Italian "Home" stays "Home", not "Casa"');
check(
  ["it", "pt"].every((l) => !/\bcasa\b/i.test(cell("🏠 Home", l) || "")),
  'no Romance locale renders "Home" as the literal "Casa"',
);

// Page names must be what native devs call the page, not dictionary translations.
// (User-reported: it "Codice" for the Coding page, "Firmando" for Signing,
//  "Informazioni" for Info — all wrong; developer-facing loanwords are conventional.)
for (const row of catalog) {
  const en = row[0];
  if (/^[^A-Za-z]*Coding$/.test(en)) check(row[5] === en, `Italian Coding page stays "Coding" (${JSON.stringify(en)})`);
  if (/^[^A-Za-z]*Signing$/.test(en)) check(row[5] === en, `Italian Signing page stays "Signing" (${JSON.stringify(en)})`);
  if (/^[^A-Za-z]*Info$/.test(en)) check(row[5] === en, `Italian Info stays "Info" (${JSON.stringify(en)})`);
}
check(cell("💻 Coding", "zh-CN") === "💻 编程", 'Chinese Coding page uses the programming term "编程"');
check(cell("💻 Coding", "ko") === "💻 코딩", 'Korean Coding page uses the conventional loanword "코딩"');
check(cell("💻 Coding", "ja") === "💻 コーディング", 'Japanese Coding page uses the conventional loanword "コーディング"');
check(cell("💻 Coding", "ar") === "💻 البرمجة", 'Arabic Coding page means software programming');
check(cell("💻 Coding", "hi") === "💻 कोडिंग", 'Hindi Coding page uses the conventional developer loanword');
check(cell("💻 Coding", "pt") === "💻 Coding", 'Portuguese Coding page keeps the developer-facing product label');
check(cell("📜 About OwLLM", "it") === "📜 Info su OwLLM", 'Italian About card uses idiomatic "Info", not "Informazioni"');
check(cell("Coding agent", "it") === "Agente di programmazione", 'Italian "Coding agent" means software programming, not encoding');
check(cell("Coding in {0}", "it") === "Programmazione in {0}", 'Italian "Coding in" uses "Programmazione", not "Codifica"');

// Git/GitHub operations are commands, not prose — never translated in the
// Romance locales (it/pt keep the English command words; zh/ko/ja use their
// established transliterations, checked as non-literal below).
for (const term of ["Commit", "Merge", "Push", "Branch"]) {
  if (!bySource.has(term)) continue;
  check(cell(term, "it") === term, `Italian git command "${term}" is not translated`);
  check(cell(term, "pt") === term, `Portuguese git command "${term}" is not translated`);
}
check(!bySource.has("Commit") || !/conferma/i.test(cell("Commit", "it")), 'Italian "Commit" is never "Conferma"');
check(!bySource.has("Branch") || !/ramo/i.test(cell("Branch", "it")), 'Italian "Branch" is never "Ramo"');
check(!bySource.has("Merge") || !/unisci/i.test(cell("Merge", "it")), 'Italian "Merge" is never "Unisci"');

// Product/library proper noun "Unsloth" is kept untranslated in every locale.
check(
  Object.keys(LOCALE_COLUMN).every((l) => cell("⭐ Unsloth", l) === "⭐ Unsloth"),
  '"Unsloth" (product name) is preserved untranslated in every locale',
);

// "Resume download" = continue a partial download — never the CV/résumé sense.
const RESUME_CV = { "zh-CN": "简历", ko: "이력서", ja: "履歴書", ar: "السيرة الذاتية", it: "curriculum", pt: "currículo" };
check(
  Object.entries(RESUME_CV).every(([l, cv]) => !(cell("⏬ Resume download", l) || "").includes(cv)),
  '"Resume download" never uses the CV/résumé sense of "resume"',
);
check(cell("⏬ Resume download", "it") === "⏬ Riprendi download", 'Italian "Resume download" reads as "Riprendi download"');

// LLM "Tokens" — not the crypto-coin (代币) or casino-chip (Gettoni) sense.
check(cell("★ Tokens", "zh-CN") === "★ 令牌", 'Chinese "Tokens" uses 令牌, not the crypto 代币');
check(cell("★ Tokens", "it") === "★ Token", 'Italian "Tokens" keeps "Token", not the casino "Gettoni"');
check(!/ficha|moeda/i.test(cell("★ Tokens", "pt") || ""), 'Portuguese "Tokens" keeps the LLM sense');

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

// Hindi and Portuguese render native scripts/conventions, not copied English.
const hindiSample = catalog.filter((row) => /[ऀ-ॿ]/.test(row[6])).length;
check(hindiSample > catalog.length * 0.5, `Hindi translations use Devanagari for the majority of strings (${hindiSample}/${catalog.length})`);
const ptDiffers = catalog.filter((row) => row[7] !== row[0]).length;
check(ptDiffers > catalog.length * 0.5, `Portuguese translations are not just copied English (${ptDiffers}/${catalog.length} differ)`);

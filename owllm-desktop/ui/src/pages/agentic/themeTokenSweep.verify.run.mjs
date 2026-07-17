// Theme-token sweep verification.
//
// Two layers:
//   A. Behaviour — drives the REAL themePreferences module (transpiled, no
//      browser needed) through adversarial theme switches (black background
//      with contrasting text, black-on-black, light-mode inverse) and checks
//      the derived foreground family stays readable and mode-responsive.
//   B. Source lint — re-scans the UI sources for the bug class this sweep
//      removed: a hardcoded NEUTRAL text colour on a token-driven background
//      (breaks the moment the user changes GUI/text colour), or hardcoded
//      dark text on the var(--accent) fill instead of var(--accent-fg).
//      Named surfaces (Notebook title row, composer send button) are pinned
//      explicitly so they cannot silently regress.
//
// All source reads normalise CRLF -> LF (Windows checkouts flip line
// endings; matching content, not EOL, is the recurring repo lesson).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../..");           // ui/src
const DESKTOP = path.resolve(HERE, "../../../..");  // owllm-desktop
const readLF = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) { console.error(`  FAIL ${message}`); process.exit(1); }
  passed += 1;
  console.log(`✓ ${message}`);
}

// ---- A. Behaviour: real token derivation under adversarial themes --------
const require = createRequire(path.join(DESKTOP, "package.json"));
const ts = require("typescript");
const transpiled = ts.transpileModule(readLF(path.join(SRC, "themePreferences.ts")), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-tokens-"));
fs.writeFileSync(path.join(temp, "themePreferences.cjs"), transpiled);
const theme = require(path.join(temp, "themePreferences.cjs"));

// Black background (GUI colour #000000) with a contrasting white text pick.
const blackBg = theme.buildTextThemeTokens("#ffffff", "dark", "#000000");
check(theme.minimumThemeContrast(blackBg.base, "dark", "#000000") >= 4.5,
  "black background + white text: base foreground stays readable");
check(theme.minimumThemeContrast(blackBg.muted, "dark", "#000000") >= 3.0,
  "black background + white text: muted state stays readable");
check(blackBg.base !== blackBg.muted && blackBg.muted !== blackBg.subtle,
  "black background: normal/muted/subtle states stay distinguishable");

// Adversarial: black text picked ON a black background — must be corrected.
const blackOnBlack = theme.buildTextThemeTokens("#000000", "dark", "#000000");
check(theme.minimumThemeContrast(blackOnBlack.base, "dark", "#000000") >= 4.5,
  "black-on-black is contrast-corrected to a readable foreground");

// Light-mode inverse: near-white text on the white-ish light theme.
const whiteOnLight = theme.buildTextThemeTokens("#ffffff", "light", "#f0f0f0");
check(theme.minimumThemeContrast(whiteOnLight.base, "light", "#f0f0f0") >= 4.5,
  "white-on-light is contrast-corrected to a readable foreground");

// Switching mode with the same picks recomputes the family.
const darkFam = theme.buildTextThemeTokens("#e6e8eb", "dark", "#5cf0ff");
const lightFam = theme.buildTextThemeTokens("#e6e8eb", "light", "#5cf0ff");
check(darkFam.base !== lightFam.base,
  "theme switching recomputes the foreground token family");

// ---- B. Source lint: the hardcoded-colour bug class stays dead -----------
// Same context rules as the sweep codemod: a neutral (low-saturation) hex in
// a `color:` position is a defect UNLESS its enclosing object also pins the
// fill (hex/rgb/gradient or a fixed --ok/--warn/--error/--bg-header fill) —
// fixed fg/bg pairs stay legible in every theme by construction.
const SKIP = /catalog\.generated|\.verify\.run\.|AppShell\.tsx|localization[\/\\]|themePreferences\.ts|theme[\/\\]styles\.ts/;
const HARD_BG = /background(Color)?\s*:[^;,}\n]*(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d|linear-gradient|conic-gradient|radial-gradient)/;
const FIXED_FILL = /background(Color)?\s*:[^;,}\n]*var\(--(ok|warn|error|bg-header)\b/;
const ACCENT_BG = /background(Color)?\s*:[^;,}\n]*var\(--accent\)/;
// `background: someVariable` — the fill is a palette constant decided
// elsewhere (labelBg / modeColor / glow …); the paired text colour is fixed
// by design and the lint cannot see through the identifier.
const VAR_BG = /background(Color)?\s*:\s*[a-zA-Z_$][\w$.]*\s*[,}\n]/;
const BRAND_DATA = /glyph\s*:/;

function rgbOf(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function contextOf(src, idx) {
  let start = idx, depth = 0;
  for (let i = idx, seen = 0; i >= 0 && seen < 900; i--, seen++) {
    const c = src[i];
    if (c === "}") depth++;
    else if (c === "{") { if (depth === 0) { start = i; break; } depth--; }
    start = i;
  }
  let end = idx; depth = 0;
  for (let i = idx, seen = 0; i < src.length && seen < 900; i++, seen++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") { if (depth === 0) { end = i; break; } depth--; }
    end = i;
  }
  return src.slice(start, end + 1);
}

const offenders = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!/\.tsx?$/.test(f) || SKIP.test(p)) continue;
    const src = readLF(p);
    const re = /color:\s*["'](#[0-9a-fA-F]{3,8})["']/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const hex = m[1];
      if (hex.length > 7) continue;
      const [r, g, b] = rgbOf(hex);
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (sat >= 40) continue; // status/brand hues are out of scope
      const ctx = contextOf(src, m.index);
      if (BRAND_DATA.test(ctx)) continue;
      if (ACCENT_BG.test(ctx) && !HARD_BG.test(ctx)) {
        offenders.push(`${path.relative(SRC, p)}: ${hex} on var(--accent) fill (use var(--accent-fg))`);
      } else if (!FIXED_FILL.test(ctx) && !HARD_BG.test(ctx) && !VAR_BG.test(ctx)) {
        offenders.push(`${path.relative(SRC, p)}: ${hex} (use a var(--fg*) token)`);
      }
    }
  }
})(SRC);
if (offenders.length) offenders.forEach(o => console.error(`  offender: ${o}`));
check(offenders.length === 0,
  `no unpaired hardcoded neutral text colours remain in the UI sources (${offenders.length} offenders)`);

// ---- C. Named surfaces the task pinned explicitly ------------------------
const notebook = readLF(path.join(SRC, "pages/agentic/RunNotebook.tsx"));
check(notebook.includes('color: "var(--fg-strong)" }}>Notebook'),
  "Notebook page title consumes the strong foreground token");
check(!/#ffd97a|#7ff0c5|#9ad9ff|#ff8c8c|#ffb4b4|#eafff5|#2f7d5b/i.test(notebook),
  "Notebook carries no legacy hardcoded palette colours at all");
check(notebook.includes('"var(--ok)"') && notebook.includes('"var(--warn)"') && notebook.includes('"var(--error)"'),
  "Notebook status chips consume the semantic ok/warn/error tokens");

const agents = readLF(path.join(SRC, "pages/agentic/AgentsPage.tsx"));
const sendBtnAt = agents.indexOf('"Stop the in-flight dispatch"');
check(sendBtnAt !== -1, "AgentsPage send button located");
const sendBtn = agents.slice(sendBtnAt, sendBtnAt + 1200);
check(sendBtn.includes('draft.trim() ? "var(--accent)"') && sendBtn.includes('"var(--accent-fg)"'),
  "send button ready state consumes accent + accent-fg tokens");
check(!/#ffd97a|#3cf26b|#ff8c4a|#1a1404|#0a1505|#7d6f4b/i.test(sendBtn),
  "send button carries no hardcoded amber/green/orange state colours");

const codePage = readLF(path.join(SRC, "pages/agentic/CodePage.tsx"));
check(!codePage.includes('background: "var(--accent)", color: "#06080d"'),
  "CodePage accent-filled buttons no longer hardcode dark text");

const css = readLF(path.join(SRC, "styles.css"));
check(css.includes("--ok-rgb:") && css.includes("--warn-rgb:") && css.includes("--error-rgb:"),
  "styles.css publishes rgb triplets for translucent status tints");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`OK theme token sweep: all ${passed} checks passed`);

// Focused verification for the chat text-size preference and its Settings
// control. Transpiles the real pure module; no browser/React/Tauri runtime.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../..");
const require = createRequire(path.join(DESKTOP, "package.json"));
const ts = require("typescript");
const source = fs.readFileSync(path.join(HERE, "chatFontPreferences.ts"), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-chatfont-"));
const modulePath = path.join(temp, "chatFontPreferences.cjs");
fs.writeFileSync(modulePath, output);
const pref = require(modulePath);

// Read source for content matching independent of the checkout's line endings
// (Windows core.autocrlf checks LF-committed files out as CRLF).
const readSource = (rel) => fs.readFileSync(path.join(HERE, rel), "utf8").replace(/\r\n/g, "\n");

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

// Defaults + bounds. Range now runs -1 (one step smaller) up to +6.
check(pref.CHAT_FONT_MIN_STEP === -1 && pref.CHAT_FONT_MAX_STEP === 6 && pref.CHAT_FONT_BASE_PX === 13,
  "range is -1..+6 around the current 13px size, in +1 steps");
check(pref.readChatFontStep(makeStorage()) === 0 && pref.CHAT_FONT_DEFAULT_STEP === 0,
  "missing preference falls back to the default (0 = shipped) size");
check(pref.readChatFontStep(makeStorage({ [pref.CHAT_FONT_STEP_KEY]: "not-a-number" })) === 0,
  "corrupt preference fails safely to the default size");

// Clamp both ends and round fractional values.
check(pref.clampChatFontStep(-3) === -1 && pref.clampChatFontStep(9) === 6 && pref.clampChatFontStep(2.4) === 2,
  "steps clamp to [-1,6] and snap to whole increments");

// px mapping: 12 (at -1) .. 19 (at +6).
check(pref.chatFontSizePx(-1) === 12 && pref.chatFontSizePx(0) === 13 && pref.chatFontSizePx(6) === 19 && pref.chatFontSizePx(99) === 19,
  "each step maps to +1px (12..19), never past the +6 ceiling or -1 floor");

// Round-trip + persisted restore.
const saved = makeStorage();
pref.saveChatFontStep(3, saved);
check(saved.dump()[pref.CHAT_FONT_STEP_KEY] === "3" && pref.readChatFontStep(saved) === 3,
  "the selected step persists and restores at startup");
pref.saveChatFontStep(50, saved);
check(pref.readChatFontStep(saved) === 6, "an out-of-range saved value restores clamped to the ceiling");
pref.saveChatFontStep(-9, saved);
check(pref.readChatFontStep(saved) === -1, "an under-range saved value restores clamped to the floor");

// Chat renderers read the CSS variable (with a 13px fallback) — every chat
// surface reuses these shared bodies.
const bubble = readSource("components/ChatBubble.tsx");
check((bubble.match(/var\(--chat-font-size, 13px\)/g) || []).length >= 2,
  "ChatBubble applies --chat-font-size to both the markdown body and the streaming/user span");
const agents = readSource("pages/agentic/AgentsPage.tsx");
check(agents.includes("var(--chat-font-size, 13px)"),
  "AgentsPage markdown body applies --chat-font-size");

// The setting must ALSO scale the notebook step text and the user input boxes,
// not only chat message bubbles (user spec 2026-07-17).
const notebook = readSource("pages/agentic/RunNotebook.tsx");
check((notebook.match(/var\(--chat-font-size, 13px\)/g) || []).length >= 2,
  "RunNotebook step text (active + archived) applies --chat-font-size");
check((agents.match(/var\(--chat-font-size, 13px\)/g) || []).length >= 2,
  "AgentsPage user composer input applies --chat-font-size");
const codePage = readSource("pages/agentic/CodePage.tsx");
check((codePage.match(/fontSize: "var\(--chat-font-size, 13px\)"|fontSize:"var\(--chat-font-size, 13px\)"/g) || []).length >= 3,
  "CodePage user input boxes apply --chat-font-size");
const ftChat = readSource("pages/finetuning/ChatPage.tsx");
check((ftChat.match(/var\(--chat-font-size, 13px\)/g) || []).length >= 2,
  "fine-tuning ChatPage composers apply --chat-font-size");

// Icons + Settings control.
const icons = readSource("components/ActionIcon.tsx");
check(icons.includes('"text-larger"') && icons.includes('"text-smaller"'),
  "ActionIcon ships CAD-style text-larger / text-smaller glyphs");

const shell = readSource("AppShell.tsx");
const row2At = shell.indexOf('data-ui="SettingsRow2"');
const row3At = shell.indexOf('data-ui="SettingsRow3"');
const chatSizeAt = shell.indexOf("Chat text size");
check(row3At !== -1 && row2At !== -1 && row2At < row3At && chatSizeAt > row3At,
  "the chat text size control renders on the third row, after the languages row");
check(shell.includes("Increase chat text size") && shell.includes("Decrease chat text size"),
  "both size-up and size-down controls carry accessible labels");
check(shell.includes('"text-larger"') && shell.includes('"text-smaller"') && shell.includes("<ActionIcon name={name}"),
  "the two buttons use the shared CAD-style icons");
check(shell.includes("setProperty(\"--chat-font-size\"") && shell.includes("saveChatFontStep(chatFontStep)"),
  "the step drives the --chat-font-size variable and persists");
check(shell.includes("onChatFontStep={setChatFontStep}"),
  "the header control is wired to the persisted step state");

// Localization coverage for the new labels (all eight columns present).
const actions = readSource("localization/catalog.actions.ts");
for (const label of ["Chat text size", "Increase chat text size", "Decrease chat text size"]) {
  const row = actions.split("\n").find(line => line.includes(`["${label}"`));
  check(Boolean(row) && (row.match(/"/g) || []).length >= 16,
    `"${label}" has all eight localized columns`);
}

fs.rmSync(temp, { recursive: true, force: true });
console.log(`OK chat font size: ${passed}/${passed} checks passed`);

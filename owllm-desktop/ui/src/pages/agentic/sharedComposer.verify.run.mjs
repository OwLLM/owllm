// One shared chat composer — the same rule ChatBubble has for messages and
// LogBox has for logs: a SECOND hand-rolled composer IS the bug.
//
// Fails on the pre-unification tree, where each of the four chat surfaces
// hand-rolled its own textarea + Send/Stop + attachment picker and every page
// had a different feature set (only the Agents dock had a mic, only the Code
// composers had a model picker or Terminal, only fine-tuning had modes and
// slash commands). Every capability audited on the old composers is asserted
// present on the shared one below, so the union cannot silently shrink.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ui = resolve(here, "../..");
const read = (p) => readFileSync(resolve(ui, p), "utf8");

const composer = read("components/Composer.tsx");
const css = read("styles.css");
const codePage = read("pages/agentic/CodePage.tsx");
const agentsPage = read("pages/agentic/AgentsPage.tsx");
const chatPage = read("pages/finetuning/ChatPage.tsx");

let failures = 0;
const check = (label, ok) => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ ${label}`); }
};

console.log("\nShared chat composer:\n");

// ── the component exists and is the container design ──────────────────
check("the shared composer component exists", composer.includes("export default function Composer"));
check("it is a container, not a bare row", css.includes(".owc {") && css.includes("border-radius: 16px"));
check("the container lights up on focus like the launchpad composer", css.includes(".owc:focus-within"));
check("the model picker sits in the header, top-right of the input",
  composer.includes("owc__header") && composer.includes("{modelPicker}")
  && composer.indexOf("owc__header") < composer.indexOf("owc__input"));

// ── every capability the four old composers had, in one place ─────────
check("textarea with Enter-to-send and Shift+Enter newline",
  composer.includes("<textarea") && composer.includes('e.key === "Enter" && !e.shiftKey'));
check("autosize with an explicit max height", composer.includes("el.scrollHeight") && composer.includes("maxHeight"));
check("Send morphs to Stop in one fixed slot",
  composer.includes("owc__send--stop") && composer.includes("busy && onStop ?"));
check("attachment picker, tray and per-item remove",
  composer.includes('type="file"') && composer.includes("owc__chip-x") && composer.includes("onRemoveAttachment"));
check("paste AND drag-drop both attach files",
  composer.includes("onPaste=") && composer.includes("onDrop=") && composer.includes("onDragOver="));
check("mic dictation is shared, not per-page", composer.includes("export function useDictation") && composer.includes("owc__mic"));
check("dictation degrades honestly where the WebView has no SpeechRecognition",
  composer.includes("Mic dictation unavailable in this WebView"));
check("slash-command palette drops up above the container",
  composer.includes("owc__palette") && css.includes("bottom: calc(100% + 6px)"));
check("context mentions render as chips", composer.includes("owc__mention") && composer.includes("mentions"));
check("mode segment and capability toggles live in the action bar",
  composer.includes("owc__modes") && composer.includes("owc__toggle") && composer.includes('aria-pressed={t.on}'));
check("terminal / header extras have a slot", composer.includes("headerExtra"));
check("errors and notices surface instead of failing silently",
  composer.includes("owc__notice") && composer.includes('role={notice.kind === "error" ? "alert" : undefined}'));
check("the counter reports draft length only — no invented token estimate",
  composer.includes("{value.length}") && !composer.includes("tokenEstimate"));
check("chat font zoom still drives the textarea", css.includes("var(--chat-font-size, 13px)"));

// ── all four surfaces render it, and none keeps a private one ─────────
const surfaces = [
  ["Code agent 1", codePage, 'dataUi="CodePrimaryComposer"'],
  ["Code agent 2", codePage, 'dataUi="CodeSecondaryComposer"'],
  ["Code just-chat", codePage, 'dataUi="CodeJustChatComposer"'],
  ["Agents dock", agentsPage, 'dataUi="UserInput"'],
  ["fine-tuning chat", chatPage, 'dataUi="FinetuneChatComposer"'],
];
for (const [name, src, marker] of surfaces) {
  check(`${name} renders the shared composer`, src.includes("<Composer") && src.includes(marker));
}
for (const [name, src] of [["CodePage", codePage], ["AgentsPage", agentsPage], ["ChatPage", chatPage]]) {
  check(`${name} imports it from components/Composer`, src.includes('from "../../components/Composer"'));
}
// The old per-page composer scaffolding is gone, not merely bypassed. (These
// pages still hold non-composer textareas — agent prompts, notebook cells,
// team descriptions — so the check names the retired symbols, not "<textarea".)
check("CodePage's private attachment tray/picker is gone",
  !codePage.includes("renderAttachmentTray") && !codePage.includes("renderAttachmentPicker")
  && !codePage.includes("onChatPaste"));
check("the Agents dock's private mic and paste handler are gone",
  !agentsPage.includes("const toggleMic") && !agentsPage.includes("onDockPaste")
  && !agentsPage.includes("webkitSpeechRecognition"));
check("fine-tuning's private composer button styles and dead legacy row are gone",
  !chatPage.includes("miniComposerBtn") && !chatPage.includes("footerComposerBtn")
  && !chatPage.includes('placeholder="Type your message here..."'));

// ── capability parity: what each surface must still expose ────────────
check("every surface keeps the mic", (codePage.match(/^\s+mic$/gm) ?? []).length >= 3
  && /^\s+mic$/m.test(agentsPage) && /^\s+mic$/m.test(chatPage));
check("both Code agents keep their own model picker and Terminal",
  codePage.includes('data-ui="CodePrimaryComposerModelPicker"')
  && codePage.includes('data-ui="CodeSecondaryComposerModelPicker"')
  && codePage.includes('headerExtra={renderTerminalButton("primary")}')
  && codePage.includes('headerExtra={renderTerminalButton("secondary")}'));
check("Code agent 1 keeps its Plan / Auto / Chat modes",
  codePage.includes('mode={agentMode}') && codePage.includes('{ key: "plan"') && codePage.includes('{ key: "chat"'));
check("the Agents dock keeps slash commands, Auto mode and the cold-load button",
  agentsPage.includes("slashCommands={slashCommands.map") && agentsPage.includes('key: "auto"')
  && agentsPage.includes('"⚡ Load"'));
check("the Agents dock still queues mid-run steers on Enter",
  agentsPage.includes("onSend(attachments)") && agentsPage.includes("busy && (draft.trim() || attachments.length)"));
check("fine-tuning keeps ask/edit/agent, Tools, isolation badge, Clear and Save",
  chatPage.includes('{ key: "ask"') && chatPage.includes('key: "tools"')
  && chatPage.includes("isolationBadge(scratchDir, isolationRequested)")
  && chatPage.includes('title="Clear all transcripts"') && chatPage.includes('title="Save chat as JSON"'));
check("fine-tuning keeps Esc-to-stop", chatPage.includes('e.key === "Escape" && anyBusy'));

if (failures) throw new Error(`FAILED: ${failures} shared-composer check(s).`);
console.log("\nall checks passed");

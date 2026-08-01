// Guards two things about the fine-tuning chat composer that regressed into
// a "the model is slow as hell" bug report:
//
//  1. TOOLS ARE NOT ON BY DEFAULT. This surface exists to talk to / compare
//     fine-tuned models. Attaching the full local tool catalog to every
//     request makes small local models burn their entire token budget
//     deliberating about tools instead of answering. Measured against
//     supergemma4-e4b-Q4_K_M on the bundled CUDA llama-server, same prompt
//     ("What is 2 + 2?"):
//         no tools -> 2 generated tokens, content "4"
//         40 tools -> 256 generated tokens, ALL reasoning_content, content ""
//     The reasoning lands in the collapsed thinking buffer, so the user sees
//     an empty bubble and calls it "slow". Agent mode must stay opt-in.
//
//  2. ONE primary interaction button that morphs Send <-> Stop (VS Code /
//     ChatGPT pattern) and an Esc-to-stop path, so an in-flight generation
//     is always interruptible from where the send control just was.
//
// Source-level assertions with comments STRIPPED first — otherwise the
// explanatory comments above the code satisfy the greps and the guard can
// never fail (that exact mistake shipped once already).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Normalize line endings (Windows core.autocrlf) and strip comments so we
// only ever assert against real code.
const readCode = (rel) =>
  fs
    .readFileSync(path.join(HERE, rel), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`✓ ${message}`);
}

const chat = readCode("ChatPage.tsx");

// ---- 1. tools are opt-in -------------------------------------------------

const modeInit = chat.match(/useState<ChatMode>\(([^)]*)\)/);
check(Boolean(modeInit), "chatMode is initialized through useState<ChatMode>");
check(
  !/useState<ChatMode>\(\s*["']agent["']\s*\)/.test(chat),
  'chatMode does NOT hard-default to "agent" (that attaches the whole tool catalog)',
);
check(
  /persisted\.chatMode\s*\?\?\s*["']ask["']/.test(chat),
  'chatMode defaults to "ask" and prefers the persisted choice',
);

// The mode gate is what actually keeps the tools array off the request.
check(
  /toolsEnabledNow\s*=\s*chatMode\s*===\s*["']agent["']\s*&&\s*toolsEnabled/.test(chat),
  "the tools array is gated on agent mode (ask/edit send no tools)",
);
check(
  /tools:\s*openaiTools\.length\s*>\s*0\s*\?\s*openaiTools\s*:\s*undefined/.test(chat),
  "the request omits `tools` entirely when the catalog is empty",
);

// ---- 2. the choice survives a page switch --------------------------------
// Pages unmount on tab change, so an unpersisted toggle silently reverts to
// the tools-on default and the bug comes straight back.

check(
  /type Persisted = \{[\s\S]*?chatMode:\s*ChatMode;[\s\S]*?\}/.test(chat),
  "Persisted carries chatMode",
);
check(
  /type Persisted = \{[\s\S]*?toolsEnabled:\s*boolean;[\s\S]*?\}/.test(chat),
  "Persisted carries toolsEnabled",
);
check(
  /saveState\(\{[^}]*chatMode[^}]*toolsEnabled[^}]*\}\)/.test(chat),
  "saveState writes chatMode + toolsEnabled",
);
const deps = chat.match(/\}, \[count, columns, converse, maxTurns([^\]]*)\]\)/);
check(
  Boolean(deps) && /chatMode/.test(deps[1]) && /toolsEnabled/.test(deps[1]),
  "the persist effect re-runs when chatMode / toolsEnabled change",
);

// ---- 3. one morphing Send/Stop button ------------------------------------

// The single morphing slot now lives in the ONE shared composer, driven by
// this page's anyBusy; the composer's own gate asserts the slot never splits.
const sharedComposer = readCode("../../components/Composer.tsx");
check(
  /busy=\{anyBusy\}/.test(chat) && /onStop=\{stopAll\}/.test(chat)
    && /busy && onStop \?/.test(sharedComposer),
  "a single slot renders Stop-or-Send from one anyBusy ternary",
);
check(
  /onStop=\{stopAll\}/.test(chat)
    && /aria-label=\{stopTitle\}/.test(sharedComposer),
  "the busy branch is a Stop button wired to stopAll",
);
check(
  /onSend=\{sendComposer\}/.test(chat)
    && /aria-label=\{sendLabel\}/.test(sharedComposer),
  "the idle branch is a Send button wired to sendComposer",
);
// One CSS class for both branches => the control does not jump when it morphs.
const composerCss = readCode("../../styles.css");
check(
  /\.owc__send \{[^}]*min-width:/.test(composerCss)
    && /className="owc__send owc__send--stop"/.test(sharedComposer),
  "Send and Stop share a fixed minWidth so the button never shifts position",
);
check(
  /if \(e\.key === "Escape" && anyBusy\) \{ e\.preventDefault\(\); stopAll\(\); return; \}/.test(chat),
  "Esc stops an in-flight generation (VS Code parity)",
);

console.log(`OK fine-tuning chat tool defaults + send/stop control: ${passed}/${passed} checks passed`);

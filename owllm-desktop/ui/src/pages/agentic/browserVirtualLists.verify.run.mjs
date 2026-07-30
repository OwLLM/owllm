// Regression guard for modern web-app inputs and virtualized history lists.
//
// Run: node ui/src/pages/agentic/browserVirtualLists.verify.run.mjs
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..", "..");
const readLF = (relative) =>
  fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");

const browserRs = readLF("src-tauri/src/browser.rs");
const gatewayRs = readLF("src-tauri/src/mcp_gateway.rs");
const teamsRs = readLF("src-tauri/src/personal_agent_teams.rs");
const agentsRs = readLF("src-tauri/src/personal_agents.rs");
const localTools = readLF("ui/src/pages/agentic/localTools.ts");
const teamTools = readLF("ui/src/pages/agentic/personalAgentTeams.ts");
const browserRole = readLF("resources/agents/roles/browser.yaml");

let failures = 0;
function check(condition, label) {
  if (condition) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}`);
  }
}

console.log("browserVirtualLists.verify — controlled inputs + scrollable histories");

const bridgeMatch = browserRs.match(/const BRIDGE_JS: &str = r##"([\s\S]*?)"##;/);
let bridgeParses = false;
try {
  if (bridgeMatch) {
    new Function(bridgeMatch[1]);
    bridgeParses = true;
  }
} catch {}
check(bridgeParses, "the injected browser bridge is valid JavaScript");

check(
  /function setNativeTextValue\([\s\S]{0,500}HTMLTextAreaElement\.prototype[\s\S]{0,200}HTMLInputElement\.prototype/.test(browserRs),
  "fill uses native input/textarea setters so controlled frameworks observe the value",
);
check(
  /function replaceEditableText\([\s\S]{0,1200}execCommand\("insertText"[\s\S]{0,700}InputEvent/.test(browserRs),
  "contenteditable fill uses the editing engine and emits a typed-text InputEvent",
);
check(
  /case "fill":[\s\S]{0,700}replaceEditableText[\s\S]{0,300}setNativeTextValue/.test(browserRs),
  "browser_fill routes both native controls and contenteditable editors through reliable helpers",
);
check(
  /function scrollableRegion\([\s\S]{0,900}scrollHeight[\s\S]{0,300}overflowY/.test(browserRs) &&
    /function reindex\([\s\S]{0,2400}scrollableRegion/.test(browserRs),
  "snapshots index visible scrollable regions used by virtualized lists",
);
check(
  /case "scroll":[\s\S]{0,2600}scrollBy[\s\S]{0,900}snapshot\(\)/.test(browserRs),
  "browser_scroll moves a scoped region and returns a fresh snapshot",
);
check(
  localTools.includes('name: "browser_scroll"') &&
    /case "browser_scroll"[\s\S]{0,300}action: "scroll"/.test(localTools),
  "local/API agents expose and dispatch browser_scroll",
);
check(
  gatewayRs.includes('"name": "browser_scroll"') &&
    /"browser_scroll" => crate::browser::browser_cmd[\s\S]{0,500}"scroll"/.test(gatewayRs),
  "CLI/MCP agents expose and dispatch browser_scroll",
);
check(
  teamsRs.includes('"browser_scroll"') &&
    agentsRs.includes('"browser_scroll"') &&
    teamTools.includes('"browser_scroll"'),
  "personal agents and team runtimes allow the shared scroll capability",
);
check(
  browserRole.includes("browser_scroll") &&
    /search[\s\S]{0,500}scroll/i.test(browserRole) &&
    /For chat, mail, contacts,[\s\S]{0,500}browser_scroll/.test(localTools),
  "all agents are told to search first and scroll virtualized history as fallback",
);

// Controlled reproduction of the React-style value-tracker failure. A direct
// `field.value = text` invokes the framework-installed instance setter first,
// so its tracker already equals the DOM value when `input` fires and no change
// is observed. Calling the native prototype setter bypasses that tracker; the
// input event then observes the new value and reacts.
let controlledInputObserved = false;
try {
  class FakeInput extends EventTarget {
    constructor() {
      super();
      this._value = "";
      this.tagName = "INPUT";
    }
  }
  Object.defineProperty(FakeInput.prototype, "value", {
    configurable: true,
    get() { return this._value; },
    set(value) { this._value = String(value); },
  });
  globalThis.HTMLInputElement = FakeInput;
  globalThis.HTMLTextAreaElement = class FakeTextArea extends FakeInput {};
  globalThis.InputEvent = class extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.data = init.data;
      this.inputType = init.inputType;
    }
  };

  const extractFunction = (name) => {
    const start = browserRs.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing ${name}`);
    const bodyStart = browserRs.indexOf("{", start);
    let depth = 0;
    for (let i = bodyStart; i < browserRs.length; i += 1) {
      if (browserRs[i] === "{") depth += 1;
      else if (browserRs[i] === "}" && --depth === 0) return browserRs.slice(start, i + 1);
    }
    throw new Error(`unterminated ${name}`);
  };
  const install = new Function(
    `${extractFunction("fire")}\n${extractFunction("textInputEvent")}\n` +
      `${extractFunction("setNativeTextValue")}\nreturn setNativeTextValue;`,
  )();
  const field = new FakeInput();
  let tracked = field.value;
  const native = Object.getOwnPropertyDescriptor(FakeInput.prototype, "value");
  Object.defineProperty(field, "value", {
    configurable: true,
    get() { return native.get.call(this); },
    set(value) {
      tracked = String(value);
      native.set.call(this, value);
    },
  });
  field.addEventListener("input", () => {
    if (tracked !== field.value) {
      controlledInputObserved = true;
      tracked = field.value;
    }
  });
  install(field, "Giada");
} catch {}
check(controlledInputObserved,
  "controlled experiment: native setter makes a framework tracker observe browser_fill");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

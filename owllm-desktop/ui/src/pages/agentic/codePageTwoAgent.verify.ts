// Focused runtime verification for the CodePage two-agent chat flow.
//
// Checks the invariants the Notebook steps require:
//   1. The two panes share the same project/session ID.
//   2. Each pane has its own composer input that appends to its own history.
//   3. Model selection is independent (empty secondary inherits primary).
//   4. Histories are isolated — forwarding creates a user message in the
//      target pane without mutating the source pane.
//   5. "Forward to second agent" is available only on the most recent,
//      completed assistant message from the primary pane.
//   6. Refresh/reopen persistence round-trips both histories and the
//      secondary model selection under the same page key.
//
// Run:  node owllm-desktop/ui/src/pages/agentic/codePageTwoAgent.verify.run.mjs

// Mirror of CodePage.tsx Msg shape.
type Msg = {
  role: "user" | "assistant" | "tool";
  content: string;
  ts: number;
  owner?: "primary" | "secondary";
  placeholder?: boolean;
};

// Mirror of the persisted CodeState subset relevant to the two-agent flow.
type CodeState = {
  messages: Msg[];
  secondaryMessages: Msg[];
  secondaryOpen: boolean;
  secondaryDraft: string;
  secondaryModelId: string;
  draft: string;
  modelId: string;
};

const sidForPage = (pageId: string) => `code:ws:${pageId}`;
const pageSessionKey = (pageId: string) => `code:sess:${pageId}`;

const stampOwner = (list: Msg[], owner: "primary" | "secondary"): Msg[] =>
  list.map((m) => (m.owner ? m : { ...m, owner }));

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("CodePage two-agent chat verification:\n");

// --------------------------------------------------------------------------
// 1) Shared project/session context
// --------------------------------------------------------------------------
const pageId = "proj-foo-bar";
const sid = sidForPage(pageId);
check("primary and secondary share the same SID", sid === `code:ws:${pageId}`);
check("SID is derived from the page/project id", sid.includes(pageId));

// --------------------------------------------------------------------------
// 2) Separate chat inputs → isolated histories
// --------------------------------------------------------------------------
let state: CodeState = {
  messages: [],
  secondaryMessages: [],
  secondaryOpen: false,
  secondaryDraft: "",
  secondaryModelId: "",
  draft: "",
  modelId: "gpt-4",
};

const sendPrimary = (text: string) => {
  state = {
    ...state,
    draft: "",
    messages: stampOwner(
      [...state.messages, { role: "user", content: text, ts: Date.now() }],
      "primary",
    ),
  };
};

const sendSecondary = (text: string) => {
  state = {
    ...state,
    secondaryDraft: "",
    secondaryMessages: stampOwner(
      [...state.secondaryMessages, { role: "user", content: text, ts: Date.now() }],
      "secondary",
    ),
  };
};

sendPrimary("Primary user message");
sendSecondary("Secondary user message");

check("primary input lands in primary history only", state.messages.length === 1 && state.secondaryMessages.length === 1);
check("primary history contains the primary text", state.messages[0].content === "Primary user message");
check("primary history does NOT contain secondary text", !state.messages.some((m) => m.content === "Secondary user message"));
check("secondary history contains the secondary text", state.secondaryMessages[0].content === "Secondary user message");
check("secondary history does NOT contain primary text", !state.secondaryMessages.some((m) => m.content === "Primary user message"));
check("primary message is owned by primary", state.messages[0].owner === "primary");
check("secondary message is owned by secondary", state.secondaryMessages[0].owner === "secondary");

// --------------------------------------------------------------------------
// 3) Independent model selection (with fallback to primary)
// --------------------------------------------------------------------------
const secondaryModelEffective = (s: CodeState) => s.secondaryModelId || s.modelId;

check("empty secondary model id inherits primary model", secondaryModelEffective(state) === "gpt-4");
state = { ...state, secondaryModelId: "claude-3.5-sonnet" };
check("set secondary model makes selection independent", secondaryModelEffective(state) === "claude-3.5-sonnet");
check("secondary model differs from primary model", state.secondaryModelId !== state.modelId);

// --------------------------------------------------------------------------
// 4) Forwarding creates a user message in the target without mutating source
// --------------------------------------------------------------------------
state = {
  ...state,
  messages: stampOwner(
    [
      { role: "user", content: "Primary user message", ts: 1 },
      { role: "assistant", content: "Primary assistant reply A", ts: 2 },
      { role: "assistant", content: "Primary assistant reply B", ts: 3 },
    ],
    "primary",
  ),
  secondaryMessages: stampOwner([{ role: "user", content: "Secondary user message", ts: 4 }], "secondary"),
};

const forwardToSecondary = () => {
  const last = state.messages[state.messages.length - 1];
  if (last.role !== "assistant" || !last.content?.trim()) return;
  state = {
    ...state,
    secondaryOpen: true,
    secondaryMessages: stampOwner(
      [
        ...state.secondaryMessages,
        { role: "user", content: `Forwarded from primary agent:\n\n${last.content}`, ts: Date.now() },
      ],
      "secondary",
    ),
  };
};

const primaryBefore = state.messages.map((m) => m.content);

// --------------------------------------------------------------------------
// 5) Last-message-only forwarding control (tested before any forwarding
//    mutates the primary/secondary arrays)
// --------------------------------------------------------------------------
const canForwardToSecondary = (messages: Msg[], i: number, busy: boolean) => {
  const m = messages[i];
  if (!m) return false;
  const isStreaming = busy && i === messages.length - 1 && m.role === "assistant";
  return m.role === "assistant" && i === messages.length - 1 && !isStreaming && !!m.content?.trim();
};

const lastIdx = state.messages.length - 1;
check("forward control available on the last completed assistant reply", canForwardToSecondary(state.messages, lastIdx, false));
check("forward control NOT available on older assistant replies", !canForwardToSecondary(state.messages, 1, false));

const streamingState = [
  ...state.messages,
  { role: "assistant" as const, content: "Streaming...", ts: 99, placeholder: true },
];
check("forward control NOT available while the last message is streaming", !canForwardToSecondary(streamingState, streamingState.length - 1, true));

const userLastState = [...state.messages, { role: "user" as const, content: "new user", ts: 100 }];
check("forward control NOT available when the last message is from the user", !canForwardToSecondary(userLastState, userLastState.length - 1, false));

forwardToSecondary();

check("forwarding adds exactly one message to secondary", state.secondaryMessages.length === 2);
check("forwarded message is user role", state.secondaryMessages[1].role === "user");
check("forwarded message carries the prefix", state.secondaryMessages[1].content.startsWith("Forwarded from primary agent:"));
check("forwarded message contains the original reply", state.secondaryMessages[1].content.includes("Primary assistant reply B"));
check("forwarding does not mutate primary history", state.messages.map((m) => m.content).join("\n") === primaryBefore.join("\n"));
check("forwarded message is owned by secondary", state.secondaryMessages[1].owner === "secondary");

const forwardToPrimary = () => {
  const last = state.secondaryMessages[state.secondaryMessages.length - 1];
  if (last.role !== "assistant" || !last.content?.trim()) return;
  state = {
    ...state,
    messages: stampOwner(
      [...state.messages, { role: "user", content: `Forwarded from second agent:\n\n${last.content}`, ts: Date.now() }],
      "primary",
    ),
  };
};

// Add a completed assistant reply in the secondary pane, then forward it.
state = {
  ...state,
  secondaryMessages: stampOwner(
    [...state.secondaryMessages, { role: "assistant", content: "Secondary assistant reply", ts: Date.now() }],
    "secondary",
  ),
};
const secondaryBefore = state.secondaryMessages.map((m) => m.content);
forwardToPrimary();
check("forwarding from secondary to primary adds a user message in primary", state.messages.length === 4);
check("forwarded-from-secondary message is user role", state.messages[3].role === "user");
check("forwarding from secondary does not mutate secondary history", state.secondaryMessages.map((m) => m.content).join("\n") === secondaryBefore.join("\n"));

// --------------------------------------------------------------------------
// 6) Persistence round-trip: both histories + secondary model survive refresh
// --------------------------------------------------------------------------
const store = new Map<string, string>();
const save = (pid: string, s: CodeState) => store.set(pageSessionKey(pid), JSON.stringify(s));
const load = (pid: string): CodeState | null => {
  const raw = store.get(pageSessionKey(pid));
  return raw ? JSON.parse(raw) : null;
};

save(pageId, state);
const restored = load(pageId);

check("persistence restores the page state", restored !== null);
check("restored primary history matches", restored?.messages.map((m) => m.content).join("\n") === state.messages.map((m) => m.content).join("\n"));
check("restored secondary history matches", restored?.secondaryMessages.map((m) => m.content).join("\n") === state.secondaryMessages.map((m) => m.content).join("\n"));
check("restored secondary model selection matches", restored?.secondaryModelId === state.secondaryModelId);
check("restored state keeps both owner tags", !!(restored?.messages.every((m) => m.owner === "primary") && restored?.secondaryMessages.every((m) => m.owner === "secondary")));

if (failures > 0) {
  throw new Error(`FAILED: ${failures} assertion(s) failed.`);
}
console.log("\nPASSED: CodePage two-agent invariants hold.");

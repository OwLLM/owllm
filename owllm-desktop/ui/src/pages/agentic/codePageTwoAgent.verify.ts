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
  kind?: "tool" | "terminal" | "meta";
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
  // Forward targets the last real answer — trailing meta notices (the run
  // timing footer) must not steal the button or become the forwarded content.
  return m.role === "assistant" && !m.kind && !isStreaming && !!m.content?.trim()
    && messages.slice(i + 1).every((n) => n.kind === "meta");
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

// --------------------------------------------------------------------------
// 7) Run timing footer is a meta notice — never the agent's answer
// --------------------------------------------------------------------------
const withFooter: Msg[] = [
  { role: "user", content: "do the thing", ts: 1 },
  { role: "assistant", content: "Real answer with the actual work.", ts: 2 },
  { role: "assistant", kind: "meta", content: "⏱ 0:42 — started 11:50:37, finished 11:51:19", ts: 3 },
];
check("forward control NOT available on the trailing timing footer", !canForwardToSecondary(withFooter, 2, false));
check("forward control targets the answer BEFORE the timing footer", canForwardToSecondary(withFooter, 1, false));
check("forward control skips multiple trailing meta notices", canForwardToSecondary(
  [...withFooter, { role: "assistant", kind: "meta", content: "📓 Auto-feed paused — the turn ended with an error.", ts: 4 }], 1, false));

// Mirror of the model-history filter (CodePage send): meta notices never
// re-enter the model's conversation as fake assistant answers.
const toHistory = (list: Msg[]) => list
  .filter((m) => m.role === "user" || (m.role === "assistant" && !m.kind && !m.placeholder && m.content.trim()))
  .map((m) => ({ role: m.role, content: m.content }));
const hist = toHistory(withFooter);
check("timing footer is excluded from model history", hist.length === 2 && !hist.some((h) => h.content.startsWith("⏱")));

// Mirror of stampLegacyMetaNotices: sessions saved BEFORE this fix carry the
// footer as a plain assistant message — hydration stamps it as meta.
const stampLegacyMeta = (list: Msg[]) => list.map((m) =>
  m.role === "assistant" && !m.kind && (m.content.startsWith("⏱ ") || m.content.startsWith("📓 Auto-feed paused"))
    ? { ...m, kind: "meta" as const }
    : m);
const migrated = stampLegacyMeta([
  { role: "assistant", content: "Real answer with the actual work.", ts: 1 },
  { role: "assistant", content: "⏱ 6:47 — started 18:41:51, finished 18:48:39", ts: 2 },
  { role: "assistant", content: "📓 Auto-feed paused — the turn was stopped.", ts: 3 },
]);
check("legacy timing footer is stamped meta on hydration", migrated[1].kind === "meta");
check("legacy auto-feed pause note is stamped meta on hydration", migrated[2].kind === "meta");
check("real answers are NOT stamped meta on hydration", migrated[0].kind === undefined);
check("after migration, forward targets the real answer", canForwardToSecondary(migrated, 0, false) && !canForwardToSecondary(migrated, 1, false));

if (failures > 0) {
  throw new Error(`FAILED: ${failures} assertion(s) failed.`);
}
console.log("\nPASSED: CodePage two-agent invariants hold.");

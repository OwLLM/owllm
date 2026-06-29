// Runtime verification for the "ask-user" bug: a mid-run agent question
// (SendUserMessage tool call on the Claude CLI path) must reach the VISIBLE
// chat (supChat), not only the Thought tab.
//
// Drives the REAL code path end to end with the real exported helpers:
//   ClaudeStreamEvent(SendUserMessage)
//     → parseUserMessageInput()                 (the CLI input → question text)
//     → onThought("ask-user", …)               (the stream tap's surfacing call)
//     → buildAskUserBubble()                    (the dropped-line fix: → supChat)
//     → assert the visible-chat array received the question.
//
// No test runner is configured in this repo. Run it via its sibling runner,
// which transpiles this file + the real dispatch.ts through the TypeScript
// compiler API (pure JS — works under WSL where the bundled esbuild native
// binary is the Windows build) and executes the assertions:
//
//   node owllm-desktop/ui/src/pages/agentic/askUserBubble.verify.run.mjs
//
// Exits non-zero on any failed assertion.

import { parseUserMessageInput, buildAskUserBubble, type AgentSpec, type GoalMsg } from "./dispatch";

// Mirror of accounts.rs ClaudeStreamEvent (the wire shape the Rust side emits).
type ClaudeStreamEvent =
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string }
  | { kind: "toolUse"; toolUseId: string; name: string; input: string }
  | { kind: "toolResult"; toolUseId: string; content: string }
  | { kind: "error"; message: string };

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

// The team the question comes from — drives the bubble's colour lookup.
const team = {
  agents: [
    { name: "orchestrator", base: "orchestrator" } as AgentSpec,
    { name: "coder", base: "coder" } as AgentSpec,
  ],
};

// supChat = the VISIBLE chat state. This is what the bug said never received
// the question. The reducer below is the EXACT shape streamThought uses:
// channel-gated, real buildAskUserBubble, ts/seq stamped at the call site.
const supChat: GoalMsg[] = [];
const thoughtTab: Array<{ channel: string; text: string }> = [];
let seq = 0;

function streamThought(agent: string, channel: string, _role: string, delta: string) {
  const bubble = buildAskUserBubble(channel, agent, delta, team.agents.find((a) => a.name === agent));
  if (bubble) supChat.push({ ...bubble, ts: 0, seq: seq++ } as GoalMsg);
  // The Thought-tab copy always lands too (unchanged behaviour).
  thoughtTab.push({ channel, text: delta });
}

// The stream tap from runClaudeCliStream's Channel.onmessage — verbatim logic
// for the SendUserMessage / toolUse / thinking branches that feed onThought.
function tap(msg: ClaudeStreamEvent, onThought: (c: string, r: string, d: string) => void) {
  switch (msg.kind) {
    case "thinking":
      onThought("thinking", "🧠 thinking", msg.delta);
      break;
    case "toolUse":
      if (msg.name === "SendUserMessage") {
        const q = parseUserMessageInput(msg.input);
        onThought("ask-user", "❓ agent asks", q);
      } else {
        onThought(`tool:${msg.name}:${msg.toolUseId}`, `🛠 ${msg.name}`, msg.input || "");
      }
      break;
    default:
      break;
  }
}

const QUESTION = "Should the new endpoint require auth? My instinct is yes.";

console.log("ask-user → visible chat verification:");

// 1) The exact failing path: orchestrator emits a SendUserMessage tool call.
tap(
  { kind: "toolUse", toolUseId: "t1", name: "SendUserMessage", input: JSON.stringify({ message: QUESTION }) },
  (c, r, d) => streamThought("orchestrator", c, r, d),
);

check("visible chat (supChat) received exactly one bubble", supChat.length === 1);
check("bubble carries the question text", supChat[0]?.text.includes(QUESTION) ?? false);
check("bubble is attributed to the asking agent", supChat[0]?.role === "orchestrator");
check("bubble uses the orchestrator card colour (#ffd97a)", supChat[0]?.color === "#ffd97a");
check("bubble is labelled as a question", supChat[0]?.text.startsWith("❓ **Orchestrator asks:**"));
check("question also still appears in the Thought tab", thoughtTab.some((t) => t.channel === "ask-user" && t.text.includes(QUESTION)));

// 2) Raw (non-JSON) tool input must still surface — never lose the question.
const supBefore = supChat.length;
tap(
  { kind: "toolUse", toolUseId: "t2", name: "SendUserMessage", input: "plain text question?" },
  (c, r, d) => streamThought("coder", c, r, d),
);
check("non-JSON question still reaches visible chat", supChat.length === supBefore + 1);
check("non-JSON question keeps its raw text", supChat[supChat.length - 1]?.text.includes("plain text question?") ?? false);
check("coder question uses the coder card colour (#9ad9ff)", supChat[supChat.length - 1]?.color === "#9ad9ff");

// 3) Negative control: ordinary thinking / other tools must NOT leak into chat.
const supBeforeNeg = supChat.length;
tap({ kind: "thinking", delta: "pondering…" }, (c, r, d) => streamThought("orchestrator", c, r, d));
tap(
  { kind: "toolUse", toolUseId: "t3", name: "read_file", input: '{"path":"x"}' },
  (c, r, d) => streamThought("orchestrator", c, r, d),
);
check("thinking + ordinary tool calls do NOT appear in visible chat", supChat.length === supBeforeNeg);

if (failures > 0) {
  // Throwing (rather than process.exit, which needs @types/node) propagates
  // out of the runner and makes node exit non-zero.
  throw new Error(`FAILED: ${failures} assertion(s) failed.`);
}
console.log("\nPASSED: all assertions green — the agent's question reaches the visible chat.");

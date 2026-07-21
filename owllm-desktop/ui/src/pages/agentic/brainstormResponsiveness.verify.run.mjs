#!/usr/bin/env node
// Regression guard: active agent/code/model streams must not monopolize the
// browser event loop. BrainstormPanel must keep accepting text and dispatching
// its own request while unrelated agents keep working in the background.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(here, name), "utf8");
const dispatch = read("dispatch.ts");
const agents = read("AgentsPage.tsx");
const brainstorm = read("BrainstormPanel.tsx");

function fail(message) {
  console.error(`FAIL brainstorm responsiveness: ${message}`);
  process.exit(1);
}

function must(source, re, message) {
  if (!re.test(source)) fail(message);
}

must(
  dispatch,
  /export function makeResponsiveHandlers[\s\S]*requestAnimationFrame[\s\S]*flush/,
  "dispatch.ts must export a requestAnimationFrame-backed stream buffer with flush()",
);
must(
  dispatch,
  /export function makeUiYield[\s\S]*await nextUiFrame/,
  "dispatch.ts must expose an explicit UI-yield helper",
);
must(
  dispatch,
  /streamChatCompletion[\s\S]*makeResponsiveHandlers\(onDelta, onThought\)[\s\S]*finally\s*\{[\s\S]*await responsive\.flush\(\)/,
  "shared streamChatCompletion must buffer callbacks and flush before returning",
);
must(
  dispatch,
  /streamLocalChat[\s\S]*makeResponsiveHandlers\(p\.onDelta, p\.onThought\)[\s\S]*const maybeYield = makeUiYield\(\)[\s\S]*await maybeYield\(\)[\s\S]*executeToolCall[\s\S]*await responsive\.flush\(\)/,
  "direct local chat/tool loop must be buffered and yield during tool work",
);
must(
  dispatch,
  /streamOpenAiApiWithTools[\s\S]*makeResponsiveHandlers\(args\.onDelta, args\.onThought\)[\s\S]*const maybeYield = makeUiYield\(\)[\s\S]*await maybeYield\(\)[\s\S]*consumeOpenAISse\(resp, onDelta, onThought/,
  "direct OpenAI-compatible tool loop must be buffered and yield",
);
must(
  dispatch,
  /consumeOpenAISse[\s\S]*const maybeYield = makeUiYield\(\)[\s\S]*while \(true\) \{[\s\S]*await maybeYield\(\)[\s\S]*while \(\(nl = buf\.indexOf\("\\n"\)\) >= 0\) \{[\s\S]*await maybeYield\(\)/,
  "OpenAI-compatible SSE parser must yield while parsing dense chunks",
);
must(
  dispatch,
  /consumeAnthropicSse[\s\S]*const maybeYield = makeUiYield\(\)[\s\S]*await maybeYield\(\)/,
  "Anthropic SSE parser must yield while streaming",
);

must(
  agents,
  /makeResponsiveHandlers,\s*[\r\n\s]*makeUiYield,/,
  "AgentsPage legacy routing must import the shared responsiveness helpers",
);
must(
  agents,
  /streamChatCompletion[\s\S]*makeResponsiveHandlers\(onDelta, onThought\)[\s\S]*try \{[\s\S]*finally \{[\s\S]*await responsive\.flush\(\)/,
  "AgentsPage local streamChatCompletion copy must buffer and flush callbacks",
);
must(
  agents,
  /consumeOpenAISse[\s\S]*const maybeYield = makeUiYield\(\)[\s\S]*await maybeYield\(\)/,
  "AgentsPage legacy OpenAI SSE parser must yield",
);
must(
  agents,
  /consumeAnthropicSse[\s\S]*const maybeYield = makeUiYield\(\)[\s\S]*await maybeYield\(\)/,
  "AgentsPage legacy Anthropic SSE parser must yield",
);

must(
  brainstorm,
  /<textarea[\s\S]*ref=\{chatInputRef\}[\s\S]*value=\{chatInput\}[\s\S]*onChange=\{\(e\) => setChatInput\(e\.target\.value\)\}/,
  "Brainstorm chat textarea must remain a normal controlled input",
);
must(
  brainstorm,
  /const sendFollowup = async \(\) => \{[\s\S]*if \(!t \|\| running\) return;[\s\S]*await runTurn\(t\);[\s\S]*\};/,
  "Brainstorm follow-up dispatch must be blocked only by its own running state",
);
must(
  brainstorm,
  /onClick=\{sendFollowup\}[\s\S]{0,120}disabled=\{running \|\| !chatInput\.trim\(\)\}/,
  "Brainstorm submit button must not depend on external agent/code run busy state",
);

console.log("PASS brainstorm responsiveness: stream work yields and BrainstormPanel remains independently interactive");

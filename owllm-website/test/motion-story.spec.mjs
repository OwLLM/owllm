import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const nav = read("../src/components/Nav.astro");
const rag = read("../src/components/MemoryRagShowcase.astro");
const showcase = read("../src/components/DifferenceShowcase.astro");
const theme = read("../src/lib/theme.ts");
const tokens = read("../src/styles/tokens.css");

test("the website header uses OWLLM's app-native control and activity grammar", () => {
  assert.match(nav, /Orchestrated Workflow for Large Language Models/);
  assert.match(nav, /Overview[\s\S]*Features[\s\S]*Live app[\s\S]*Marketplace/);
  assert.match(nav, /Get OWLLM/);
  assert.match(nav, /#ffd93c[\s\S]*#ff9a3c[\s\S]*#ff5c8a[\s\S]*#b07cff[\s\S]*#7fd4ff/);
  assert.match(nav, /data-scrolled/);
  assert.match(nav, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(nav, /border-radius:\s*8px/);
});

test("Memory RAG is an interactive lifecycle, not a static feature card", () => {
  for (const required of [
    "MEMORY CURATOR CONTEXT PACK",
    "PROJECT GRAPH",
    "INJECTED CONTEXT",
    "CURRENT TASK",
    "Scope",
    "Rank",
    "Pack",
    "Run + verify",
    "Curate",
    "save ≤ 2 facts",
  ]) {
    assert.ok(rag.includes(required), `missing RAG mechanism: ${required}`);
  }
  assert.match(rag, /data-rag-query/);
  assert.match(rag, /data-rag-node/);
  assert.match(rag, /setInterval/);
  assert.match(rag, /aria-live="polite"/);
  assert.match(rag, /prefers-reduced-motion:\s*reduce/);
  assert.match(showcase, /<MemoryRagShowcase \/>/);
});

test("feature containers communicate live mechanisms with the app aura", () => {
  assert.match(showcase, /data-capability-card/);
  assert.match(showcase, /scoped retrieval/);
  assert.match(showcase, /verified auto-feed/);
  assert.match(showcase, /capability-aura-spin/);
  assert.match(showcase, /capability-working/);
  assert.match(showcase, /capability-scan/);
  assert.match(showcase, /prefers-reduced-motion:\s*reduce/);
});

test("the site's default accent and derived theme tokens match the shipping app", () => {
  assert.match(theme, /DEFAULT_ACCENT:\s*AccentSelection\s*=\s*"cyan"/);
  assert.match(theme, /rgba\(\$\{rgb\.r\}, \$\{rgb\.g\}, \$\{rgb\.b\}, 0\.18\)/);
  assert.match(tokens, /--accent:\s*#5cf0ff/);
  assert.match(tokens, /--accent-rgb:\s*92, 240, 255/);
});

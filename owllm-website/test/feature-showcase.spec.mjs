import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const component = readFileSync(new URL("../src/components/DifferenceShowcase.astro", import.meta.url), "utf8");
const home = readFileSync(new URL("../src/pages/index.astro", import.meta.url), "utf8");
const features = readFileSync(new URL("../src/pages/features.astro", import.meta.url), "utf8");
const guide = readFileSync(new URL("../src/pages/how-to-use.astro", import.meta.url), "utf8");
const footer = readFileSync(new URL("../src/components/Footer.astro", import.meta.url), "utf8");
const capture = readFileSync(new URL("../scripts/capture-app-shots.mjs", import.meta.url), "utf8");
const astroConfig = readFileSync(new URL("../astro.config.mjs", import.meta.url), "utf8");

test("the local preview does not overlay Astro's developer toolbar", () => {
  assert.match(astroConfig, /devToolbar:\s*\{\s*enabled:\s*false/);
});

test("the homepage and Features page use the app-native product showcase", () => {
  assert.match(home, /import DifferenceShowcase/);
  assert.match(home, /<DifferenceShowcase \/>/);
  assert.match(features, /import DifferenceShowcase/);
  assert.match(features, /<DifferenceShowcase \/>/);
  assert.match(home, /orchestrated-workflow\.png/);
  assert.doesNotMatch(home, /heroOwl|hero-owl/);
});

test("the full product name uses the official singular expansion", () => {
  for (const source of [home, features, component, footer]) {
    assert.match(source, /Orchestrated Workflow for Large Language Models/);
    assert.doesNotMatch(source, /Orchestrated Workflows for Large Language Models/);
  }
});

test("the showcase uses captured app views instead of a hand-drawn explainer", () => {
  for (const asset of [
    "orchestrated-workflow.png",
    "solo-loop.png",
    "agent-chat-grid.png",
    "adaptive-workspace.png",
    "skills-library.png",
  ]) {
    assert.ok(component.includes(asset), `missing real app capture: ${asset}`);
  }
  for (const oldMockMarker of ["agent-shell", "workflow-visual", "fake-browser-head", "memory-visual", "notebook-visual"]) {
    assert.ok(!component.includes(oldMockMarker), `hand-drawn explainer returned: ${oldMockMarker}`);
  }
  assert.match(component, /border-radius:\s*0/);
  assert.match(component, /background:\s*transparent/);
  assert.match(component, /box-shadow:\s*none/);
});

test("the real Agentic execution and view switches remain central", () => {
  for (const required of [
    "Orchestrated Workflow",
    "Solo-Loop",
    "Agent Chat Grid",
    "Graph and Chat are two views of the same running team",
    "one live transcript per agent",
    "Verification Gate",
    "per agent or across the team",
  ]) {
    assert.ok(component.includes(required), `missing Agentic story: ${required}`);
  }
});

test("Skills Library and adaptive project environments are explained as shipped behavior", () => {
  for (const required of [
    "The real Studio · Skills view",
    "Anthropic, obra/superpowers, or any Git repository",
    "Auto Skills",
    "Project Environment designer",
    "browser beside the app",
    "Responsive projects open a phone viewport",
    "PDF, Word, PowerPoint, Excel",
    "cookies, passwords, and tokens remain device-local",
  ]) {
    assert.ok(component.includes(required), `missing skills/environment behavior: ${required}`);
  }
});

test("the capability audit covers OWLLM beyond coding", () => {
  for (const required of [
    "Two-agent Coding",
    "Memory Curator + RAG",
    "Notebook auto-feed",
    "Super User decisions",
    "Visible agent browser",
    "Encrypted device fleet",
    "Models without lock-in",
    "Real isolation + rules",
    "Private model lab",
    "MCP + messaging bridges",
    "A workstation that fits you",
    "Teams, agents, skills, marketplace",
  ]) {
    assert.ok(component.includes(required), `missing capability family: ${required}`);
  }
});

test("research links support orchestration, failure, verification, and context claims", () => {
  for (const href of [
    "anthropic.com/engineering/building-effective-agents",
    "anthropic.com/engineering/multi-agent-research-system",
    "arxiv.org/abs/2503.13657",
    "arxiv.org/abs/2606.09863",
    "anthropic.com/engineering/effective-context-engineering-for-ai-agents",
  ]) {
    assert.ok(component.includes(href), `missing research source: ${href}`);
  }
  assert.match(component, /Papers shape the architecture\. Runtime evidence decides what ships\./);
});

test("the guide teaches the newly surfaced real-app workflows", () => {
  for (const required of [
    "Orchestrated Workflow ↔ Solo-Loop",
    "Graph shows the routing",
    "one live transcript per agent",
    "Let OWLLM prepare the workspace and skills",
    "Studio → Skills",
    "Website and research projects arrange OWLLM with its shared browser on the right",
    "PDF, DOCX, XLSX, and PPTX",
  ]) {
    assert.ok(guide.includes(required), `guide is missing workflow: ${required}`);
  }
});

test("the capture harness drives real app selectors for every new visual", () => {
  for (const selector of [
    'FlowModeSwitch',
    'FlowModeSolo',
    'FlowViewBtn-chat',
    'ProjectEnvironmentDesigner',
    '📚 Skills',
  ]) {
    assert.ok(capture.includes(selector), `capture does not drive real UI selector: ${selector}`);
  }
  assert.match(capture, /resources["'], ["']agents["'], ["']teams/);
  assert.match(capture, /resources["'], ["']agents["'], ["']skills/);
});

test("new marketing captures contain rendered UI, not a flat compositor failure", async () => {
  for (const file of [
    "orchestrated-workflow.png",
    "solo-loop.png",
    "agent-chat-grid.png",
    "adaptive-workspace.png",
    "skills-library.png",
  ]) {
    const imagePath = fileURLToPath(new URL(`../src/assets/app/${file}`, import.meta.url));
    const metadata = await sharp(imagePath).metadata();
    const stats = await sharp(imagePath).stats();
    const variation = stats.channels.reduce((sum, channel) => sum + channel.stdev, 0);
    assert.ok((metadata.width ?? 0) >= 500, `${file} is unexpectedly narrow`);
    assert.ok((metadata.height ?? 0) >= 300, `${file} is unexpectedly short`);
    assert.ok(variation > 8, `${file} is visually flat (channel stdev sum ${variation})`);
  }
});

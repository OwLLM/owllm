// Focused verification for the Info page's two-column layout. Source-level
// structural assertions (no browser/React/Tauri runtime): the right column must
// be a fixed, order-stable pair — Application first, Sandbox directly below it —
// and the old CSS multi-column flow (which read DOWN each column and scrambled
// the intended order) must be gone. Lives in pages/agentic/ so the smoke matrix
// auto-discovers it; it reads the core InfoPage source by relative path.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Read source for content matching independent of the checkout's line endings
// (Windows core.autocrlf checks LF-committed files out as CRLF, so a needle
// containing \n would false-fail on a CRLF working tree).
const readSource = (rel) => fs.readFileSync(path.resolve(HERE, rel), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`✓ ${message}`);
}

const src = readSource("../core/InfoPage.tsx");

// The deterministic two-column shell replaced the old multi-column flow.
check(!src.includes("columnCount"),
  "the CSS multi-column flow (columnCount) is gone — order is no longer scrambled down columns");
const leftAt = src.indexOf('data-ui="InfoPage:left-column"');
const rightAt = src.indexOf('data-ui="InfoPage:right-column"');
check(leftAt !== -1, "a left column container is present");
check(rightAt !== -1, "a right column container is present");
check(leftAt < rightAt, "the left column is declared before the right column");
check((src.match(/data-ui="InfoPage:right-column"/g) || []).length === 1,
  "exactly one right column container is rendered");

// Slice the two columns so placement is asserted per-container, not page-wide.
const leftCol = src.slice(leftAt, rightAt);
const rightCol = src.slice(rightAt);

// Right column = exactly the two named containers, Application first.
const appAt = rightCol.indexOf('title="📦 Application"');
const sandboxAt = rightCol.indexOf("<SandboxDiskCard");
check(appAt !== -1, "the Application container lives in the right column");
check(sandboxAt !== -1, "the Sandbox container lives in the right column");
check(appAt < sandboxAt, "Application renders first, with Sandbox directly below it");

// The right column is its own vertical flex column, so the Application-above-
// Sandbox order is width-independent (holds even when the row wraps).
const rightOpenTag = rightCol.slice(0, rightCol.indexOf(">") + 1);
check(rightOpenTag.includes('flexDirection: "column"'),
  "the right column stacks vertically, keeping the pair's order at every window size");

// Content placement: the app-identity rows belong to Application (right column),
// and the machine cards stay in the left column — not duplicated across both.
check(rightCol.includes('label="Product"') && rightCol.includes('label="Update channel"'),
  "the application info (Product … Update channel) is inside the Application container");
check(!leftCol.includes('title="📦 Application"') && !leftCol.includes("<SandboxDiskCard"),
  "the left column holds neither the Application nor the Sandbox container");
check(leftCol.includes('title="💽 Cache"'), "Cache remains pinned in the left column");
check(leftCol.includes('title="✅ Environment readiness"') && leftCol.includes('title="🖥 Hardware"') && leftCol.includes('title="🦙 Model server"'),
  "the left column contains a balanced set of readiness, hardware, and server panels");
check(rightCol.includes('title="🎮 GPU detail"') && rightCol.includes('title="📁 Models"') && rightCol.includes('title="📜 About OwLLM"'),
  "the right column receives the remaining GPU, Models, and About panels");
check(!leftCol.includes('title="🎮 GPU detail"') && !leftCol.includes('title="📁 Models"') && !leftCol.includes('title="📜 About OwLLM"'),
  "the right-side balancing panels are not left stacked");

// No accidental duplication of either right-column container anywhere on the page.
check((src.match(/title="📦 Application"/g) || []).length === 1, "the Application container appears exactly once");
check((src.match(/<SandboxDiskCard/g) || []).length === 1, "the Sandbox container appears exactly once");

console.log(`OK info page layout: ${passed}/${passed} checks passed`);

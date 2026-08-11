// Regression check for the subscription-CLI error message.
//
// The bug: an expired Claude OAuth session (Claude Code removes
// ~/.claude/.credentials.json when a refresh fails) flipped
// accounts_status.claude_cli to false while claude_cli_installed stayed true,
// and every subscription path reported "Claude Code CLI not detected". Users
// went looking for a broken install instead of re-running `claude /login`.
//
// This asserts the two states produce DIFFERENT, actionable text, and that the
// two call sites actually consume the shared helper (a future edit that
// reinstates a hardcoded string fails here). esbuild is already present via
// vite — no new dependency.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentic = path.join(root, "ui", "src", "pages", "agentic");
const source = path.join(agentic, "cliAuthMessage.ts");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-cli-auth-"));
const bundle = path.join(temp, "cliAuthMessage.mjs");
await build({ entryPoints: [source], outfile: bundle, format: "esm", bundle: true, logLevel: "silent" });
const { claudeCliUnavailableMessage } = await import(pathToFileURL(bundle).href);

const signedOut = claudeCliUnavailableMessage({ loggedIn: false, installed: true });
const missing = claudeCliUnavailableMessage({ loggedIn: false, installed: false });

// The regression itself: these two states must not read the same.
assert.notEqual(signedOut, missing, "signed-out and not-installed must differ");

// Installed-but-signed-out must NOT accuse the install, and must name the fix.
assert.match(signedOut, /installed but not signed in/, "signed-out text must say it IS installed");
assert.doesNotMatch(signedOut, /not detected/, "signed-out text must not claim the CLI is missing");
assert.match(signedOut, /claude \/login/, "signed-out text must give the login command");

// Genuinely absent binary keeps the install instruction.
assert.match(missing, /not detected/, "missing text must say not detected");
assert.match(missing, /npm install -g @anthropic-ai\/claude-code/, "missing text must give the install command");

// Both call sites must route through the helper rather than a literal string.
// assert.ok, not assert.match: a failed match prints the whole 200 KB file.
for (const file of ["dispatch.ts", "AgentsPage.tsx"]) {
  const text = fs.readFileSync(path.join(agentic, file), "utf8");
  assert.ok(/claudeCliUnavailableMessage\(/.test(text), `${file} must use the shared helper`);
  assert.ok(
    !/"Claude Code CLI not detected/.test(text),
    `${file} must not hardcode the old conflated message`,
  );
  assert.ok(/claude_cli_installed/.test(text), `${file} must read claude_cli_installed`);
}

fs.rmSync(temp, { recursive: true, force: true });
console.log("cli-auth-message: OK");

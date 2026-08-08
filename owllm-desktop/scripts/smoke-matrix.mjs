#!/usr/bin/env node
// OWLLM PRODUCTION SMOKE MATRIX — the ship/no-ship gate.
//
// Green matrix = shippable. Anything less = not. Run before every publish
// (publish-release.sh runs it automatically; OWLLM_SKIP_SMOKE=1 to override).
//
//   node owllm-desktop/scripts/smoke-matrix.mjs [--static-only]
//
// Four sections:
//   S  Static tripwires — one source assertion per shipped regression fix, so
//      none of them can silently return. Each names the bug + version it guards.
//   H  Layer-1 harnesses — every ui/src/**/*.verify.run.mjs (routing, gate,
//      preflight, …) must exit 0. Auto-discovers new harnesses. Discovery was
//      once limited to ui/src/pages/agentic, which silently excluded 12
//      verifiers living elsewhere under ui/src (theme, framePreferences,
//      localization, …) — they existed but never gated a release.
//   P  Live provider cells — ONE REAL TURN per installed+logged-in CLI at the
//      exact spawn shapes the Rust side builds (small prompt / ≥40 KB prompt via
//      stdin / MCP tool round-trip against a mock gateway). Providers that are
//      not installed or not logged in SKIP with a reason — never a false FAIL.
//   W  WSL probes — interop + CLIs visible on the bwrap-jail PATH + creds.
//      Advisory (WARN), because an unprovisioned distro is environmental, not a
//      code regression.
//
// WHY the spawn boundary: every provider failure of 2026-07 (kimi 206, kimi
// LLMNotSet, kimi MCP-fatal, codex ToolSearch guidance, claude cmd-line limit,
// spaced --mcp-config path, Code-page provider routing) happened in the process
// invocation the app builds — and all three surfaces (Chat / Code / Agents)
// converge on those same Rust functions. The P cells mirror accounts.rs /
// mcp_gateway.rs shapes byte-for-byte; the S tripwires pin the Rust/TS source
// so mirror-drift gets caught by whichever side moved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // …/owllm-desktop/scripts
const APP = path.resolve(HERE, "..");                      // owllm-desktop
const STATIC_ONLY = process.argv.includes("--static-only");
const IS_WIN = process.platform === "win32";

// ---------------------------------------------------------------- results ---
const cells = []; // {section, name, status, note, ms}
function record(section, name, status, note = "", ms = 0) {
  cells.push({ section, name, status, note, ms });
  const icon = { PASS: "✓", FAIL: "✗", SKIP: "-", WARN: "!" }[status];
  const dur = ms ? ` · ${(ms / 1000).toFixed(1)}s` : "";
  console.log(`  ${icon} [${status}] ${name}${note ? ` — ${note}` : ""}${dur}`);
}

// ------------------------------------------------------- S: static tripwires
// [file relative to owllm-desktop, regex, "bug it guards (version)"]
const TRIPWIRES = [
  ["src-tauri/src/accounts.rs", /fold_prompt_into_stdin/, "kimi 32KB cmdline crash — os error 206 (v0.7.90)"],
  ["src-tauri/src/accounts.rs", /fold_system_into_stdin/, "claude 'command line too long' fold (v0.7.88)"],
  ["src-tauri/src/accounts.rs", /kimi_model_args/, "kimi LLMNotSet on undeclared --model id (v0.7.82)"],
  ["src-tauri/src/accounts.rs", /kimi_output_mcp_failed/, "kimi fatal abort on MCP connect failure → retry (v0.7.83)"],
  ["src-tauri/src/accounts.rs", /let gw_broken = false;/, "kimi browser MCP failure is per-run only, never a session-long tool blackout (v0.8.20)"],
  ["src-tauri/src/accounts.rs", /CLI_CHILD_TIMEOUT[\s\S]*20 \* 60/, "one-shot CLI providers cannot keep Agents page busy forever (v0.8.21)"],
  ["src-tauri/src/accounts.rs", /is_browser_role_allowlist[\s\S]*is_unrestricted_tool_allowlist/, "isolated browser relay is limited to Browser + unrestricted Solo Generalist roles (v0.9.71)"],
  ["src-tauri/src/browser.rs", /browser_start_inner\(&app\)\?/, "serialized browser tool first-call auto-start — snapshot/get_text no longer fail on closed window (v0.8.18/v0.8.96)"],
  ["src-tauri/src/paths.rs", /fn webview_profile_scope[\s\S]*exe\.parent\(\)\.map\(Path::to_path_buf\)/, "installed app never reuses poisoned default EBWebView profile (v0.8.97)"],
  ["src-tauri/src/paths.rs", /(?=[\s\S]*isolated-webview-v2)(?=[\s\S]*Default\/Local Storage)(?=[\s\S]*max_by_key)/, "isolated WebView upgrades preserve the richest chat/notebook profile (v0.8.98)"],
  ["src-tauri/src/autostart.rs", /fn stable_autostart_exe[\s\S]*!is_volatile_path\(path\)/, "an AppImage run from /tmp is never written into login autostart — the next reboot wiped it and the entry could only self-repair on a launch that no longer happened (v1.0.8)"],
  ["src-tauri/Cargo.toml", /tao[\s\S]*rev = "c704261c519c58cfdd0bc2d58ba24e06a0b71c92"/, "Tao PeekMessageW runs outside input mutexes — no keyboard re-entrancy deadlock (v0.9.2)"],
  ["src-tauri/src/mcp_gateway.rs", /cli_safe_path/, "spaced 'OwLLM Desktop' --mcp-config path split → 8.3 short path (v0.7.62)"],
  ["src-tauri/src/mcp_gateway.rs", /bearer_token_env_var/, "codex MCP wiring via -c overrides + env token (v0.7.72)"],
  ["src-tauri/src/directives.rs", /directives_seed_marks/, "project rules re-seeded 11x into every prompt (v0.7.91)"],
  ["src-tauri/src/directives.rs", /Never bundle, embed, commit, or ship credentials/, "every project ships the no-embedded-credentials rule (v0.9.43)"],
  ["src-tauri/src/projects.rs", /fn open_state_db[\s\S]*busy_timeout/, "shared state DB waits for a contended lock instead of failing 'database is locked' (v0.9.50)"],
  ["src-tauri/src/projects.rs", /journal_mode=WAL/, "state DB readers and writers stop blocking each other (v0.9.50)"],
  ["src-tauri/src/memory.rs", /fn reindex_ids_atomically[\s\S]*SAVEPOINT/, "memory reindex is ONE transaction, not one autocommit per index term (v0.9.50)"],
  ["src-tauri/src/vault.rs", /total_changes\(\)[\s\S]{0,400}merge_team_memory[\s\S]{0,200}total_changes\(\)/, "a converged vault sync skips the whole-scope memory reindex (v0.9.50)"],
  ["ui/src/pages/agentic/ProjectSettingsDialog.tsx", /update_project[\s\S]{0,120}row\.repo_url = repoUrl;[\s\S]{0,120}\} catch/, "a failed post-create repo_url stamp cannot orphan the project row and cause duplicate-on-retry (v0.9.50)"],
  ["src-tauri/src/browser.rs", /SetIsPasswordAutosaveEnabled\(true\)/, "agent browser saves/refills website logins — WebView2 autosave is off by default (v0.9.43)"],
  ["src-tauri/src/browser.rs", /set_persistent_credential_storage_enabled\(true\)/, "Linux agent browser persists HTTP-auth logins — WebKitGTK credential store is off by default (v0.9.43)"],
  ["src-tauri/src/browser.rs", /WindowEvent::CloseRequested \{ api, \.\. \}[\s\S]{0,500}api\.prevent_close\(\)/, "Linux title-bar close retains WebKitGTK windows instead of aborting Thor with X11 BadDrawable"],
  ["src-tauri/src/browser.rs", /#\[cfg\(not\(target_os = "linux"\)\)\]\s*fn destroy_browser_windows/, "Linux browser stop never destroys a WebKitGTK top-level window on NVIDIA/Tegra"],
  ["src-tauri/src/browser.rs", /fn apply_linux_device[\s\S]{0,900}settings\.set_user_agent/, "Linux device emulation changes WebKitGTK in place instead of destroy/rebuild"],
  ["ui/src/pages/agentic/dispatch.ts", /streamMoonshot/, "shared dispatch routes kimi — Code page 'unknown model_id' (v0.7.89)"],
  ["ui/src/pages/agentic/dispatch.ts", /streamGemini/, "shared dispatch routes gemini (v0.7.89)"],
  ["ui/src/pages/agentic/dispatch.ts", /deepseek/, "shared dispatch routes OpenAI-compatible providers (v0.7.89)"],
  ["ui/src/pages/agentic/dispatch.ts", /streamOpenAiApiWithTools\(\{[\s\S]*allowedTools: args\.allowedTools[\s\S]*apiUrl: args\.url/, "OpenAI-compatible API providers use the host tool loop, not plain chat (v0.8.20)"],
  ["ui/src/pages/agentic/AgentsPage.tsx", /streamOpenAiApiWithTools\(\{[\s\S]*allowedTools: args\.allowedTools[\s\S]*apiUrl: args\.url/, "Agentic teams give OpenAI-compatible API providers browser/local tools (v0.8.20)"],
  ["ui/src/pages/agentic/RunNotebook.tsx", /^(?![\s\S]*digestInput)(?=[\s\S]*Working notes)(?=[\s\S]*Plan board)(?=[\s\S]*Save plan \+ clear notes)(?=[\s\S]*Do NOT create tiny painful micro-steps)[\s\S]*$/s, "Notebook has one notes input, Kanban plan, clears consumed notes, avoids micro-steps (v0.8.23)"],
  ["ui/src/pages/agentic/localTools.ts", /MEMORY_INVOKE_TIMEOUT_MS/, "memory context is bounded and cannot stall agent startup for minutes (v0.8.20)"],
  ["ui/src/pages/agentic/localTools.ts", /NO ToolSearch/i, "codex chased Claude-only ToolSearch → 'Found 0 tools' (v0.7.74)"],
  ["resources/agents/roles/browser.yaml", /browser_snapshot/, "Browser role allowlist keys the jail exception (v0.7.69)"],
  // Native browser callbacks run ON THE UI THREAD. Any BLOCKING lock reachable
  // from one deadlocks the event thread and freezes every OwLLM window. capture_reply
  // was hardened in v0.8.96; is_active_tab (on_page_load) was missed and froze the app
  // the moment a project opened the agent browser (v0.9.64, gdb-confirmed).
  ["src-tauri/src/browser.rs", /fn is_active_tab[\s\S]{0,900}TABS\.try_lock\(\)/, "is_active_tab never blocks the native UI-thread callback (v0.9.65 agent-browser freeze)"],
  ["src-tauri/src/browser.rs", /fn capture_reply[\s\S]{0,900}REPLIES\.try_lock\(\)/, "capture_reply never blocks the native UI-thread callback (v0.8.96)"],
  // Zeroed-ref git storm (2026-08-01): a crash mid-ref-write left refs/heads/main
  // as 41 NUL bytes, every sync retried forever, and a failing gc --auto wrote a
  // pack per attempt — 5,046 packs / 11.5 GB, ~2 git procs/sec, which starved
  // every other git operation on the box through the shared credential lock.
  // Four independent guards; losing any one of them lets the runaway back.
  ["src-tauri/src/vault.rs", /"config", "core\.fsync", "all"/, "refs are fsynced, so a crash cannot zero a ref (prevention, all OS)"],
  ["src-tauri/src/vault.rs", /fn repair_broken_ref[\s\S]{0,3000}update-ref/, "a zeroed ref self-heals from reflog/origin instead of failing forever"],
  ["src-tauri/src/vault.rs", /--path-format=absolute[\s\S]{0,80}--git-common-dir/, "ref repair resolves refs in the COMMON dir, so fleet worktrees heal too"],
  ["src-tauri/src/vault.rs", /COOLDOWN_UNTIL[\s\S]{0,1500}fn note_repo_health/, "circuit breaker stops timer-rate retries when a heal does not stick"],
  ["src-tauri/src/vault.rs", /fn maintain_repo[\s\S]{0,900}repack", "-ad"/, "pack count is consolidated deliberately (auto-gc thrash disabled)"],
  ["src-tauri/src/git.rs", /is_broken_ref[\s\S]{0,200}repair_broken_ref/, "Code-page git self-heals a zeroed ref"],
  ["src-tauri/src/fleet.rs", /is_broken_ref[\s\S]{0,200}repair_broken_ref/, "fleet worktree git self-heals a zeroed ref"],
  // Bounded rendering — the WebView2 "Out of Memory" renderer crash (v0.9.60).
  // Run views append forever; rendering every entry grew the DOM monotonically
  // until the renderer hit its per-process ceiling. If any of these render sites
  // goes back to mapping the FULL array, the crash returns.
  ["ui/src/pages/agentic/AgentsPage.tsx", /fullChat\.slice\(fullWin\.start\)/, "Full Chat renders a bounded tail, not every entry (v0.9.60 OOM fix)"],
  ["ui/src/pages/agentic/AgentsPage.tsx", /thoughts\.slice\(thoughtWin\.start\)/, "Thought view renders a bounded tail (v0.9.60 OOM fix)"],
  ["ui/src/pages/agentic/AgentsPage.tsx", /toolCalls\.slice\(toolsWin\.start\)/, "Tool Calls view renders a bounded tail (v0.9.60 OOM fix)"],
  ["ui/src/pages/agentic/CodePage.tsx", /messages\.slice\(transcriptWin\.start\)/, "Code transcript renders a bounded tail (v0.9.60 OOM fix)"],
  ["ui/src/components/LogBox.tsx", /INLINE_TAIL_CHARS/, "LogBox lays out only the log tail inline; full text stays in the modal (v0.9.60 OOM fix)"],
  ["../.github/workflows/release.yml", /UPDATER_OUTPUT="stage\/latest-\$\{\{ matrix\.rust_target \}\}\.json"[\s\S]{0,100}generate-updater-manifest\.mjs/, "release builds generate target-qualified updater manifests instead of expecting Tauri to emit latest.json"],
  ["../.github/workflows/release.yml", /Verify updater manifest generation[\s\S]{0,180}generate-updater-manifest\.verify\.run\.mjs/, "updater manifest regression check runs before every release build"],
  ["../.github/workflows/release.yml", /TAURI_BUILD_MAX_ATTEMPTS=3[\s\S]{0,900}retrying in 15 seconds/, "transient platform-bundler downloads retry without discarding a completed native build"],
  ["../.github/workflows/release.yml", /label: 'Linux ARM64'[\s\S]{0,240}ubuntu-24\.04-arm[\s\S]{0,240}aarch64-unknown-linux-gnu/, "official release matrix builds and signs Linux ARM64 on a native hosted runner"],
  ["../.github/workflows/release.yml", /timeout-minutes: 90/, "optimized Linux release builds are not cancelled at the old 45-minute cap"],
  ["../.github/workflows/release.yml", /requiredPlatforms[\s\S]{0,300}"linux-x86_64"[\s\S]{0,120}"linux-aarch64"/, "public updater manifest requires both Linux architectures"],
  ["../.github/workflows/mac-release-repair.yml", /gh release view "\$TAG"[\s\S]{0,240}gh release create "\$TAG"/, "macOS-only release path creates a missing public release instead of requiring another platform first"],
  ["../.github/workflows/mac-release-repair.yml", /const manifest = \{[\s\S]{0,240}version: process\.env\.VERSION[\s\S]{0,400}"darwin-aarch64"/, "macOS-only release path generates its updater manifest without a pre-existing cross-platform manifest"],
  ["../.github/workflows/mac-release-repair.yml", /macos-arm64:[\s\S]{0,80}runs-on: macos-latest/, "macOS-only releases use an available hosted Apple Silicon runner"],
  ["../.github/workflows/mac-release-repair.yml", /Preserve signed macOS release files[\s\S]{0,240}actions\/upload-artifact@v4[\s\S]*Publish Mac assets and manifest/, "signed macOS files survive a public-repository credential failure"],
  ["../.github/workflows/mac-release-repair.yml", /Restore Apple Silicon Rust build cache[\s\S]{0,180}shared-key: tauri-aarch64-apple-darwin/, "macOS-only releases reuse the existing Apple Silicon build cache"],
  ["../.github/workflows/sign-local-macos-updater.yml", /workflow_dispatch:[\s\S]{0,500}sha256:[\s\S]{0,500}runs-on: macos-latest[\s\S]{0,1200}Download locally-built archive[\s\S]{0,1200}signer sign/, "local Mac releases sign the checksum-pinned prebuilt archive without another application build"],
];

function runStatic() {
  console.log("\nS) Static tripwires — regression fixes pinned in source");
  for (const [rel, re, guard] of TRIPWIRES) {
    const p = path.join(APP, rel);
    let ok = false, note = guard;
    try { ok = re.test(fs.readFileSync(p, "utf8")); }
    catch { note = `${guard} — FILE MISSING: ${rel}`; }
    record("S", `${rel} :: ${re.source.slice(0, 32)}`, ok ? "PASS" : "FAIL", ok ? guard : note);
  }
}

// -------------------------------------------------- H: layer-1 harnesses ---
function runHarnesses() {
  console.log("\nH) Layer-1 harnesses (control-flow verifiers)");
  const root = path.join(APP, "ui/src");
  const tsc = path.join(APP, "node_modules/typescript/lib/typescript.js");
  // Recursive: harnesses live beside the code they verify, not only under
  // pages/agentic. Sorted by path so the run order is stable.
  const found = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".verify.run.mjs")) found.push(p);
    }
  })(root);
  const dependencyFree = new Set([
    "organizationProfile.verify.run.mjs",
    "ptyAuthInput.verify.run.mjs",
    "browserCredentialVault.verify.run.mjs",
    "claudeCliConnection.verify.run.mjs",
    "isolatedWorktreeSync.verify.run.mjs",
  ]);
  const files = found.sort();
  const runHarness = (p) => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [p], {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        OWLLM_SMOKE_STATIC_ONLY: STATIC_ONLY ? "1" : process.env.OWLLM_SMOKE_STATIC_ONLY || "",
      },
    });
    const ok = r.status === 0;
    const tail = ((r.stdout || "") + (r.stderr || "")).trim().split(/\r?\n/).slice(-1)[0] || "";
    record("H", path.relative(root, p).replace(/\\/g, "/"), ok ? "PASS" : "FAIL", ok ? "" : tail.slice(0, 120), Date.now() - t0);
  };

  for (const p of files.filter((p) => dependencyFree.has(path.basename(p)))) runHarness(p);

  if (!fs.existsSync(tsc)) {
    record("H", "TypeScript-dependent *.verify.run.mjs", "SKIP", "node_modules/typescript missing - run npm install in owllm-desktop first");
    return;
  }
  for (const p of files.filter((p) => !dependencyFree.has(path.basename(p)))) runHarness(p);
}
// ---------------------------------------- T: undefined-identifier sweep ----
// The [merge:code] squash merges have repeatedly kept a symbol's USAGES while
// dropping its DEFINITION (SmartImage ×2, LINUX_TRANSPARENT_WINDOW,
// HOST_LABEL). Rollup treats a bare undefined identifier as a runtime global,
// so `npm run build` passes and the app crashes at MOUNT — v0.8.92 shipped a
// Latest that white-screened on launch exactly this way. tsc is the only tool
// that sees the whole class (TS2304/2305/2306/2552), so run it and fail the
// gate on any cannot-find-name error. The AppShell_PATCH_* scratch files are
// excluded: they are committed debris, never imported, never bundled.
function runUndefinedIdentifiers() {
  console.log("\nT) Undefined-identifier sweep (tsc cannot-find-name family)");
  const t0 = Date.now();
  const tscBin = path.join(APP, "node_modules/typescript/bin/tsc");
  if (!fs.existsSync(tscBin)) {
    record("T", "tsc undefined-identifier sweep", "SKIP", "node_modules/typescript missing — run npm install in owllm-desktop first");
    return;
  }
  const r = spawnSync(process.execPath, [tscBin, "--noEmit", "-p", path.join(APP, "ui/tsconfig.json")], { encoding: "utf8", timeout: 240_000, cwd: APP });
  const bad = ((r.stdout || "") + (r.stderr || "")).split(/\r?\n/)
    .filter((l) => /error TS(2304|2305|2306|2552):/.test(l))
    .filter((l) => !/AppShell_PATCH/.test(l));
  record("T", "tsc undefined-identifier sweep", bad.length ? "FAIL" : "PASS",
    bad.length ? bad.slice(0, 3).join(" | ").slice(0, 200) : "no merge-dropped definitions", Date.now() - t0);
}

// -------------------------------------------------- mock MCP gateway -------
// Minimal MCP streamable-HTTP server speaking the same dialect the in-app
// gateway does (plain-JSON replies — verified live against claude/codex/kimi).
// Bearer-token auth like mcp_gateway.rs; tools/call returns a magic token the
// cells assert on, so a pass means the FULL loop ran: config → connect → auth
// → initialize → tools/list → tools/call → result back into the reply.
const MCP_MAGIC = `SMOKE_MCP_${crypto.randomBytes(3).toString("hex")}`;
function startMockGateway(token) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      if ((req.headers.authorization || "") !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        let msg; try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
        const reply = (result) => res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        if (msg.method === "initialize") {
          reply({ protocolVersion: msg.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "owllm", version: "0.0.0-smoke" } });
        } else if (!("id" in msg)) { res.writeHead(202).end(); }
        else if (msg.method === "tools/list") {
          reply({ tools: [{ name: "browser_snapshot", description: "Snapshot the shared agent browser page — returns the indexed interactive elements.", inputSchema: { type: "object", properties: {} } }] });
        } else if (msg.method === "tools/call") {
          reply({ content: [{ type: "text", text: `${MCP_MAGIC} [1] About [2] Designs [7] English` }], isError: false });
        } else reply({});
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() }));
  });
}

// ------------------------------------------------------- CLI plumbing ------
// Quote one argv element for the MSVC cmdline parser (same rules the app's
// win_quote_arg follows). Args here never contain newlines.
const winq = (s) => '"' + String(s).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"';

function findCli(name) {
  const w = spawnSync(IS_WIN ? "where.exe" : "which", [name], { encoding: "utf8" });
  const hits = (w.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  // Prefer a real launcher (.cmd/.exe) over the extension-less git-bash shim.
  const best = hits.find((h) => /\.(cmd|exe|bat)$/i.test(h)) || hits[0];
  if (best) return best;
  if (IS_WIN && name === "kimi") {
    // Mirror find_kimi_cli's extra dirs: pip installs land in Python Scripts.
    const roots = [path.join(process.env.APPDATA || "", "Python"), path.join(process.env.LOCALAPPDATA || "", "Programs", "Python")];
    for (const root of roots) {
      try {
        for (const v of fs.readdirSync(root)) {
          const p = path.join(root, v, "Scripts", "kimi.exe");
          if (fs.existsSync(p)) return p;
        }
      } catch { /* dir absent */ }
    }
  }
  return null;
}

function runCli(bin, args, { stdinText, env, cwd, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    const isBatch = IS_WIN && /\.(cmd|bat)$/i.test(bin);
    const opts = {
      cwd: cwd || APP,
      env: { ...process.env, ...(env || {}) },
      stdio: [stdinText != null ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    };
    if (isBatch) {
      // node refuses direct .cmd spawn (CVE-2024-27980 guard) — go through
      // cmd.exe with a hand-quoted verbatim line, the same layer the app uses.
      const line = `"${[winq(bin), ...args.map(winq)].join(" ")}"`;
      child = spawn("cmd.exe", ["/d", "/s", "/c", line], { ...opts, windowsVerbatimArguments: true });
    } else {
      child = spawn(bin, args, opts);
    }
    let out = "", err = "", done = false, timedOut = false;
    const finish = (code) => {
      if (done) return; done = true;
      resolve({ code, out, err, timedOut, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch { } }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { err += `\nspawn error: ${e.message}`; clearTimeout(timer); finish(-1); });
    child.on("close", (code) => { clearTimeout(timer); finish(code); });
    if (stdinText != null) { child.stdin.on("error", () => { }); child.stdin.end(stdinText); }
  });
}

// A ≥40 KB payload — over the 32 KB CreateProcess cap and the 8 KB cmd-shim
// cap, so it only survives through stdin (the shape the app now uses).
function bigPrompt(token) {
  const filler = "Reference material line for the smoke matrix; ignore its content entirely.\n".repeat(560); // ~43 KB
  return `${filler}\nEnd of reference. Reply with exactly ${token} and nothing else.`;
}

async function cell(section, name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn(); // {status, note}
    record(section, name, r.status, r.note || "", Date.now() - t0);
  } catch (e) {
    record(section, name, "FAIL", String(e?.message ?? e).slice(0, 140), Date.now() - t0);
  }
}

// An expired / invalid subscription token is a credential STATE, not a code
// regression — same class as "not logged in", which already SKIPs. So an auth
// error downgrades the cell to SKIP-with-reason (re-login) rather than blocking
// a ship of unrelated code. The matrix stays honest (it does not claim the
// provider works) without a false red.
const AUTH_ERR = /invalid[_ ]?authentication|authentication[_ ]?error|verify your credentials|401 unauthorized|not (?:logged in|authenticated)|please (?:re-?)?login|token (?:expired|invalid)/i;
const expectToken = (r, token) => {
  if (r.timedOut) return { status: "FAIL", note: "timed out" };
  if (r.out.includes(token)) return { status: "PASS" };
  if (AUTH_ERR.test(r.out + " " + r.err)) return { status: "SKIP", note: "credentials invalid/expired — re-login on the Accounts page" };
  const tail = (r.out + " " + r.err).trim().replace(/\s+/g, " ").slice(-160);
  return { status: "FAIL", note: `exit ${r.code}; tail: ${tail}` };
};

// ---------------------------------------------------- P: provider cells ----
async function runProviders() {
  console.log("\nP) Live provider cells — one real turn per installed CLI");
  const home = os.homedir();
  const exists = (...p) => fs.existsSync(path.join(...p));
  const gwToken = crypto.randomBytes(16).toString("hex");
  const gw = await startMockGateway(gwToken);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-smoke-"));
  // Claude-format MCP config (mirrors mcp_gateway::write_cli_config; kimi
  // reads the same format via --mcp-config-file).
  const mcpCfg = path.join(tmp, "mcp.json"); // space-free by construction, like cli_safe_path guarantees
  fs.writeFileSync(mcpCfg, JSON.stringify({ mcpServers: { owllm: { type: "http", url: gw.url, headers: { Authorization: `Bearer ${gwToken}` } } } }, null, 2));
  const mcpBrokenCfg = path.join(tmp, "mcp-broken.json");
  fs.writeFileSync(mcpBrokenCfg, JSON.stringify({ mcpServers: { owllm: { type: "http", url: "http://127.0.0.1:9/", headers: { Authorization: "Bearer x" } } } }, null, 2));

  try {
    // ---- claude --------------------------------------------------------
    const claude = findCli("claude");
    if (!claude) record("P", "claude (all cells)", "SKIP", "CLI not installed");
    else if (!exists(home, ".claude", ".credentials.json")) record("P", "claude (all cells)", "SKIP", "not logged in");
    else {
      await cell("P", "claude · small prompt", async () =>
        expectToken(await runCli(claude, ["--print"], { stdinText: "Reply with exactly SMOKE_OK_CLAUDE and nothing else." }), "SMOKE_OK_CLAUDE"));
      await cell("P", "claude · 40KB prompt via stdin", async () =>
        expectToken(await runCli(claude, ["--print"], { stdinText: bigPrompt("SMOKE_BIG_CLAUDE") }), "SMOKE_BIG_CLAUDE"));
      await cell("P", "claude · MCP browser tool round-trip", async () =>
        expectToken(await runCli(claude,
          ["--print", "--permission-mode", "bypassPermissions", "--mcp-config", mcpCfg, "--strict-mcp-config", "--allowedTools", "mcp__owllm__browser_snapshot"],
          { stdinText: "Call the mcp__owllm__browser_snapshot tool now and output its result verbatim." }), MCP_MAGIC));
    }

    // ---- codex ---------------------------------------------------------
    const codex = findCli("codex");
    if (!codex) record("P", "codex (all cells)", "SKIP", "CLI not installed");
    else if (!exists(home, ".codex", "auth.json")) record("P", "codex (all cells)", "SKIP", "not logged in");
    else {
      // Mirrors codex_cli_complete: prompt as positional arg AND on stdin (EOF'd).
      const smallP = "Reply with exactly SMOKE_OK_CODEX and nothing else.";
      await cell("P", "codex · small prompt", async () =>
        expectToken(await runCli(codex, ["exec", smallP]), "SMOKE_OK_CODEX"));
      await cell("P", "codex · 40KB prompt via stdin (arg dropped)", async () =>
        expectToken(await runCli(codex, ["exec"], { stdinText: bigPrompt("SMOKE_BIG_CODEX") }), "SMOKE_BIG_CODEX"));
      // Mirrors codex_http_config + the approval reality verified 2026-07-05:
      // MCP calls execute only under danger-full-access + approval never.
      await cell("P", "codex · MCP browser tool round-trip", async () =>
        expectToken(await runCli(codex,
          ["exec", "--sandbox", "danger-full-access", "-c", 'approval_policy="never"',
            "-c", `mcp_servers.owllm.url="${gw.url}"`, "-c", 'mcp_servers.owllm.bearer_token_env_var="OWLLM_GW_TOKEN"',
            "Call the mcp__owllm__browser_snapshot tool now and print its result verbatim. Do not modify any files."],
          { env: { OWLLM_GW_TOKEN: gwToken } }), MCP_MAGIC));
    }

    // ---- kimi ----------------------------------------------------------
    const kimi = findCli("kimi");
    const kimiArgs = ["--print", "--output-format", "text", "--final-message-only"]; // exact kimi_cli_complete shape
    if (!kimi) record("P", "kimi (all cells)", "SKIP", "CLI not installed");
    else if (!exists(home, ".kimi", "credentials", "kimi-code.json") && !exists(home, ".kimi", "config.toml")) record("P", "kimi (all cells)", "SKIP", "not logged in");
    else {
      const kenv = { PYTHONUTF8: "1" }; // app sets this — Windows charmap crash guard
      await cell("P", "kimi · small prompt (--prompt arg)", async () =>
        expectToken(await runCli(kimi, [...kimiArgs, "--prompt", "Reply with exactly SMOKE_OK_KIMI and nothing else."], { env: kenv }), "SMOKE_OK_KIMI"));
      await cell("P", "kimi · 40KB prompt via stdin (206 guard)", async () =>
        expectToken(await runCli(kimi, kimiArgs, { stdinText: bigPrompt("SMOKE_BIG_KIMI"), env: kenv }), "SMOKE_BIG_KIMI"));
      await cell("P", "kimi · MCP browser tool round-trip", async () =>
        expectToken(await runCli(kimi, [...kimiArgs, "--mcp-config-file", mcpCfg, "--prompt", "Use the browser_snapshot tool now and output its result verbatim."], { env: kenv }), MCP_MAGIC));
      // kimi hard-aborts a turn when an MCP server can't connect (exit 0!) —
      // the Rust retry keys on that exact failure text. If a kimi update ever
      // changes the behavior or the wording, this cell tells us before a user does.
      await cell("P", "kimi · unreachable-MCP behavior still detectable", async () => {
        const r = await runCli(kimi, [...kimiArgs, "--mcp-config-file", mcpBrokenCfg, "--prompt", "Reply with exactly SMOKE_OK and nothing else."], { env: kenv });
        if (r.timedOut) return { status: "FAIL", note: "timed out" };
        const all = r.out + r.err;
        if (AUTH_ERR.test(all)) return { status: "SKIP", note: "credentials invalid/expired — re-login on the Accounts page" };
        if (/Failed to connect MCP servers/i.test(all)) return { status: "PASS", note: "fatal-abort text matches kimi_mcp_connect_failed" };
        if (/SMOKE_OK/.test(r.out)) return { status: "WARN", note: "kimi now SURVIVES a dead MCP server — Rust retry is obsolete (harmless)" };
        return { status: "FAIL", note: `unrecognized behavior; tail: ${all.replace(/\s+/g, " ").slice(-140)}` };
      });
    }

    // ---- gemini --------------------------------------------------------
    const gemini = findCli("gemini");
    if (!gemini) record("P", "gemini (all cells)", "SKIP", "CLI not installed");
    else if (!exists(home, ".gemini", "oauth_creds.json")) record("P", "gemini · small prompt", "SKIP", "not logged in");
    else await cell("P", "gemini · small prompt", async () =>
      expectToken(await runCli(gemini, ["--prompt", "Reply with exactly SMOKE_OK_GEMINI and nothing else."]), "SMOKE_OK_GEMINI"));
  } finally {
    gw.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  }
}

// ------------------------------------------------------- W: WSL probes -----
// Advisory: an unprovisioned distro is environmental, not a code regression —
// so WARN, never FAIL. (The bugs these catch: kimi in ~/.local invisible to the
// jail; interop OFF killing the gateway relay; creds never synced.)
function runWsl() {
  console.log("\nW) WSL probes (advisory)");
  if (!IS_WIN) { record("W", "wsl", "SKIP", "not Windows"); return; }
  const list = spawnSync("wsl.exe", ["-l", "-q"], { encoding: "utf8" });
  const distro = (list.stdout || "").replace(/\0/g, "").split(/\r?\n/).map((s) => s.trim()).filter((d) => d && !/docker/i.test(d))[0];
  if (!distro) { record("W", "wsl", "SKIP", "no distro installed"); return; }
  const sh = (cmd, t = 30_000) => spawnSync("wsl.exe", ["-d", distro, "--", "sh", "-c", cmd], { encoding: "utf8", timeout: t });

  const interop = sh("/mnt/c/Windows/System32/curl.exe --version 2>&1 | head -1");
  record("W", `${distro} · Windows interop (gateway relay transport)`, /curl \d/.test(interop.stdout || "") ? "PASS" : "WARN",
    /curl \d/.test(interop.stdout || "") ? "" : "interop OFF — WSL agents get no browser gateway; fix /etc/wsl.conf [interop]");

  const clis = sh('PATH=/usr/local/bin:/usr/bin:/bin; for c in claude codex gemini kimi; do printf "%s=%s\\n" "$c" "$(command -v $c || echo MISSING)"; done');
  for (const line of (clis.stdout || "").trim().split(/\n/)) {
    const [name, where] = line.split("=");
    if (!name) continue;
    record("W", `${distro} · ${name} on jail PATH`, where && where !== "MISSING" ? "PASS" : "WARN",
      where === "MISSING" ? "not provisioned — run Install CLI for WSL" : where);
  }
  const kimiCreds = sh('[ -f "$HOME/.kimi/credentials/kimi-code.json" ] || [ -f "$HOME/.kimi/config.toml" ] && echo YES || echo NO');
  record("W", `${distro} · kimi creds synced`, /YES/.test(kimiCreds.stdout || "") ? "PASS" : "WARN",
    /YES/.test(kimiCreds.stdout || "") ? "" : "run Sync logins on the Accounts page");
}

// ----------------------------------------------------------------- main ----
console.log(`OWLLM smoke matrix — ${new Date().toISOString()} — ${APP}`);
runStatic();
runHarnesses();
runUndefinedIdentifiers();
if (!STATIC_ONLY) { await runProviders(); runWsl(); }
else console.log("\n(—static-only: provider + WSL sections skipped)");

const n = (s) => cells.filter((c) => c.status === s).length;
const fails = cells.filter((c) => c.status === "FAIL");
console.log(`\n${"─".repeat(64)}\nMATRIX: ${n("PASS")} pass · ${fails.length} fail · ${n("SKIP")} skip · ${n("WARN")} warn`);
if (fails.length) {
  console.log("FAILED CELLS:");
  for (const c of fails) console.log(`  ✗ [${c.section}] ${c.name} — ${c.note}`);
  console.log("\nNOT SHIPPABLE. Fix the failures or (emergencies only) OWLLM_SKIP_SMOKE=1.");
  process.exit(1);
}
console.log("SHIPPABLE — matrix green.");

// Harness verifier for the sandbox outbound-network preflight.
//
// Regression guarded (2026-08-12): the Windows HNS NAT behind WSL stopped
// forwarding return traffic — the guest sent 506 packets and received 5. Every
// outbound connect from inside the distro timed out, so the agent CLI sat in
// SYN-SENT for 10+ minutes with ~1s of CPU and the run looked like a hung
// model: no output, no error. Restarting the prompt just opened a new socket
// into the same dead path (runs burned 579s and 214s, one returned empty).
// `wsl --shutdown` — what the app's own "Restart WSL networking" button runs —
// was measured NOT to fix it.
//
// So: before routing a CLI into WSL, prove the distro can open an outbound TCP
// connection. If it can't, refuse in seconds with a message that names the real
// cause instead of consuming the whole run.
//
// Source-text assertions only (no TypeScript transpile) so this stays in the
// dependency-free batch and runs even without node_modules.
//
// Run: node owllm-desktop/ui/src/pages/agentic/sandboxNetPreflight.verify.run.mjs

import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");

const read = (rel) => fs.readFileSync(path.join(APP, rel), "utf8");
const wsl = read("src-tauri/src/wsl.rs");
const sandbox = read("src-tauri/src/sandbox.rs");
const agents = read("ui/src/pages/agentic/AgentsPage.tsx");

let pass = 0, fail = 0;
const fails = [];
const check = (n, c) => { if (c) pass++; else { fail++; fails.push(n); } };
const section = (s) => console.log(`\n${s}`);

/** Body of `fn <name>(` up to the next top-level `\n}` — good enough for these. */
function fnBody(src, name) {
  const i = src.indexOf(`pub fn ${name}(`);
  if (i < 0) return "";
  const end = src.indexOf("\n}", i);
  return end < 0 ? src.slice(i) : src.slice(i, end);
}

section("1) wsl.rs exposes a cached, bounded network probe");
check("NET_DOWN_MARKER constant is defined", /pub const NET_DOWN_MARKER: &str = "OWLLM_SANDBOX_NET_DOWN"/.test(wsl));
check("sandbox_net_ok is public", /pub fn sandbox_net_ok\(distro: &str\) -> bool/.test(wsl));
check("verdicts are cached with a TTL", /NET_OK_TTL/.test(wsl) && /NET_DOWN_TTL/.test(wsl) && /elapsed\(\) < ttl/.test(wsl));
check("a bad verdict expires faster than a good one",
  (() => {
    const ok = /NET_OK_TTL[^=]*=\s*std::time::Duration::from_secs\((\d+)\)/.exec(wsl);
    const down = /NET_DOWN_TTL[^=]*=\s*std::time::Duration::from_secs\((\d+)\)/.exec(wsl);
    return !!ok && !!down && Number(down[1]) < Number(ok[1]);
  })());

section("2) the probe measures TCP reachability, and cannot itself hang");
// Strip comment lines: the rationale prose names the techniques we rejected
// ("a ping-based probe would report false failures"), which would otherwise
// match the assertions below.
const stripComments = (s) => s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\/\/)/.test(l)).join("\n");
const probe = stripComments(
  fnBody(wsl, "sandbox_net_ok") + (wsl.split("fn probe_sandbox_net")[1] || "").slice(0, 900),
);
check("probes with bash /dev/tcp (no curl, no root)", /\/dev\/tcp\//.test(probe));
check("does NOT rely on ping — ICMP is filtered in WSL", !/\bping\b/.test(probe));
check("each attempt is bounded by `timeout`", /timeout \d+ bash -c/.test(probe));
check("succeeds on the first reachable host", /OWLLM_NET_OK/.test(probe));

section("3) every WSL routing path is preflighted (the chokepoint)");
for (const fn of ["program_argv", "program_argv_unjailed"]) {
  const body = fnBody(sandbox, fn);
  check(`${fn} exists`, body.length > 0);
  check(`${fn} calls sandbox_net_ok`, /crate::wsl::sandbox_net_ok\(&distro\)/.test(body));
  check(`${fn} returns net_down_argv when the probe fails`, /if !crate::wsl::sandbox_net_ok\(&distro\) \{\s*return Some\(net_down_argv\(distro\)\);/.test(body));
  // The guard must come BEFORE the CLI argv is assembled, or it is decorative.
  const g = body.indexOf("sandbox_net_ok");
  const e = body.indexOf("exec_script(");
  check(`${fn} preflights before building the CLI argv`, g >= 0 && (e < 0 || g < e));
}

section("4) refusal is fast, non-zero, and self-identifying");
const nd = sandbox.slice(sandbox.indexOf("fn net_down_argv"), sandbox.indexOf("fn net_down_argv") + 1200);
check("net_down_argv exists", sandbox.includes("fn net_down_argv"));
check("emits the marker", /crate::wsl::NET_DOWN_MARKER/.test(nd));
check("writes to stderr", /&gt;&amp;2|>&2/.test(nd));
check("exits non-zero so the run is treated as failed", /exit 78/.test(nd));
check("message says it is not the model/login", /not the model/.test(nd));

section("5) a repair is not blocked by a stale cached verdict");
check("sandbox_net_forget exists", /pub fn sandbox_net_forget\(\)/.test(wsl));
check("wsl_restart clears the cache", /sandbox_net_forget\(\);/.test(fnBody(wsl, "wsl_restart")));

section("6) the UI names the real remedy");
check("isSandboxNetDownError exists", /function isSandboxNetDownError\(/.test(agents));
check("matches the marker", /owllm_sandbox_net_down/.test(agents));
check("still counts as a network error (keeps the recovery button)", /isSandboxNetDownError\(raw\)/.test(agents.slice(agents.indexOf("function isNetworkAgentError"), agents.indexOf("function isSandboxNetDownError"))));
// Bound the slice to THIS branch's own return statement. A longer window runs
// into the generic network branch below, whose wording is deliberately
// different — and would silently satisfy the assertions meant for this one.
const msgStart = agents.indexOf("if (isSandboxNetDownError(raw))");
const msg = agents.slice(msgStart, agents.indexOf('";', agents.indexOf("return \"", msgStart)));
check("dedicated message branch exists", msg.length > 100);
check("mentions mirrored networking, the measured fix", /networkingMode=mirrored/.test(msg));
check("does not claim the restart button is the fix", !/Click .Restart WSL networking. below, then send/.test(msg));

console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
if (fail) console.log(fails.map((f) => `  ✗ ${f}`).join("\n"));
process.exit(fail === 0 ? 0 : 1);

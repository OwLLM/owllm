// A local model that CANNOT run must say so, fast, and must never eat the
// user's message.
//
// THE RUN THIS COMES FROM (project "Web App Test Glimmer", 2026-08-11):
// the user picked meta-models/Muse-Glimmer-30B-GGUF, pressed send, and watched
// nothing happen. Their saved transcript contains exactly one line —
//   "⚡ Loading local model 'muse-glimmer-30B-kquant-17gb' — first send will fire when it's ready."
// — and not one word of what they typed.
//
// Measured cause, by running the exact command the app runs:
//   llama_model_load: error loading model: unknown model architecture: 'muse-glimmer'
//   srv llama_server: exiting due to model loading error
// llama-server was dead 1.0 s after spawn. Three separate defects turned that
// one-second, perfectly diagnosable failure into a silent multi-minute hang:
//
//   1. classify_crash filed "unknown model architecture" under bad_model, whose
//      remedy is "re-download the GGUF" — wrong, and a 17 GB wrong.
//   2. ensureLocalServer polled server_status (which HAD already reaped the
//      child and classified the crash) and threw `message` away, waiting out
//      the full 180 s timeout before printing a content-free "check the Server
//      tab".
//   3. The dock cleared the composer and parked the draft in a ref that is
//      never rendered and was never restored — so every failure path destroyed
//      the user's message.
//
// All three regress SILENTLY: the build is green, the UI looks alive, and the
// user is simply told nothing. So this gate EXECUTES the shipped logic — the
// Rust classifier is compiled and run against the captured log, and the TS
// modules are bundled and called — rather than grepping for their names.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, "../../.."); // owllm-desktop/ui
const TAURI_SRC = path.resolve(UI, "../src-tauri/src");
const FINETUNING = path.join(UI, "src/pages/finetuning");

let passed = 0;
let failed = 0;
// Report EVERY failure. A gate that throws on the first hides how much of the
// invariant is broken — which is the whole point when re-checking old code.
function check(condition, message) {
  if (condition) { passed += 1; console.log(`OK ${message}`); }
  else { failed += 1; console.log(`FAIL ${message}`); }
}

// A platform-gated check must SAY it was skipped. Silently omitting it reads
// as coverage that never ran — the Unix branch is exactly the kind of code
// that regresses because the only builder that could catch it stayed quiet.
let skipped = 0;
function skip(message) {
  skipped += 1;
  console.log(`SKIP ${message}`);
}

const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const stripRustComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const stripTsComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const serverRaw = read(path.join(TAURI_SRC, "server.rs"));
const agentsPage = stripTsComments(read(path.join(HERE, "AgentsPage.tsx")));
const chatPage = stripTsComments(read(path.join(FINETUNING, "ChatPage.tsx")));
const modelsPage = stripTsComments(read(path.join(FINETUNING, "ModelsPage.tsx")));
const picker = stripTsComments(read(path.join(FINETUNING, "widgets/WeightPickerDialog.tsx")));
const store = stripTsComments(read(path.join(FINETUNING, "downloadStore.ts")));

check(serverRaw.length > 0, "server.rs is readable");
check(agentsPage.length > 0, "AgentsPage.tsx is readable");
check(chatPage.length > 0, "finetuning/ChatPage.tsx is readable");
check(modelsPage.length > 0, "finetuning/ModelsPage.tsx is readable");
check(picker.length > 0, "WeightPickerDialog.tsx is readable");

// ---------------------------------------------------------------------------
// 1. The Rust classifier — compiled and RUN against llama-server's real words
// ---------------------------------------------------------------------------
/// Slice a top-level Rust item out by brace matching, so the gate compiles the
/// SHIPPED text rather than a copy that can drift.
function sliceItem(src, header) {
  const at = src.indexOf(header);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return null;
}

const rustWanted = ["fn classify_crash(", "fn fatal_line(", "fn signal_hint_for("];
const rustSlices = rustWanted.map((h) => sliceItem(serverRaw, h));
check(
  rustSlices.every(Boolean),
  "classify_crash + fatal_line + signal_hint_for could be sliced out of server.rs",
);

if (rustSlices.every(Boolean)) {
  // Verbatim stderr from llama-server b3850 refusing the user's model on
  // 2026-08-11, captured by running the exact command server_start builds.
  const REAL_LOG = [
    "0.00.663.988 I srv    load_model: loading model 'C:/Users/mc/AppData/Local/OwLLM Desktop/models/meta-models/Muse-Glimmer-30B-GGUF/muse-glimmer-30B-kquant-17gb.gguf'",
    "0.01.001.884 E llama_model_load: error loading model: unknown model architecture: 'muse-glimmer'",
    "0.01.001.900 E llama_model_load_from_file_impl: failed to load model",
    "0.01.003.678 E srv  llama_server: exiting due to model loading error",
  ].join("\n");
  const OOM_LOG =
    "ggml_vulkan: Device memory allocation of size 18253611008 failed.\n" +
    "0.02.1 E ggml_vulkan: vk::Device::allocateMemory: ErrorOutOfDeviceMemory";
  const CORRUPT_LOG =
    "0.00.1 E gguf_init_from_file: invalid magic characters 'Junk'\n" +
    "0.00.1 E llama_model_load: error loading model: failed to load model";

  const program = [
    "#![allow(dead_code)]",
    rustSlices.join("\n\n"),
    `const REAL: &str = ${JSON.stringify(REAL_LOG)};`,
    `const OOM: &str = ${JSON.stringify(OOM_LOG)};`,
    `const CORRUPT: &str = ${JSON.stringify(CORRUPT_LOG)};`,
    "fn main() {",
    // The defect: an engine too old was reported as a corrupt file, so the
    // remedy shown to the user was "re-download" a perfectly good 17 GB GGUF.
    `  let (kind, msg) = classify_crash(REAL).expect("the real log is classified");`,
    `  assert_eq!(kind, "arch_unsupported", "unsupported arch is NOT a broken file");`,
    `  assert!(msg.contains("NOT corrupt"), "{msg}");`,
    // It must not INSTRUCT a re-download (the bad_model branch's remedy, and a
    // 17 GB waste here); saying re-downloading won't help is the point.
    `  assert!(!msg.contains("Re-download"), "must not tell the user to re-download: {msg}");`,
    `  assert!(msg.contains("re-downloading will not help"), "{msg}");`,
    `  assert!(msg.contains("Local Inference"), "names the module to update: {msg}");`,
    // A genuinely corrupt file must still be told apart from an old engine.
    `  assert_eq!(classify_crash(CORRUPT).expect("corrupt classified").0, "bad_model");`,
    `  assert!(classify_crash(CORRUPT).unwrap().1.contains("Re-download"));`,
    // OOM must not be swallowed by the new branch.
    `  assert_eq!(classify_crash(OOM).expect("oom classified").0, "oom");`,
    // A healthy log stays unclassified — no invented failures.
    `  assert!(classify_crash("main: server is listening on http://127.0.0.1:8080").is_none());`,
    // The user must see llama-server's OWN words, not only our paraphrase.
    `  let line = fatal_line(REAL).expect("a fatal line is quotable");`,
    `  assert!(line.contains("unknown model architecture: 'muse-glimmer'"), "{line}");`,
    `  assert!(!line.starts_with("0.01"), "the log-level prefix is stripped: {line}");`,
    `  assert!(fatal_line("main: server is listening").is_none(), "a healthy log quotes nothing");`,
    // Linux/macOS: a signalled child reports NO exit code, so the signal is the
    // only thing that names the death. Without this branch every Unix crash —
    // including the kernel OOM kill that is the commonest Jetson failure —
    // rendered as a bare "Process ended unexpectedly".
    `  let (k, kh) = signal_hint_for(9).expect("SIGKILL is named");`,
    `  assert!(k.contains("SIGKILL"), "{k}");`,
    `  assert!(kh.contains("out-of-memory"), "the OOM killer is named: {kh}");`,
    `  assert!(kh.contains("dmesg"), "and the user is told how to confirm it: {kh}");`,
    `  assert!(signal_hint_for(11).expect("SIGSEGV").0.contains("SIGSEGV"));`,
    `  assert!(signal_hint_for(7).expect("SIGBUS").0.contains("SIGBUS"));`,
    `  assert!(signal_hint_for(4).expect("SIGILL").0.contains("SIGILL"));`,
    // Never invent a cause for a signal we do not actually know.
    `  assert!(signal_hint_for(31).is_none(), "an unknown signal must not be guessed at");`,
    // The whole point: do not send anyone to re-download a good 17 GB file for
    // a failure that has nothing to do with the file.
    `  for s in [9, 4, 15] {`,
    `    let (_, h) = signal_hint_for(s).expect("named");`,
    `    assert!(!h.to_lowercase().contains("re-download"), "signal {s} blames the file: {h}");`,
    `  }`,
    `  println!("RUST_START_FAILURE_OK");`,
    "}",
  ].join("\n");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-startfail-"));
  const src = path.join(dir, "startfail.rs");
  const exe = path.join(dir, process.platform === "win32" ? "startfail.exe" : "startfail");
  try {
    fs.writeFileSync(src, program, "utf8");
    execFileSync("rustc", ["--edition", "2021", "-A", "warnings", "-o", exe, src], { stdio: "pipe" });
    const out = execFileSync(exe, { encoding: "utf8" });
    check(out.includes("RUST_START_FAILURE_OK"), "the SHIPPED Rust classifier names an unsupported architecture correctly");
  } catch (e) {
    const detail = String(e?.stderr ?? e?.message ?? e).split("\n").slice(0, 14).join("\n");
    check(false, `the shipped Rust crash classifier failed its behavioural check:\n${detail}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

// ---------------------------------------------------------------------------
// 1b. Linux/macOS ONLY: the `#[cfg(unix)]` half, compiled and RUN for real.
// ---------------------------------------------------------------------------
// Windows never compiles `exit_signal`'s Unix body, so a Windows-green gate
// says nothing about it. On a Unix builder we kill a real child with a real
// SIGKILL and assert the exact thing the crash path depends on: a signalled
// child has NO exit code, and the signal alone must name the death.
if (process.platform !== "win32" && rustSlices.every(Boolean)) {
  const unixSrc = [
    "#![allow(dead_code)]",
    sliceItem(serverRaw, "fn signal_hint_for("),
    // Verbatim from server.rs, minus the cfg attribute rustc would strip anyway.
    "fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {",
    "    use std::os::unix::process::ExitStatusExt;",
    "    status.signal()",
    "}",
    "fn main() {",
    `  let mut c = std::process::Command::new("sleep").arg("30").spawn().expect("spawn sleep");`,
    `  unsafe { libc_kill(c.id() as i32, 9); }`,
    `  let st = c.wait().expect("wait");`,
    // THE invariant: on Unix there is no exit code to reason about.
    `  assert!(st.code().is_none(), "a signalled child must report no exit code");`,
    `  let sig = exit_signal(&st).expect("the signal is readable");`,
    `  assert_eq!(sig, 9, "we sent SIGKILL");`,
    `  let (name, hint) = signal_hint_for(sig).expect("SIGKILL is named on this platform");`,
    `  assert!(name.contains("SIGKILL"), "{name}");`,
    `  assert!(hint.contains("out-of-memory"), "{hint}");`,
    `  println!("RUST_UNIX_SIGNAL_OK");`,
    "}",
    `extern "C" { #[link_name = "kill"] fn libc_kill(pid: i32, sig: i32) -> i32; }`,
  ].join("\n");
  const udir = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-unixsig-"));
  const usrc = path.join(udir, "unixsig.rs");
  const uexe = path.join(udir, "unixsig");
  try {
    fs.writeFileSync(usrc, unixSrc, "utf8");
    execFileSync("rustc", ["--edition", "2021", "-A", "warnings", "-o", uexe, usrc], { stdio: "pipe" });
    const out = execFileSync(uexe, { encoding: "utf8" });
    check(
      out.includes("RUST_UNIX_SIGNAL_OK"),
      "on Unix, a REAL SIGKILL is read off the child and named (no exit code exists)",
    );
  } catch (e) {
    const detail = String(e?.stderr ?? e?.message ?? e).split("\n").slice(0, 14).join("\n");
    check(false, `the Unix signal path failed its live check:\n${detail}`);
  } finally {
    try { fs.rmSync(udir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
} else if (process.platform === "win32") {
  skip("the Unix signal path (this is Windows — run this gate on a Linux/macOS builder)");
}

// server_status must actually USE both — a classifier nobody calls protects nothing.
const serverCode = stripRustComments(serverRaw);
check(
  /fatal_line\(&tail_text\)/.test(serverCode),
  "server_status quotes the engine's own fatal line into the status message",
);
check(
  /classify_crash\(&tail_text\)/.test(serverCode),
  "server_status still classifies the crash from the stderr tail",
);
// The Unix half must be WIRED, not merely present: read the signal off the
// dead child, and consult it on the no-exit-code branch. A hint function
// nobody calls protects nobody on Linux.
check(
  /exit_signal\(&status\)/.test(serverCode),
  "server_status reads the terminating signal off the dead child (Unix has no exit code then)",
);
check(
  /term_signal\.and_then\(signal_hint_for\)/.test(serverCode),
  "the no-exit-code branch names the signal instead of shrugging",
);
// Every death path must quote what llama-server itself printed — the Unix and
// unknown-code branches used to drop it, which is how a diagnosable failure
// reached the user as "Check the log for details".
for (const [branch, re] of [
  ["unknown exit code", /Crashed \(exit code \{code\}\)\.\{quoted\}/],
  ["signal death", /Killed by \{name\}\.\{quoted\}/],
  ["unexplained death", /Process ended unexpectedly\.\{quoted\}/],
]) {
  check(re.test(serverCode), `the ${branch} branch quotes llama-server's own words`);
}

// ---------------------------------------------------------------------------
// 2. The UI stops waiting on a corpse (behaviour, executed)
// ---------------------------------------------------------------------------
// A missing/broken export must be REPORTED as failed checks, never crash the
// gate — a crashing verifier reads as "the suite is broken", not "the code is".
async function loadModule(entry) {
  try {
    const bundled = await esbuild.build({
      entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "neutral",
    });
    return await import(
      `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
    );
  } catch (e) {
    console.log(`(${path.basename(entry)} could not be loaded: ${e?.message ?? e})`);
    return null;
  }
}

const failMod = await loadModule(path.join(HERE, "localServerFailure.ts"));
const hasReason = typeof failMod?.startupFailureReason === "function";
const hasText = typeof failMod?.localStartFailureText === "function";
check(hasReason, "localServerFailure exports startupFailureReason");
check(hasText, "localServerFailure exports localStartFailureText");

if (hasReason) {
  const { startupFailureReason } = failMod;
  // The message server_status produces for the user's actual crash.
  const CRASHED =
    "Crashed (exit code 1). llama-server said: \"llama_model_load: error loading model: " +
    "unknown model architecture: 'muse-glimmer'\". This model's architecture is not supported " +
    "by the installed inference engine — the file is NOT corrupt and re-downloading will not help.";
  const dead = startupFailureReason(
    { running: false, model_id: "muse-glimmer-30B-kquant-17gb", port: null, message: CRASHED },
    "muse-glimmer-30B-kquant-17gb",
  );
  check(typeof dead === "string", "a dead engine is a TERMINAL result — stop waiting immediately");
  check(/muse-glimmer/.test(dead ?? ""), "the reported reason carries the engine's own diagnosis through");
  check(/NOT corrupt/.test(dead ?? ""), "the remedy survives to the caller unparaphrased");

  // Still loading is NOT a failure — this is the false positive that would
  // break every cold start of a large model.
  check(
    startupFailureReason(
      { running: true, model_id: "big-model", port: 10500, message: "Starting on http://127.0.0.1:10500" },
      "big-model",
    ) === null,
    "a model still loading is NOT reported as failed",
  );
  // Dead but silent: we say we don't know rather than inventing a cause.
  const silent = startupFailureReason({ running: false, message: "" }, "x");
  check(typeof silent === "string", "a dead engine with no message still stops the wait");
  check(/did not report why/.test(silent ?? ""), "an unexplained death is admitted, not invented");
  check(
    !/^Not running\.?$/i.test(startupFailureReason({ running: false, message: "Not running." }, "x") ?? ""),
    "the content-free 'Not running.' is never shown as the reason",
  );
}

if (hasText) {
  const { localStartFailureText } = failMod;
  check(
    localStartFailureText("m", "Crashed. The engine is too old.").includes("The engine is too old."),
    "the user-facing line contains the real reason",
  );
  check(
    /Server tab/.test(localStartFailureText("m", null)),
    "with no reason at all we point at the log instead of claiming one",
  );
}

// The wait loop must actually consult it, in BOTH local-model surfaces.
check(
  /const reason = startupFailureReason\(s, wanted\)/.test(agentsPage),
  "AgentsPage's ensureLocalServer poll asks whether the engine is already dead",
);
check(
  /if \(reason\) \{[\s\S]{0,220}?return false;/.test(agentsPage),
  "…and returns immediately instead of waiting out the timeout",
);
check(
  /startupFailureReason\(s, wantedModelId\)/.test(chatPage),
  "the fine-tuning chat's 180s retry loop makes the same check (the second local-model surface)",
);
check(
  (agentsPage.match(/localStartFailureText\(/g) ?? []).length >= 3,
  "every AgentsPage local-start failure site reports the real reason, not a generic sentence",
);
check(
  !/check the Server tab and retry/.test(agentsPage),
  "the old content-free 'check the Server tab and retry' string is gone",
);
check(
  !/failed to start for "\$\{wantedLocal\}" within 90s/.test(agentsPage),
  "the old 'within 90s' message is gone — we no longer wait 90s to say nothing",
);

// ---------------------------------------------------------------------------
// 3. The user's message is never destroyed
// ---------------------------------------------------------------------------
check(
  /const restoreParkedDraft = \(\) => \{/.test(agentsPage),
  "there is a named path that gives a parked draft back to the composer",
);
check(
  /owllm:dock:restore-draft/.test(agentsPage),
  "the restore travels on its own event, mirroring owllm:dock:park-draft",
);
check(
  (agentsPage.match(/owllm:dock:restore-draft/g) ?? []).length >= 2,
  "…and something actually LISTENS for it (a dispatch with no listener is a no-op)",
);
// The single-point invariant: restoring in `finally` is what makes it
// impossible for a future early-return to reintroduce the data loss.
const dockLoad = agentsPage.slice(agentsPage.indexOf("const dockLoadModel = async () =>"));
const finallyAt = dockLoad.indexOf("} finally {");
check(finallyAt > 0, "dockLoadModel has a finally block");
check(
  finallyAt > 0 && /restoreParkedDraft\(\);/.test(dockLoad.slice(finallyAt, finallyAt + 400)),
  "the draft is restored in finally — so crash, abort, timeout and throw are ALL covered",
);
check(
  /if \(draftRef\.current\.trim\(\)\) return;/.test(agentsPage),
  "restoring never clobbers something the user typed in the meantime",
);

// ---------------------------------------------------------------------------
// 4. The download picker explains what each file IS (behaviour, executed)
// ---------------------------------------------------------------------------
const rolesMod = await loadModule(path.join(FINETUNING, "weightRoles.ts"));
const hasRole = typeof rolesMod?.weightRole === "function";
const hasProblem = typeof rolesMod?.selectionProblem === "function";
check(hasRole, "weightRoles exports weightRole");
check(hasProblem, "weightRoles exports selectionProblem");

if (hasRole) {
  const { weightRole } = rolesMod;
  // The exact four files the user was shown, as four equal-looking rows.
  check(weightRole("muse-glimmer-30B-kquant-17gb.gguf") === "primary", "the main weights are classified as weights");
  check(weightRole("muse-glimmer-30B-kquant-dynamic.gguf") === "primary", "the other size is also weights");
  check(weightRole("mmproj-kquant.gguf") === "projector", "mmproj is recognised as the vision projector");
  check(weightRole("dflash-kquant.gguf") === "draft", "dflash is recognised as a draft model");
  check(weightRole("model-Q4_K_M-lora-x.gguf") === "adapter", "a LoRA is recognised as an adapter");
}
if (hasProblem) {
  const { selectionProblem } = rolesMod;
  // The trap: tick only companions, download 1.3 GB, then nothing loads.
  const only = selectionProblem(["mmproj-kquant.gguf"]);
  check(typeof only === "string", "a companion-only selection is REFUSED");
  check(/cannot be loaded/.test(only ?? ""), "…and the refusal says why, in plain words");
  check(
    selectionProblem(["muse-glimmer-30B-kquant-17gb.gguf", "mmproj-kquant.gguf"]) === null,
    "weights + companion is a fine selection",
  );
  check(typeof selectionProblem([]) === "string", "an empty selection is still refused");
}
if (typeof rolesMod?.autoIncludedNote === "function") {
  const note = rolesMod.autoIncludedNote(
    ["muse-glimmer-30B-kquant-17gb.gguf", "mmproj-kquant.gguf"],
    ["muse-glimmer-30B-kquant-17gb.gguf"],
  );
  check(/automatically/.test(note ?? ""), "the picker can say the projector is fetched for you");
} else {
  check(false, "weightRoles exports autoIncludedNote");
}

check(/selectionProblem\(\[\.\.\.picked\]\)/.test(picker), "the dialog enforces the rule on submit");
check(
  /COMPANION FILES/.test(picker),
  "companions are visually separated from the runnable weights",
);
check(
  /const \[loadError, setLoadError\]/.test(picker),
  "a complaint about the SELECTION no longer erases the file list needed to fix it",
);

// ---------------------------------------------------------------------------
// 5. A failed download has a way forward
// ---------------------------------------------------------------------------
check(/export function dismiss\(/.test(store), "downloadStore can dismiss a stuck row");
check(/export async function retry\(/.test(store), "downloadStore can retry a failed download");
check(/remaining\?: string\[\]/.test(store), "the row remembers what is still owed, so retry resumes the QUEUE");
check(/downloadStore\.retry\(id\)/.test(modelsPage), "the error banner offers Retry");
check(/downloadStore\.dismiss\(id\)/.test(modelsPage), "the error banner offers Dismiss");
check(
  /Nothing left to resume/.test(modelsPage),
  "Resume with no partial on disk SAYS so instead of silently reopening the picker",
);
check(
  /downloadStore\.isActive\(hfId\)/.test(modelsPage),
  "pressing Resume on an already-running download explains itself rather than doing nothing",
);

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
if (failed > 0) process.exit(1);
